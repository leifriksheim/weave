import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { parse, render } from 'sugar-high/core';
import * as json from 'sugar-high/lang/json';
import { useNode, useProfiles } from '@weaveprotocol/core/react';
import type {
  NodeCollection,
  NodeRecord,
  Query,
  QueryRecord,
  QueryResult,
  SpaceSummary,
} from '@weaveprotocol/core';
import { collectionLabel, fieldsOf, recordLabel, titleField } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { ago } from '../derive/time';
import { message as messageOf } from '@weave/app-shared/action';
import { styles, palette, ui } from '../styles';
import { DocsNote } from './DocsNote';

// Try the query language on this space's own data, with examples built from its real collections.

const DEBOUNCE = 250;

interface Example {
  readonly label: string;
  readonly query: Query;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The first collections worth showing: your own collections before the shared ones, busiest first */
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

  out.push({
    label: `Newest 10 ${name(first)}`,
    query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 10 },
  });

  // A filter on a real field: a yes/no one if there is one, else fixed choices, a number, or text.
  let filtered = false;
  for (const c of ranked) {
    const fields = fieldsOf(c.schema);
    const yesNo = fields.find((f) => f.kind === 'boolean');
    if (yesNo) {
      out.push({
        label: `${collectionLabel(c)} where ${yesNo.label.toLowerCase()} is yes`,
        query: { collection: c.name, where: { [yesNo.name]: true } },
      });
      filtered = true;
      break;
    }
    const choice = fields.find((f) => Array.isArray(f.schema.enum) && f.schema.enum.length > 1);
    if (choice) {
      const options: unknown[] = Array.isArray(choice.schema.enum) ? choice.schema.enum.slice(0, 2) : [];
      out.push({
        label: `${collectionLabel(c)} by ${choice.label.toLowerCase()}`,
        query: { collection: c.name, where: { [choice.name]: { $in: options } } },
      });
      filtered = true;
      break;
    }
  }
  if (!filtered) {
    const c = ranked.find((c) => titleField(c.schema));
    const title = c && titleField(c.schema);
    if (c && title)
      out.push({
        label: `${collectionLabel(c)} with "a" in the ${title}`,
        query: { collection: c.name, where: { [title]: { $contains: 'a' } } },
      });
  }

  out.push({
    label: 'Written by me',
    query: { collection: first.name, where: { '@createdBy': me }, sort: { '@updatedAt': 'desc' } },
  });

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  out.push({
    label: 'Added this week',
    query: { collection: first.name, where: { '@createdAt': { $gte: weekAgo } } },
  });

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
        include: Object.fromEntries(
          pointers.slice(0, 3).map((p) => [p.as, { rel: p.rel, from: p.from, limit: 5 }]),
        ),
      },
    });
  }

  if (collections.some((c) => c.name === 'std.comment')) {
    out.push({
      label: 'Count comments',
      query: {
        collection: first.name,
        include: { comments: { rel: 'about', from: 'std.comment', count: true } },
      },
    });
  }

  out.push({
    label: 'Five at a time',
    query: { collection: first.name, sort: { '@createdAt': 'desc' }, limit: 5 },
  });
  return out;
}

/** "Unexpected token } in JSON at position 42" → where that is, as a line and column */
function jsonProblem(text: string, error: unknown): string {
  const message = messageOf(error);
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

export function QueryPlayground({
  space,
  collections,
  onOpen,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
}): JSX.Element {
  const node = useNode();
  const people = peopleFrom(useProfiles(space.id));
  const examples = useMemo(() => examplesFor(collections, node.did), [collections, node.did]);
  const schemas = useMemo(() => new Map(collections.map((c) => [c.name, c])), [collections]);

  const [text, setText] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  // Which query, in which space, has answered at least once; until it has, it is still running.
  const [ranFor, setRanFor] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  // Start from the first example, once there is one — and never overwrite what you typed.
  if (text === null && examples[0]) setText(pretty(examples[0].query));

  // Parse a moment after typing stops.
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => {
      if (!text.trim())
        return setParsed({
          ok: false,
          problem: 'The editor is empty. Pick an example above, or write a query.',
        });
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the node checks the query itself (checkQuery) and says what is wrong, shown as the query's error
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
  const running = runKey !== null && ranFor !== `${space.id}\n${runKey}`;
  useEffect(() => {
    if (!parsed?.ok) return;
    const key = `${space.id}\n${parsed.text}`;
    return node.records.watch(
      space.id,
      parsed.query,
      (next) => {
        setResult(next);
        setQueryError(null);
        setRanFor(key);
      },
      (error) => {
        setQueryError(error.message.replace(/^Invalid query: /, ''));
        setRanFor(key);
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
    <section
      aria-label="Try a query"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
    >
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
              style={{ ...ui.chip, padding: '0 11px', ...(current && ui.chipOn) }}
            >
              {example.label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <label htmlFor="query-editor" style={styles.fieldLabel}>
            Your query
          </label>
          <Editor value={text ?? ''} onChange={setText} />
          {jsonError && (
            <Problem title="This isn't valid JSON yet">
              {jsonError}. Check for a missing comma, a missing quote around a name, or a comma after the last
              item.
            </Problem>
          )}
          {!jsonError && queryError && <Problem title="The query can't run">{queryError}</Problem>}
          <DocsNote path="packages/core/docs/query-format.md">
            A query is one JSON object; only “collection” is required.
          </DocsNote>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minWidth: 0,
            opacity: stale ? 0.5 : 1,
            transition: 'opacity .15s ease',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              minHeight: 20,
            }}
          >
            <span style={styles.fieldLabel}>
              {result ? `${records.length} found${result.cursor ? ', and more after these' : ''}` : 'Results'}
              {running && <span style={{ color: palette.ink.faint, fontWeight: 400 }}> · running…</span>}
              {stale && result && (
                <span style={{ color: palette.ink.faint, fontWeight: 400 }}>
                  {' '}
                  · from the last query that worked
                </span>
              )}
            </span>
            <div role="tablist" aria-label="Show results as" style={{ ...styles.segmented, padding: 2 }}>
              {(['Table', 'JSON'] as const).map((mode) => {
                const on = (mode === 'JSON') === raw;
                return (
                  <button
                    key={mode}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setRaw(mode === 'JSON')}
                    style={{
                      ...(on ? styles.segmentActive : styles.segment),
                      padding: '3px 10px',
                      fontSize: 12,
                    }}
                  >
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
                <button
                  onClick={() => setCursor(result.cursor)}
                  data-variant="quiet"
                  style={styles.smallButton}
                >
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
        Ask this space for exactly the records you want, written as plain JSON. It runs as you type, on the
        data on this device, and nothing you do here changes anything.
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
};

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
    <div
      style={{
        position: 'relative',
        borderRadius: palette.radius.lg,
        backgroundColor: palette.surface.sunken,
      }}
    >
      <pre
        ref={under}
        aria-hidden
        className="code-layer"
        style={{
          ...codeText,
          ...syntax,
          position: 'absolute',
          inset: 0,
          margin: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
          border: '1px solid transparent',
        }}
        dangerouslySetInnerHTML={{ __html: `${html}\n ` }}
      />
      <textarea
        id="query-editor"
        className="code-layer"
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
            <th style={th}>Collection</th>
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
              <td
                style={{
                  ...td,
                  color: palette.ink.strong,
                  fontWeight: 500,
                  maxWidth: 240,
                  ...ui.ellipsis,
                }}
              >
                {label(record)}
              </td>
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
    <span style={{ ...ui.stack, gap: 2 }}>
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

const th: CSSProperties = { ...ui.th, padding: '9px 12px', whiteSpace: 'nowrap' };
const td: CSSProperties = { ...ui.td, padding: '9px 12px', whiteSpace: 'nowrap', verticalAlign: 'top' };
