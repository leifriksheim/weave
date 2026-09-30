import { useEffect, useMemo, useState } from 'react';
import {
  DEFINE,
  MANAGE,
  roleHolds,
  type NodeCollection,
  type NodeRecord,
  type SpaceSummary,
} from '@weaveprotocol/core';
import { useAccess, useAccount, useNode } from '@weaveprotocol/core/react';
import { Modal } from '@weave/app-shared/Modal';
import { AddBotDialog, useSpaceBots } from '@weave/app-shared/CommunitySetup';
import { clauseFields, clauseOn, type Clause, type ClauseField } from '../../derive/conditions';
import { belonging, collectionLabel, recordLabel } from '../../derive/schema-ui';
import { useBots } from '../../bots';
import { nameOf, type People } from '../../derive/people';
import {
  INSTRUCT,
  SCHEDULES,
  checkCron,
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
  scheduleWords,
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
 * be, a certain way — its fields, or how many records point at it — or at set
 * times, do one thing. What can be picked comes from the space's own
 * definitions, so a rule works on a collection someone made yesterday as well
 * as on polls.
 */

/** In the schedule picker, a time of one's own */
const OTHER = 'other';
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
  const [addingBot, setAddingBot] = useState(false);
  const [clauses, setClauses] = useState<ReadonlyArray<Clause>>(picked?.clauses ?? []);
  const [count, setCount] = useState<CountClause | null>(picked?.count ?? null);
  const [then, setThen] = useState<RuleAction>(initial?.then ?? { kind: 'notify', text: '{title}' });
  const [name, setName] = useState<string | null>(initial?.name ?? null);
  // Set off by records, or by the time: an agent or a bot runs the latter.
  const [timed, setTimed] = useState(!!stored && !stored.when && !!stored.every);
  const [every, setEvery] = useState(stored?.every ?? SCHEDULES[0]!.value);
  const [ownTime, setOwnTime] = useState(!SCHEDULES.some((s) => s.value === every));
  const everyProblem = timed ? checkCron(every) : null;
  // The bots the space's host runs, whoever says so on their own profile here, and the one a rule being changed names.
  const saidBots = useBots(space.id);
  const { bots: known } = useSpaceBots(space.id, space.writable);
  const bots = [
    ...new Set([...known.map((bot) => bot.did), ...saidBots, ...(stored?.by ? [stored.by] : [])]),
  ].map((d) => ({ did: d, name: known.find((bot) => bot.did === d)?.name ?? nameOf(d, people) }));
  // Who does it, for a rule that asks or runs at set times: their own agent, or a bot here. A new
  // rule starts with the space's bot, one the host runs first: the agent needs a computer left on.
  const [chosenBy, setBy] = useState<string | null>(stored ? (stored.by ?? '') : null);
  const by = chosenBy ?? known.find((bot) => bot.state === 'on')?.did ?? bots[0]?.did ?? '';
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
  const sentence = timed
    ? `${scheduleWords(every)}, ${thenWords(then, collections, collection)}.`
    : chosen
      ? `${whenWords(when, collections, who)}, ${thenWords(then, collections, collection)}.`
      : '';
  const shownName =
    name ?? (timed ? scheduleWords(every) : chosen ? `${collectionLabel(chosen)} rule` : 'Rule');

  const has = (n: string) => collections.some((c) => c.name === n && c.version !== null);
  const settable = fields.filter((f) => ['choice', 'yesno', 'number', 'text'].includes(f.kind));
  const targets = useMemo(
    () =>
      timed
        ? // Nothing set it off, so there is nothing to link to.
          addable(collections, '').map((t) => ({ ...t, links: [] }))
        : collection
          ? addable(collections, collection)
          : [],
    [collections, collection, timed],
  );
  const agentDoes = then.kind === 'ask' || timed;
  const botName = by ? (bots.find((b) => b.did === by)?.name ?? nameOf(by, people)) : null;
  // A bot runs a member's rules only while they may instruct it here.
  const mayInstruct = roleHolds(access?.role, INSTRUCT);
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
    if (!chosen && !timed) return;
    setError(null);
    if (everyProblem) return setError(`When: ${everyProblem}`);
    if (agentDoes && by && !mayInstruct)
      return setError(`${botName ?? 'That bot'} only runs rules of people who may instruct it here.`);
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
        ...(timed ? { every: every.trim() } : { when: compile(when), picked: when }),
        then,
        ...(agentDoes && by ? { by } : {}),
        // A rule made elsewhere that has both keeps its time when its records are changed here.
        ...(!timed && stored?.every ? { every: stored.every } : {}),
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
    <>
      <Modal title={editing ? 'Change rule' : 'New rule'} onClose={onClose} width={680}>
        <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.5, marginTop: -6 }}>
          Something happens in {space.name}, or the time comes, and something is done about it — as you, or by
          a bot you name.
        </p>

        <div style={card}>
          <Step label="When">
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { value: false, label: 'Something happens' },
                { value: true, label: 'At set times' },
              ].map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  aria-pressed={timed === choice.value}
                  onClick={() => {
                    setTimed(choice.value);
                    // Nothing set it off, so nothing to notify about on this device, nor to change.
                    if (choice.value && (then.kind === 'set' || then.kind === 'notify'))
                      setThen({ kind: 'ask', text: '' });
                    if (choice.value && then.kind === 'add') setThen(addAction(then.collection, then.text));
                  }}
                  data-variant="quiet"
                  style={{
                    ...chip,
                    color: timed === choice.value ? palette.ink.strong : palette.ink.muted,
                    fontWeight: timed === choice.value ? 600 : 400,
                    borderColor: timed === choice.value ? palette.ink.strong : palette.surface.line,
                    boxShadow: timed === choice.value ? `0 0 0 1px ${palette.ink.strong}` : 'none',
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            {timed ? (
              <>
                <Sentence>
                  <Pill
                    label="When"
                    value={ownTime ? OTHER : every}
                    options={[
                      ...SCHEDULES.map((s) => ({ value: s.value, label: s.label.toLowerCase() })),
                      { value: OTHER, label: 'at a time of my own' },
                    ]}
                    onChange={(picked) => {
                      setOwnTime(picked === OTHER);
                      if (picked !== OTHER) setEvery(picked);
                    }}
                  />
                </Sentence>
                {ownTime && (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input
                      aria-label="Minute hour day month weekday"
                      value={every}
                      onChange={(e) => setEvery(e.target.value)}
                      placeholder="30 7 * * 1-5"
                      style={{ ...styles.input, fontFamily: 'ui-monospace, monospace' }}
                    />
                    <span
                      style={{
                        fontSize: 12,
                        color: everyProblem ? palette.accent.danger : palette.ink.faint,
                      }}
                    >
                      {everyProblem ??
                        'Minute, hour, day, month, weekday, in the runner’s local time: 30 7 * * 1-5 is weekdays at 7:30.'}
                    </span>
                  </label>
                )}
              </>
            ) : (
              <>
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
                          addAction(
                            then.collection,
                            then.text,
                            link && links?.includes(link) ? link : links?.[0],
                          ),
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
              </>
            )}
          </Step>

          {!timed && (
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
          )}

          <Step label="Then">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 6,
              }}
            >
              {ACTIONS.map((action) => {
                const untimed = timed && (action.kind === 'set' || action.kind === 'notify');
                const unusable =
                  untimed ||
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
                        : untimed
                          ? 'At set times nothing set it off, and an agent, not this device, runs it'
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
                      {timed && action.kind === 'add' ? 'A record in any collection here' : action.hint}
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
              about={!timed}
              targets={targets}
              collections={collections}
              people={people}
              me={did}
            />
            {then.kind === 'set' && onlyTheirs && chosen && (
              <p style={{ fontSize: 12.5, color: palette.ink.muted }}>
                Only whoever made a {collectionLabel(chosen).toLowerCase()} can change it, so this works on
                the ones you made.
              </p>
            )}
            {agentDoes && (
              <Sentence>
                <span>Done by</span>
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
                  {by
                    ? 'as itself, while it runs'
                    : 'as you, while weave agent runs on one of your computers'}
                </span>
              </Sentence>
            )}
            {agentDoes && bots.length === 0 && (
              <p style={{ fontSize: 12.5, color: palette.ink.muted }}>
                No bots in {space.name} yet.{' '}
                {space.writable && roleHolds(access?.role, MANAGE) ? (
                  <button type="button" style={styles.linkButton} onClick={() => setAddingBot(true)}>
                    Add a bot
                  </button>
                ) : (
                  'Someone who manages it can add one, under Hosting.'
                )}
              </p>
            )}
            {agentDoes && by && !mayInstruct && (
              <p style={{ fontSize: 12.5, color: palette.accent.danger }}>
                {botName} only runs the rules of people who may instruct it here, and you may not. Someone who
                manages {space.name} can let your role, or make this rule themselves.
              </p>
            )}
          </Step>
        </div>

        {timed ? (
          <div style={previewBox}>
            <span style={{ color: palette.ink.strong, fontWeight: 500 }}>{sentence}</span>
            <span style={{ color: palette.ink.muted }}>
              {by ? `${botName} does it` : 'Your agent does it'} at those times, in its local time, while it
              runs. This app doesn’t run rules at set times.
            </span>
          </div>
        ) : (
          chosen && (
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
          )
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
          {agentDoes
            ? by
              ? `${botName} runs it, as itself.`
              : 'Your agent runs it, as you, while weave agent runs on one of your computers.'
            : 'It runs on your devices while this app is open on one of them.'}{' '}
          Everyone in {space.name} can see the rule and what it did.
        </p>
        {error && <p style={{ ...styles.error, fontSize: 13 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} data-variant="quiet" style={{ ...styles.smallButton, height: 40 }}>
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={(!chosen && !timed) || busy}
            data-variant="primary"
            style={{ ...styles.button, width: 'auto' }}
          >
            {busy ? 'Saving…' : editing ? 'Save rule' : 'Turn on rule'}
          </button>
        </div>
      </Modal>
      {addingBot && (
        <AddBotDialog spaceId={space.id} writable={space.writable} onClose={() => setAddingBot(false)} />
      )}
    </>
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
  about,
  targets,
  collections,
  people,
  me,
}: {
  then: RuleAction;
  onChange: (then: RuleAction) => void;
  settable: ReadonlyArray<ClauseField>;
  counting: boolean;
  /** A record set it off, so its name can go in the words */
  about: boolean;
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
      {about && (
        <div
          style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: palette.ink.faint }}
        >
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
      )}
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
