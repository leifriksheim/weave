import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as json from 'sugar-high/lang/json';
import { useNode, useProfiles } from 'weave-protocol/react';
import type { NodeCollection, NodeRecord, Query, QueryRecord, QueryResult, SpaceSummary } from 'weave-protocol';
import { collectionLabel, fieldsOf, recordLabel, titleField } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '../derive/time';
import { styles, palette } from '../styles';

/**
 * A place to try the query language on this space's own data.
 *
 * A query is plain JSON, so the editor is just text: it runs a moment after
 * you stop typing, and again whenever the space changes. The examples are
 * built from the collections actually here, so every one of them finds
 * something real.
 */

const DEBOUNCE = 250;

interface Example {
  readonly label: string;
  readonly query: Query;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The first collections worth showing: your own kinds of things before the shared ones, busiest first */
function ownCollections(collections: ReadonlyArray<NodeCollection>): NodeCollection[] {
  const visible = collections.filter((c) => !c.name.startsWith('sys.'));
  const own = visible.filter((c) => !c.name.startsWith('std.'));
  return [...(own.length ? own : visible)].sort((a, b) => b.records - a.records);
}

/** Example queries built from what this space really holds */
function examplesFor(collections: ReadonlyArray<NodeCollection>, me: string): Example[] {
  const ranked = ownCollections(collections);
  const first = ranked[0];
  if (!first) return [];
  const name = (c: NodeCollection) => collectionLabel(c).toLowerCase();
  const out: Example[] = [{ label: `All ${name(first)}`, query: { collection: first.name } }];

  out.push({ label: `Newest 10 ${name(first)}`, query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 10 } });

  // A filter on a real field: a yes/no one if there is one, else fixed choices, a number, or text.
  let filtered = false;
  for (const c of ranked) {
    const fields = fieldsOf(c.schema);
    const yesNo = fields.find((f) => f.kind === 'boolean');
    if (yesNo) {
      out.push({ label: `${collectionLabel(c)} where ${yesNo.label.toLowerCase()} is yes`, query: { collection: c.name, where: { [yesNo.name]: true } } });
      filtered = true;
      break;
    }
    const choice = fields.find((f) => Array.isArray(f.schema.enum) && f.schema.enum.length > 1);
    if (choice) {
      const options = (choice.schema.enum as unknown[]).slice(0, 2);
      out.push({ label: `${collectionLabel(c)} by ${choice.label.toLowerCase()}`, query: { collection: c.name, where: { [choice.name]: { $in: options } } } });
      filtered = true;
      break;
    }
  }
  if (!filtered) {
    const c = ranked.find((c) => titleField(c.schema));
    const title = c && titleField(c.schema);
    if (c && title) out.push({ label: `${collectionLabel(c)} with "a" in the ${title}`, query: { collection: c.name, where: { [title]: { $contains: 'a' } } } });
  }

  out.push({ label: 'Written by me', query: { collection: first.name, where: { '@createdBy': me }, sort: { '@updatedAt': 'desc' } } });

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  out.push({ label: 'Added this week', query: { collection: first.name, where: { '@createdAt': { $gte: weekAgo } } } });

  // Whatever declares a link that may point at the first collection.
  const pointers = collections.flatMap((c) =>
    Object.entries(c.links)
      .filter(([, link]) => link.to === '*' || link.to.includes(first.name))
      .map(([rel]) => ({ from: c.name, rel, as: (c.name.split('.').pop() ?? c.name) + 's' })),
  );
  if (pointers.length) {
    out.push({
      label: 'With what points at them',
      query: {
        collection: first.name,
        include: Object.fromEntries(pointers.slice(0, 3).map((p) => [p.as, { rel: p.rel, from: p.from, limit: 5 }])),
      },
    });
  }

  if (collections.some((c) => c.name === 'std.comment')) {
    out.push({
      label: 'Count comments',
      query: { collection: first.name, include: { comments: { rel: 'about', from: 'std.comment', count: true } } },
    });
  }

  out.push({ label: 'Five at a time', query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 5 } });
  return out;
}

/** "Unexpected token } in JSON at position 42" → where that is, as a line and column */
function jsonProblem(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = /position (\d+)/.exec(message);
  let where = '';
  if (at && !/\(line \d+/.test(message)) {
    const before = text.slice(0, Number(at[1]));
    const lines = before.split('\n');
    where = ` (line ${lines.length}, column ${(lines[lines.length - 1]?.length ?? 0) + 1})`;
  }
  return `${message.replace(/^JSON\.parse: /, '')}${where}`;
}

type Parsed = { ok: true; query: Query; text: string } | { ok: false; problem: string } | null;

export function QueryPlayground({ space, collections, onOpen }: { space: SpaceSummary; collections: ReadonlyArray<NodeCollection>; onOpen: (record: NodeRecord) => void }): JSX.Element {
  const node = useNode();
  const people = peopleFrom(useProfiles(space.id));
  const examples = useMemo(() => examplesFor(collections, node.did), [collections, node.did]);
  const schemas = useMemo(() => new Map(collections.map((c) => [c.name, c])), [collections]);

  const [text, setText] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [raw, setRaw] = useState(false);

  // Start from the first example, once there is one — and never overwrite what you typed.
  useEffect(() => {
    if (text === null && examples[0]) setText(pretty(examples[0].query));
  }, [text, examples]);

  // Parse a moment after typing stops.
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => {
      if (!text.trim()) return setParsed({ ok: false, problem: 'The editor is empty. Pick an example above, or write a query.' });
      try {
        const query = JSON.parse(text) as Query;
        setParsed({ ok: true, query, text: JSON.stringify(query) });
      } catch (error) {
        setParsed({ ok: false, problem: jsonProblem(text, error) });
      }
    }, DEBOUNCE);
    return () => clearTimeout(timer);
  }, [text]);

  // Run it, and again whenever the space's records change.
  const runKey = parsed?.ok ? parsed.text : null;
  useEffect(() => {
    if (!parsed?.ok) return;
    setRunning(true);
    return node.records.watch(
      space.id,
      parsed.query,
      (next) => {
        setResult(next);
        setQueryError(null);
        setRunning(false);
      },
      (error) => {
        setQueryError(error.message.replace(/^Invalid query: /, ''));
        setRunning(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, space.id, runKey]);

  /** Changes one top-level part of the query in the editor: the next page, or back to the first */
  const setCursor = (cursor: string | null) => {
    if (!parsed?.ok) return;
    const { cursor: _old, ...rest } = parsed.query;
    setText(pretty(cursor ? { ...rest, cursor } : rest));
  };

  const jsonError = parsed && !parsed.ok ? parsed.problem : null;
  const stale = Boolean(jsonError || queryError);
  const records = result?.records ?? [];

  if (examples.length === 0 && text === null) {
    return (
      <section aria-label="Try a query" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Header />
        <p style={styles.emptyState}>Nothing here to look through yet. Add something to this space first.</p>
      </section>
    );
  }

  return (
    <section aria-label="Try a query" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Header />

      <div role="group" aria-label="Examples" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {examples.map((example) => {
          const current = text !== null && text === pretty(example.query);
          return (
            <button
              key={example.label}
              onClick={() => setText(pretty(example.query))}
              data-variant={current ? undefined : 'quiet'}
              aria-pressed={current}
              style={current ? { ...chipStyle, backgroundColor: palette.accent.base, color: '#fff', borderColor: palette.accent.base } : chipStyle}
            >
              {example.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <label htmlFor="query-editor" style={styles.fieldLabel}>
            Your query
          </label>
          <Editor value={text ?? ''} onChange={setText} />
          {jsonError && (
            <Problem title="This isn't valid JSON yet">
              {jsonError}. Check for a missing comma, a missing quote around a name, or a comma after the last item.
            </Problem>
          )}
          {!jsonError && queryError && <Problem title="The query can't run">{queryError}</Problem>}
          <Cheatsheet />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, opacity: stale ? 0.5 : 1, transition: 'opacity .15s ease' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 20 }}>
            <span style={styles.fieldLabel}>
              {result ? `${records.length} found${result.cursor ? ', and more after these' : ''}` : 'Results'}
              {running && <span style={{ color: palette.ink.faint, fontWeight: 400 }}> · running…</span>}
              {stale && result && <span style={{ color: palette.ink.faint, fontWeight: 400 }}> · from the last query that worked</span>}
            </span>
            <div role="tablist" aria-label="Show results as" style={{ ...styles.segmented, padding: 2 }}>
              {(['Table', 'JSON'] as const).map((mode) => {
                const on = (mode === 'JSON') === raw;
                return (
                  <button key={mode} role="tab" aria-selected={on} onClick={() => setRaw(mode === 'JSON')} style={{ ...(on ? styles.segmentActive : styles.segment), padding: '3px 10px', fontSize: 12 }}>
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>

          {result && records.length === 0 && <p style={styles.emptyState}>Nothing matches this query.</p>}
          {result && records.length > 0 && !raw && (
            <ResultTable
              records={records}
              label={(r) => recordLabel(r, schemas.get(r.collection)?.schema ?? null)}
              collection={(name) => {
                const c = schemas.get(name);
                return c ? collectionLabel(c) : name;
              }}
              author={(r) => nameOf(r.createdBy ?? r.root, people)}
              onOpen={onOpen}
            />
          )}
          {result && raw && <Highlighted code={pretty(result)} style={{ maxHeight: 520 }} />}

          {parsed?.ok && (result?.cursor || parsed.query.cursor) && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {parsed.query.cursor && (
                <button onClick={() => setCursor(null)} data-variant="quiet" style={styles.smallButton}>
                  Back to the first page
                </button>
              )}
              {result?.cursor && (
                <button onClick={() => setCursor(result.cursor)} data-variant="quiet" style={styles.smallButton}>
                  Next page →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Header() {
  return (
    <header>
      <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Try a query</h2>
      <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 4, lineHeight: 1.6 }}>
        Ask this space for exactly the things you want, written as plain JSON. It runs as you type, on the data on this device, and nothing you do here changes anything.
      </p>
    </header>
  );
}

// ─── Editor ────────────────────────────────────────────────────────

/** Colours for sugar-high, in the app's greys: names and values read first, punctuation fades back */
const syntax = {
  '--sh-keyword': palette.ink.strong,
  '--sh-class': palette.ink.strong,
  '--sh-entity': palette.ink.strong,
  '--sh-identifier': palette.ink.body,
  '--sh-property': palette.ink.strong,
  '--sh-string': '#1a7f37',
  '--sh-jsxliterals': palette.ink.body,
  '--sh-sign': palette.ink.faint,
  '--sh-comment': palette.ink.faint,
  '--sh-break': palette.ink.body,
  '--sh-space': palette.ink.body,
} as CSSProperties;

const codeText: CSSProperties = {
  fontFamily: palette.mono,
  fontSize: 12.5,
  lineHeight: 1.65,
  padding: '12px 14px',
  whiteSpace: 'pre',
  tabSize: 2,
  letterSpacing: 0,
};

const highlight = (code: string) => render(parse(code, { ...json }));

/** A textarea with the highlighted text drawn exactly underneath it */
function Editor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const under = useRef<HTMLPreElement>(null);
  const html = useMemo(() => highlight(value), [value]);

  // Tab indents rather than leaving the editor.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = el;
    onChange(value.slice(0, start) + '  ' + value.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
  };

  return (
    <div style={{ position: 'relative', borderRadius: palette.radius.lg, backgroundColor: palette.surface.sunken }}>
      <pre
        ref={under}
        aria-hidden
        style={{ ...codeText, ...syntax, position: 'absolute', inset: 0, margin: 0, overflow: 'hidden', pointerEvents: 'none', border: '1px solid transparent' }}
        dangerouslySetInnerHTML={{ __html: `${html}\n ` }}
      />
      <textarea
        id="query-editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (!under.current) return;
          under.current.scrollTop = e.currentTarget.scrollTop;
          under.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        style={{
          ...codeText,
          position: 'relative',
          display: 'block',
          width: '100%',
          minHeight: 320,
          resize: 'vertical',
          margin: 0,
          border: `1px solid ${palette.surface.line}`,
          borderRadius: palette.radius.lg,
          background: 'transparent',
          color: 'transparent',
          caretColor: palette.ink.strong,
          overflow: 'auto',
        }}
      />
    </div>
  );
}

/** Read-only highlighted JSON */
function Highlighted({ code, style }: { code: string; style?: CSSProperties }) {
  const html = useMemo(() => highlight(code), [code]);
  return (
    <pre
      style={{
        ...codeText,
        ...syntax,
        margin: 0,
        overflow: 'auto',
        border: `1px solid ${palette.surface.line}`,
        borderRadius: palette.radius.lg,
        backgroundColor: palette.surface.sunken,
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" style={{ ...styles.errorBox, marginTop: 0, padding: '10px 14px' }}>
      <p style={{ ...styles.error, fontSize: 13 }}>{title}</p>
      <p style={{ ...styles.errorHint, marginTop: 4, fontSize: 12.5, wordBreak: 'break-word' }}>{children}</p>
    </div>
  );
}

// ─── Results ───────────────────────────────────────────────────────

function ResultTable({
  records,
  label,
  collection,
  author,
  onOpen,
}: {
  records: ReadonlyArray<QueryRecord>;
  label: (r: QueryRecord) => string;
  collection: (name: string) => string;
  author: (r: QueryRecord) => string;
  onOpen: (record: NodeRecord) => void;
}) {
  const anyIncluded = records.some((r) => r.included && Object.keys(r.included).length > 0);
  return (
    <div style={{ border: `1px solid ${palette.surface.line}`, borderRadius: 12, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={th}>What</th>
            <th style={th}>Kind</th>
            <th style={th}>By</th>
            <th style={th}>Added</th>
            {anyIncluded && <th style={th}>Pulled in</th>}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.key}
              tabIndex={0}
              onClick={() => onOpen(record)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(record);
              }}
              style={{ cursor: 'pointer' }}
              aria-label={`Open ${label(record)}`}
            >
              <td style={{ ...td, color: palette.ink.strong, fontWeight: 500, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label(record)}</td>
              <td style={{ ...td, color: palette.ink.muted }}>{collection(record.collection)}</td>
              <td style={{ ...td, color: palette.ink.muted }}>{author(record)}</td>
              <td style={{ ...td, color: palette.ink.muted }} title={record.createdAt}>
                {ago(record.createdAt)}
              </td>
              {anyIncluded && (
                <td style={{ ...td, color: palette.ink.muted }}>
                  <Included record={record} label={label} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What an `include` found, in a few words: "3 comments · reactions: 👍, 🎉" */
function Included({ record, label }: { record: QueryRecord; label: (r: QueryRecord) => string }) {
  const entries = Object.entries(record.included ?? {});
  if (entries.length === 0) return <span style={{ color: palette.ink.faint }}>—</span>;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {entries.map(([name, found]) => {
        if (typeof found === 'number') {
          return (
            <span key={name}>
              <span style={{ color: palette.ink.faint }}>{name}</span> {found}
            </span>
          );
        }
        const shown = found.slice(0, 3).map(label).join(', ');
        return (
          <span key={name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
            <span style={{ color: palette.ink.faint }}>{name}</span> {found.length}
            {found.length > 0 && `: ${shown}${found.length > 3 ? '…' : ''}`}
          </span>
        );
      })}
    </span>
  );
}

// ─── How queries work ──────────────────────────────────────────────

/** Everything the query language supports, from query/types.ts and query/filter.ts — nothing more */
function Cheatsheet() {
  const row = (code: string, words: string) => (
    <li key={code} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <code style={{ fontSize: 12, color: palette.ink.strong, minWidth: 96, flexShrink: 0 }}>{code}</code>
      <span>{words}</span>
    </li>
  );
  const list: CSSProperties = { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 };
  const heading: CSSProperties = { fontSize: 12, fontWeight: 600, color: palette.ink.body, marginTop: 6 };
  return (
    <details style={{ ...styles.panel, marginTop: 4 }}>
      <summary style={{ ...styles.panelSummary, fontSize: 13 }}>How queries work</summary>
      <div style={{ ...styles.panelBody, fontSize: 12.5 }}>
        <p>A query is one JSON object. Only “collection” is required; everything else narrows or shapes what comes back.</p>

        <p style={heading}>The parts</p>
        <ul style={list}>
          {row('collection', 'Which kind of thing to look through, by its name. One per query.')}
          {row('where', 'Which ones to keep. Every condition must hold.')}
          {row('sort', '{ "field": "asc" or "desc" }. Several fields sort in order. Without it: oldest first.')}
          {row('limit', 'At most this many.')}
          {row('cursor', 'Where the next page starts. Use “Next page” below the results.')}
          {row('include', 'Also bring back records linked to each one — see below.')}
        </ul>

        <p style={heading}>Conditions in “where”</p>
        <p>
          <code>{'{ "done": true }'}</code> means the field equals that value. A dotted name like <code>address.city</code> looks inside. For anything else, use an operator:
        </p>
        <ul style={list}>
          {row('$eq  $ne', 'Equal to, not equal to. $ne also keeps records without the field.')}
          {row('$gt  $gte', 'More than, at least. Numbers with numbers, text with text.')}
          {row('$lt  $lte', 'Less than, at most.')}
          {row('$in  $nin', 'One of a list of values, or none of them.')}
          {row('$exists', 'true: the field is there. false: it is missing.')}
          {row('$contains', 'Text that contains this, ignoring capitals — or a list holding this item.')}
          {row('$and  $or', 'A list of conditions: all of them, or any of them.')}
          {row('$not', 'A condition that must not hold.')}
        </ul>

        <p style={heading}>Fields about the record itself</p>
        <ul style={list}>
          {row('@key', 'The record’s id.')}
          {row('@collection', 'The kind of thing it is.')}
          {row('@createdBy', 'The account that first made it.')}
          {row('@root', 'The account behind this version.')}
          {row('@author', 'The device key that signed this version — not the account.')}
          {row('@createdAt', 'When it was made, as text like "2026-09-24T10:00:00Z" — compare with $gte.')}
          {row('@updatedAt', 'When this version was written.')}
          {row('@seq', 'How many times it has been edited: 0 for never.')}
        </ul>

        <p style={heading}>Following links with “include”</p>
        <p>Give each include a name you choose. It comes back on every record under that name.</p>
        <ul style={list}>
          {row('rel', 'The kind of link to follow, like "about". Required.')}
          {row('from', 'Only records of this kind.')}
          {row('direction', '"in" (the default): things pointing at this record. "out": things it points at.')}
          {row('where', 'Only linked records matching these conditions.')}
          {row('limit', 'At most this many.')}
          {row('count', 'true: just how many, not the records.')}
          {row('include', 'Follow links again from those — up to 3 levels deep.')}
        </ul>
      </div>
    </details>
  );
}

// ─── Styles ────────────────────────────────────────────────────────

const chipStyle: CSSProperties = {
  height: 28,
  padding: '0 11px',
  borderRadius: palette.radius.pill,
  border: `1px solid ${palette.surface.line}`,
  backgroundColor: palette.surface.card,
  color: palette.ink.body,
  fontSize: 12.5,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const th: CSSProperties = {
  textAlign: 'left',
  fontSize: 12,
  fontWeight: 500,
  color: palette.ink.muted,
  padding: '9px 12px',
  borderBottom: `1px solid ${palette.surface.line}`,
  whiteSpace: 'nowrap',
  backgroundColor: palette.surface.sunken,
};

const td: CSSProperties = {
  padding: '9px 12px',
  borderBottom: `1px solid ${palette.surface.line}`,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};
