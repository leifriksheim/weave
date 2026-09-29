import { useEffect, useMemo, useState } from 'react';
import {
  DEFINE,
  roleHolds,
  type NodeCollection,
  type NodeRecord,
  type SpaceSummary,
} from '@weaveprotocol/core';
import { useAccess, useAccount, useNode } from '@weaveprotocol/core/react';
import { Modal } from '@weave/app-shared/Modal';
import { clauseFields, clauseOn, type Clause, type ClauseField } from '../../derive/conditions';
import { belonging, collectionLabel, recordLabel } from '../../derive/schema-ui';
import { isBot, nameOf, type People } from '../../derive/people';
import {
  matching,
  rule as ruleCollection,
  ruleOf,
  ruleRun as runCollection,
  type Rule,
  type RuleAction,
  type RuleMatch,
} from '@weaveprotocol/core/schemas';
import {
  ACTIONS,
  COUNT_OPS,
  addAction,
  addable,
  linkToIt,
  type AddTarget,
  compile,
  noun,
  pickedOf,
  thenWords,
  whenWords,
  type CountClause,
  type Picked,
  type PickedRule,
} from '../../rules';
import { usePeopleHere } from '../Person';
import { styles, palette } from '../../styles';
import { ClauseList, Pill, Sentence, Step, ValueInput, card, previewBox } from './parts';

/**
 * A rule, built by picking: when a record of some collection is, or comes to
 * be, a certain way — its fields, or how many records point at it — do one
 * thing. What can be picked comes from the space's own definitions, so a
 * rule works on a collection someone made yesterday as well as on polls.
 */
export function RuleBuilder({
  space,
  collections,
  editing,
  start,
  onClose,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  /** A rule to change, instead of making one */
  editing?: NodeRecord;
  /** Where a new one starts: an idea picked from the list */
  start?: PickedRule;
  onClose: () => void;
}) {
  const node = useNode();
  const { did } = useAccount();
  const access = useAccess(space.id);
  const here = usePeopleHere();
  const people: People = here?.people ?? new Map();
  const stored = editing ? ruleOf(editing) : null;
  const picked = stored ? pickedOf(stored) : (start?.picked ?? null);
  const initial = stored ?? start;

  const offered = useMemo(
    () =>
      collections.filter(
        (c) =>
          c.schema !== null &&
          c.version !== null &&
          c.name !== ruleCollection.name &&
          c.name !== runCollection.name,
      ),
    [collections],
  );
  const [collection, setCollection] = useState(picked?.collection ?? offered[0]?.name ?? '');
  const [clauses, setClauses] = useState<ReadonlyArray<Clause>>(picked?.clauses ?? []);
  const [count, setCount] = useState<CountClause | null>(picked?.count ?? null);
  const [then, setThen] = useState<RuleAction>(initial?.then ?? { kind: 'notify', text: '{title}' });
  const [name, setName] = useState<string | null>(initial?.name ?? null);
  // Who runs a rule that asks: their own agent, or a bot here.
  const [by, setBy] = useState<string>(stored?.by ?? '');
  const bots = [...people.entries()]
    .filter(([d]) => isBot(d, people))
    .map(([d, p]) => ({ did: d, name: p.name }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = offered.find((c) => c.name === collection);
  const fields = useMemo(() => (chosen ? clauseFields(chosen) : []), [chosen]);
  const countable = useMemo(
    () => (collection ? belonging(collections, collection) : []),
    [collections, collection],
  );
  const countFields = useMemo(() => {
    const counted = collections.find((c) => c.name === count?.collection);
    return counted ? clauseFields(counted) : [];
  }, [collections, count?.collection]);

  const when = useMemo(
    (): Picked => ({ collection, clauses, ...(count ? { count } : {}) }),
    [collection, clauses, count],
  );
  const who = (d: string) => nameOf(d, people);
  const sentence = chosen
    ? `${whenWords(when, collections, who)}, ${thenWords(then, collections, collection)}.`
    : '';
  const shownName = name ?? (chosen ? `${collectionLabel(chosen)} rule` : 'Rule');

  const has = (n: string) => collections.some((c) => c.name === n && c.version !== null);
  const settable = fields.filter((f) => ['choice', 'yesno', 'number', 'text'].includes(f.kind));
  const targets = useMemo(
    () => (collection ? addable(collections, collection) : []),
    [collections, collection],
  );
  const onlyTheirs = chosen?.rules.edit === 'creator';

  // What it holds for right now: shown, never acted on — a rule acts on what changes after it's made.
  const [found, setFound] = useState<{ for: typeof when; matches: ReadonlyArray<RuleMatch> } | null>(null);
  const preview = found?.for === when ? found.matches : null;
  useEffect(() => {
    if (!when.collection) return;
    let live = true;
    const timer = setTimeout(() => {
      void matching(node, space.id, compile(when), did, 100)
        .then((matches) => live && setFound({ for: when, matches }))
        .catch(() => live && setFound({ for: when, matches: [] }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [node, space.id, when, did]);

  const save = async () => {
    if (!chosen) return;
    setError(null);
    if (then.kind !== 'set' && !then.text.trim()) return setError('Say what it should say');
    if (count && !Number.isFinite(count.value)) return setError('Say how many');
    setBusy(true);
    try {
      for (const definition of [ruleCollection, runCollection]) {
        if (has(definition.name)) continue;
        if (!roleHolds(access?.role, DEFINE))
          throw new Error(
            'Rules aren’t set up in this space yet: someone who can add collections needs to make the first one.',
          );
        await node.collections.define(space.id, definition);
      }
      const body: Rule = {
        name: shownName.trim() || 'Rule',
        when: compile(when),
        picked: when,
        then,
        ...(then.kind === 'ask' && by ? { by } : {}),
        ...(stored?.every ? { every: stored.every } : {}),
        ...(stored?.paused ? { paused: true } : {}),
        since: new Date().toISOString(),
      };
      if (editing) await node.records.update(space.id, editing.key, body);
      else await node.records.put(space.id, ruleCollection.name, body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Change rule' : 'New rule'} onClose={onClose} width={680}>
      <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.5, marginTop: -6 }}>
        Something happens in {space.name}, and something is done about it — by your devices, as you.
      </p>

      <div style={card}>
        <Step label="When">
          <Sentence>
            <span>a</span>
            <Pill
              label="What"
              value={collection}
              options={offered.map((c) => ({ value: c.name, label: collectionLabel(c).toLowerCase() }))}
              onChange={(next) => {
                setCollection(next);
                setClauses([]);
                setCount(null);
                if (then.kind === 'set') setThen({ kind: 'notify', text: '{title}' });
                // What a new record can point at depends on what the rule is about
                if (then.kind === 'add') {
                  const links = addable(collections, next).find(
                    (t) => t.collection.name === then.collection,
                  )?.links;
                  const link = linkToIt(then);
                  setThen(
                    addAction(then.collection, then.text, link && links?.includes(link) ? link : links?.[0]),
                  );
                }
              }}
            />
            {count ? (
              <>
                <span>has</span>
                <Pill
                  label="How many"
                  strong={false}
                  value={count.op}
                  options={COUNT_OPS.map((o) => ({ value: o.op, label: o.label }))}
                  onChange={(op) => setCount({ ...count, op })}
                />
                <input
                  aria-label="Number"
                  type="number"
                  min={0}
                  value={Number.isFinite(count.value) ? count.value : ''}
                  onChange={(e) =>
                    setCount({ ...count, value: e.target.value === '' ? NaN : Number(e.target.value) })
                  }
                  style={numberBox}
                />
                <Pill
                  label="Of what"
                  value={`${count.collection} ${count.rel}`}
                  options={countable.map((a) => ({
                    value: `${a.collection.name} ${a.rel}`,
                    label: noun(collections, a.collection.name, true),
                  }))}
                  onChange={(picked) => {
                    const [c, rel] = picked.split(' ');
                    if (c && rel) setCount({ ...count, collection: c, rel, clauses: [] });
                  }}
                />
                <button
                  type="button"
                  onClick={() => setCount(null)}
                  aria-label="Stop counting"
                  data-variant="ghost"
                  style={styles.rowAction}
                >
                  ✕
                </button>
              </>
            ) : (
              <span style={{ color: palette.ink.muted }}>is added or changed</span>
            )}
          </Sentence>
          {!count && countable.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {countable.slice(0, 3).map((a) => (
                <button
                  key={`${a.collection.name} ${a.rel}`}
                  type="button"
                  onClick={() =>
                    setCount({ collection: a.collection.name, rel: a.rel, op: 'atLeast', value: 10 })
                  }
                  data-variant="quiet"
                  style={chip}
                >
                  + gets a number of {noun(collections, a.collection.name, true)}
                </button>
              ))}
            </div>
          )}
          {count && countFields.length > 0 && (
            <details open={!!count.clauses?.length}>
              <summary style={{ fontSize: 13, color: palette.ink.muted }}>
                Count only some {noun(collections, count.collection, true)}
              </summary>
              <div style={{ marginTop: 8 }}>
                <ClauseList
                  fields={countFields}
                  clauses={count.clauses ?? []}
                  onChange={(next) => setCount({ ...count, clauses: next })}
                  people={people}
                  me={did}
                  suggest={false}
                />
              </div>
            </details>
          )}
        </Step>

        <Step label="Only if">
          <ClauseList
            fields={fields}
            clauses={clauses}
            onChange={setClauses}
            people={people}
            me={did}
            empty={`Any ${chosen ? collectionLabel(chosen).toLowerCase() : 'record'}, or narrow it down:`}
          />
        </Step>

        <Step label="Then">
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}
          >
            {ACTIONS.map((action) => {
              const unusable =
                (action.kind === 'set' && settable.length === 0) ||
                (action.kind === 'add' && targets.length === 0);
              const on = then.kind === action.kind;
              return (
                <button
                  key={action.kind}
                  type="button"
                  disabled={unusable}
                  title={
                    !unusable
                      ? action.hint
                      : action.kind === 'add'
                        ? 'Nothing in this space can be added from a line of text'
                        : 'Nothing here it could change'
                  }
                  aria-pressed={on}
                  onClick={() => setThen(startAction(action.kind, settable, targets, then))}
                  style={{
                    ...tile,
                    borderColor: on ? palette.ink.strong : palette.surface.line,
                    boxShadow: on ? `0 0 0 1px ${palette.ink.strong}` : 'none',
                  }}
                >
                  <strong style={{ fontSize: 13, color: palette.ink.strong }}>{action.label}</strong>
                  <span style={{ fontSize: 12, color: palette.ink.muted, lineHeight: 1.35 }}>
                    {action.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <ActionDetail
            then={then}
            onChange={setThen}
            settable={settable}
            counting={!!count}
            targets={targets}
            collections={collections}
            people={people}
            me={did}
          />
          {then.kind === 'set' && onlyTheirs && chosen && (
            <p style={{ fontSize: 12.5, color: palette.ink.muted }}>
              Only whoever made a {collectionLabel(chosen).toLowerCase()} can change it, so this works on the
              ones you made.
            </p>
          )}
          {then.kind === 'ask' && (
            <Sentence>
              <span>Asked of</span>
              <Pill
                label="Who does it"
                value={by}
                options={[
                  { value: '', label: 'my own agent' },
                  ...bots.map((bot) => ({ value: bot.did, label: bot.name })),
                ]}
                onChange={setBy}
              />
              <span style={{ color: palette.ink.muted }}>
                {by ? 'while the bot runs' : 'while `weave agent` runs on one of your computers'}
              </span>
            </Sentence>
          )}
        </Step>
      </div>

      {chosen && (
        <div style={previewBox}>
          <span style={{ color: palette.ink.strong, fontWeight: 500 }}>{sentence}</span>
          {preview === null ? (
            <span style={{ color: palette.ink.faint }}>Looking at what's here…</span>
          ) : preview.length === 0 ? (
            <span style={{ color: palette.ink.muted }}>Nothing here matches yet.</span>
          ) : (
            <span style={{ color: palette.ink.muted }}>
              Right now {preview.length === 1 ? 'one matches' : `${preview.length} match`}:{' '}
              {preview
                .slice(0, 3)
                .map(
                  (m) =>
                    `“${recordLabel(m.record, chosen.schema)}”${typeof m.included.count === 'number' ? ` (${m.included.count})` : ''}`,
                )
                .join(', ')}
              {preview.length > 3 ? '…' : ''}. It acts only on what changes from now on.
            </span>
          )}
        </div>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={styles.fieldLabel}>Name</span>
        <input
          value={shownName}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          style={styles.input}
        />
      </label>

      <p style={{ fontSize: 12.5, color: palette.ink.faint, lineHeight: 1.5 }}>
        It runs on your devices while this app is open on one of them. Everyone in {space.name} can see the
        rule and what it did.
      </p>
      {error && <p style={{ ...styles.error, fontSize: 13 }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} data-variant="quiet" style={{ ...styles.smallButton, height: 40 }}>
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={!chosen || busy}
          data-variant="primary"
          style={{ ...styles.button, width: 'auto' }}
        >
          {busy ? 'Saving…' : editing ? 'Save rule' : 'Turn on rule'}
        </button>
      </div>
    </Modal>
  );
}

/** A new action of a kind, keeping the words already typed */
function startAction(
  kind: RuleAction['kind'],
  settable: ReadonlyArray<ClauseField>,
  targets: ReadonlyArray<AddTarget>,
  was: RuleAction,
): RuleAction {
  const text = 'text' in was ? was.text : '{title}';
  if (kind === 'notify' || kind === 'ask') return { kind, text };
  if (kind === 'add') {
    const target = targets[0]!;
    return addAction(target.collection.name, text, target.links[0]);
  }
  const field = settable[0]!;
  const first = clauseOn(field);
  return { kind, field: field.name, value: first.value ?? (field.kind === 'number' ? 0 : '') };
}

/** What the picked action needs said: its words, or which field to set to what */
function ActionDetail({
  then,
  onChange,
  settable,
  counting,
  targets,
  collections,
  people,
  me,
}: {
  then: RuleAction;
  onChange: (then: RuleAction) => void;
  settable: ReadonlyArray<ClauseField>;
  counting: boolean;
  targets: ReadonlyArray<AddTarget>;
  collections: ReadonlyArray<NodeCollection>;
  people: People;
  me: string;
}) {
  if (then.kind === 'set') {
    const field = settable.find((f) => f.name === then.field) ?? settable[0];
    if (!field) return null;
    return (
      <Sentence>
        <span>Set its</span>
        <Pill
          label="Field to set"
          value={field.name}
          options={settable.map((f) => ({ value: f.name, label: f.label.toLowerCase() }))}
          onChange={(name) => {
            const next = settable.find((f) => f.name === name);
            if (next) onChange(startAction('set', [next], [], then));
          }}
        />
        <span>to</span>
        <ValueInput
          field={field}
          clause={{ field: field.name, op: 'is', value: then.value }}
          people={people}
          me={me}
          onChange={(patch) => {
            if (patch.value !== undefined) onChange({ ...then, value: patch.value });
          }}
        />
      </Sentence>
    );
  }
  const insert = (token: string) =>
    onChange({ ...then, text: `${then.text}${then.text.endsWith(' ') || !then.text ? '' : ' '}${token}` });
  const target = then.kind === 'add' ? targets.find((t) => t.collection.name === then.collection) : undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {then.kind === 'add' && (
        <Sentence>
          <span>Add a</span>
          <Pill
            label="What to add"
            value={then.collection}
            options={targets.map((t) => ({
              value: t.collection.name,
              label: collectionLabel(t.collection).toLowerCase(),
            }))}
            onChange={(name) => {
              const next = targets.find((t) => t.collection.name === name);
              if (next) onChange(startAction('add', [], [next], then));
            }}
          />
          {target && target.links.length > 0 && (
            <Pill
              label="Linked"
              strong={false}
              value={linkToIt(then) ?? ''}
              options={[
                ...target.links.map((rel) => ({ value: rel, label: `about it (${rel})` })),
                { value: '', label: 'on its own' },
              ]}
              onChange={(rel) => onChange(addAction(then.collection, then.text, rel || undefined))}
            />
          )}
          {target === undefined && (
            <span style={{ color: palette.ink.muted }}>
              ({noun(collections, then.collection, true)} can’t be added here)
            </span>
          )}
        </Sentence>
      )}
      <input
        aria-label="What it says"
        value={then.text}
        onChange={(e) => onChange({ ...then, text: e.target.value })}
        placeholder="What it says"
        maxLength={500}
        style={styles.input}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: palette.ink.faint }}>
        Insert
        <button type="button" onClick={() => insert('{title}')} data-variant="quiet" style={token}>
          its name
        </button>
        {counting && (
          <button type="button" onClick={() => insert('{count}')} data-variant="quiet" style={token}>
            the count
          </button>
        )}
      </div>
    </div>
  );
}

const numberBox = {
  width: 72,
  height: 32,
  padding: '0 10px',
  borderRadius: 8,
  border: `1px solid ${palette.surface.lineStrong}`,
  fontSize: 14,
  fontWeight: 600,
} as const;

const chip = {
  ...styles.smallButton,
  height: 30,
  borderRadius: 999,
  fontSize: 13,
  color: palette.ink.muted,
} as const;

const tile = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  padding: '10px 12px',
  borderRadius: 10,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
  textAlign: 'left',
} as const;

const token = { ...styles.smallButton, height: 24, padding: '0 8px', fontSize: 12 } as const;
