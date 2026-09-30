/**
 * @module schemas/rules
 * Rules: "when a channel has more than 10 messages, post in it". Not the
 * rules a definition carries, which every peer checks (spec 02 §7) and which
 * can only refuse; these act, as whoever runs them.
 *
 * A rule is an ordinary record (`std.rule`), so everyone in the space can see
 * what runs and who made it. What sets it off is a query, in the format
 * `records.query` takes, and a condition over each result, in the language of
 * checks, that may read what the query's `include` found; or the times it
 * names (`every`). It does one thing: notify, add a record, change the record,
 * or ask an agent. Its maker's own devices and agent run it, or, with `by`, a
 * bot the maker may instruct. Whatever it writes is written as its runner, so
 * a rule can do nothing its runner couldn't do by hand.
 *
 * Each time it acts on a record it leaves a run (`std.rule-run`), one per
 * rule per record by construction (`onePer`): that is how it acts once for
 * each record, whichever device or agent looks, and the rule's history for
 * anyone. A run names the record the rule wrote, and nothing a rule wrote sets
 * off a rule: "when a message is added, post a message" would otherwise answer
 * itself forever, and so would two rules that answer each other.
 *
 * Not protocol: a peer that has never heard of rules syncs and judges these
 * records like any other. See `packages/core/docs/rules.md`.
 */
import type { DefineCollection, NodeRecord, P2PNode, SpaceAccess } from '../node/types.js';
import { nameOf, plainQuery, type Query, type QueryRecord, type Typed } from '../query/types.js';
import { checkQuery } from '../query/filter.js';
import { checkRecordCondition, recordHolds, type Condition } from '../records/checks.js';
import { quickAddBody } from '../schema/quick-add.js';
import { roleHolds } from '../space/roles.js';
import { isObject } from '../utils/guards.js';
import { checkCron, cronMatches } from './cron.js';
import { about, one, person, text, when as moment, words } from './fragments.js';

/** A link a rule's new record carries: to a record by key, or to `$it`, the record the rule holds for */
export interface RuleLink {
  readonly rel: string;
  readonly to: string;
}

/**
 * What a rule does. In text, `{title}` is what the record is called,
 * `{<include>}` how many an include found. `add` makes a record in any
 * collection one line of text can make one of (`quickAddBody`): a message, a
 * comment, a task, or one someone defined yesterday, with the links it names.
 * `ask` gives its text, in the maker's words, to an agent that runs rules.
 */
export type RuleAction =
  | { readonly kind: 'notify'; readonly text: string }
  | {
      readonly kind: 'add';
      readonly collection: string;
      readonly text: string;
      readonly links?: ReadonlyArray<RuleLink>;
    }
  | { readonly kind: 'set'; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: 'ask'; readonly text: string };

/** What sets a rule off: the records a query finds, those a condition holds for */
export interface RuleWhen {
  /** `records.query`'s format; `include` is how a rule counts or reads what points at a record */
  readonly query: Query;
  /** A record condition over each result, which may also read `included` (`checkRecordCondition`) */
  readonly holds?: Condition;
  /** Only records by someone holding one of these roles: a role name, or `member` for any */
  readonly from?: ReadonlyArray<string>;
}

export interface Rule {
  readonly name: string;
  /** What records set it off. A rule has this, `every`, or both. */
  readonly when?: RuleWhen;
  /** When it runs by itself: five cron fields, minute hour day month weekday, in the runner's local time */
  readonly every?: string;
  readonly then: RuleAction;
  /** The bot that runs it, when its maker may instruct bots here; else its maker's own devices and agent */
  readonly by?: string;
  /** How an app's builder showed it, so it can be shown and changed again. Never read to run it. */
  readonly picked?: Readonly<Record<string, unknown>>;
  readonly paused?: boolean;
  /** Nothing that came to hold before this sets it off */
  readonly since: string;
}

export interface RuleRun {
  /** What it did, in words */
  readonly did: string;
  readonly ok: boolean;
  readonly at: string;
  /** The record it wrote, when it wrote a new one: nothing a rule wrote sets off a rule */
  readonly made?: string;
}

export const rule: DefineCollection & Typed<Rule> = {
  name: 'std.rule',
  title: 'Rule',
  description: 'When records in the space are a certain way, or at set times, do something.',
  schema: {
    type: 'object',
    properties: {
      name: words(120),
      when: { type: 'object' },
      every: text(100, 'Five cron fields, minute hour day month weekday, local time', 9),
      then: { type: 'object' },
      by: person('The bot that runs it'),
      picked: { type: 'object' },
      paused: { type: 'boolean' },
      since: moment('Nothing that came to hold before this sets it off'),
    },
    required: ['name', 'then', 'since'],
  },
  // `instruct`: whose rules a bot runs (`by`).
  permissions: ['moderate', 'instruct'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
};

export const ruleRun: DefineCollection & Typed<RuleRun> = {
  name: 'std.rule-run',
  title: 'Rule run',
  description: 'A rule acted on a record: once each, whichever device did it.',
  schema: {
    type: 'object',
    properties: { did: words(500), ok: { type: 'boolean' }, at: moment(), made: words(256) },
    required: ['did', 'ok', 'at'],
  },
  links: {
    rule: one([rule.name], 'The rule that ran'),
    about: about('The record it ran for'),
  },
  permissions: ['moderate'],
  rules: { onePer: ['link:rule', 'link:about'], edit: 'creator', delete: ['creator', 'can:moderate'] },
};

/** Where a bot, an agent or anyone's work on something stands */
export type ActivityState = 'working' | 'waiting' | 'done' | 'failed';
export const ACTIVITY_STATES: ReadonlyArray<ActivityState> = ['working', 'waiting', 'done', 'failed'];

export interface Activity {
  readonly state: ActivityState;
  /** What it is doing, in a few words: "Replying", "Making an app" */
  readonly label?: string;
  /** When it came to this state */
  readonly at: string;
}

/**
 * Someone at work on a record, for apps to show while it lasts: "My bot is
 * replying…" under a message, a spinner on a task. One per account per
 * record, changed in place as the work goes on. Its writer's word, like a
 * status, and only theirs to change.
 */
export const activity: DefineCollection & Typed<Activity> = {
  name: 'std.activity',
  title: 'Activity',
  description: 'Someone at work on a record: working, waiting, done or failed.',
  schema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: [...ACTIVITY_STATES] },
      label: words(120),
      at: moment('When it came to this state'),
    },
    required: ['state', 'at'],
  },
  links: { about: about('What the work is on') },
  rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about'] },
};

/**
 * How long a `working` or `waiting` activity is believed without a change:
 * one whose writer went away mid-way would otherwise show forever.
 */
export const ACTIVITY_STALE_SECONDS = 300;

/** Whether an activity says someone is at work on it now: working or waiting, and not gone stale */
export function activeNow(body: Activity | null | undefined, now: number = Date.now()): boolean {
  if (!body || (body.state !== 'working' && body.state !== 'waiting')) return false;
  const at = Date.parse(body.at);
  return Number.isFinite(at) && now - at < ACTIVITY_STALE_SECONDS * 1000;
}

/**
 * Says where this account's work on a record stands: its one `std.activity`
 * about it, made or changed. Null where the space keeps no `std.activity`.
 */
export async function setActivity(
  node: P2PNode,
  space: string,
  on: string,
  state: ActivityState,
  label?: string,
): Promise<NodeRecord | null> {
  if (!(await node.collections.list(space)).some((c) => c.name === activity.name && c.version !== null))
    return null;
  const body: Activity = { state, ...(label ? { label } : {}), at: new Date().toISOString() };
  // One per account per record: a put for one it already has is that record's next version.
  return node.records.put(space, activity.name, body, { links: [{ rel: 'about', to: on }] });
}

/** In an action, the record the rule holds for */
export const IT = '$it';

/** In a rule's query or condition, whoever runs it: its maker, or the bot named in `by` */
export const ME = '$me';

/** The permission a maker needs in a space for a bot there to run their rules */
export const INSTRUCT = `${rule.name}/instruct`;

const KINDS = new Set(['notify', 'add', 'set', 'ask']);

/** Why this can't be a rule's action, or null */
function checkAction(then: unknown): string | null {
  if (!isObject(then) || typeof then.kind !== 'string' || !KINDS.has(then.kind))
    return `then.kind must be one of ${[...KINDS].join(', ')}`;
  if (then.kind === 'set') {
    if (typeof then.field !== 'string' || !then.field) return 'then.field must name a field';
    if (!['string', 'number', 'boolean'].includes(typeof then.value))
      return 'then.value must be a text, number or yes/no';
    return null;
  }
  if (typeof then.text !== 'string' || !then.text.trim()) return 'then.text must say something';
  if (then.kind === 'add') {
    if (typeof then.collection !== 'string' || !then.collection)
      return 'then.collection must name a collection';
    const links: unknown = then.links;
    if (
      links !== undefined &&
      !(
        Array.isArray(links) &&
        links.every(
          (l) => isObject(l) && typeof l.rel === 'string' && !!l.rel && typeof l.to === 'string' && !!l.to,
        )
      )
    )
      return `then.links must be a list of { rel, to }, where to is a record's key or "${IT}"`;
  }
  return null;
}

/** Why this can't be what sets a rule off, or null */
function checkWhen(when: Record<string, unknown>): string | null {
  const query = checkQuery(when.query);
  if (query) return `when.query: ${query}`;
  if (when.holds !== undefined) {
    const holds = checkRecordCondition(when.holds, 'when.holds', { included: true });
    if (holds) return holds;
  }
  const from: unknown = when.from;
  if (from !== undefined && !(Array.isArray(from) && from.every((r) => typeof r === 'string' && !!r)))
    return 'when.from must be a list of role names';
  return null;
}

/** Why this can't be a rule, or null when it can */
export function checkRule(value: unknown): string | null {
  if (!isObject(value)) return 'A rule must be an object';
  if (typeof value.name !== 'string' || !value.name.trim()) return 'A rule needs a name';
  if (value.when === undefined && value.every === undefined)
    return 'A rule needs a when: { query, holds? }, an every, or both';
  if (value.when !== undefined) {
    if (!isObject(value.when)) return 'when must be { query, holds?, from? }';
    const when = checkWhen(value.when);
    if (when) return when;
  }
  if (value.every !== undefined) {
    if (typeof value.every !== 'string') return 'every must be five cron fields';
    const every = checkCron(value.every);
    if (every) return `every: ${every}`;
  }
  const then = checkAction(value.then);
  if (then) return then;
  if (isObject(value.then) && value.then.kind === 'set' && value.when === undefined)
    return 'A rule that changes a record needs a when';
  if (value.by !== undefined && (typeof value.by !== 'string' || !value.by)) return "by must be a bot's DID";
  if (value.picked !== undefined && !isObject(value.picked)) return 'picked must be an object';
  if (value.paused !== undefined && typeof value.paused !== 'boolean') return 'paused must be true or false';
  if (typeof value.since !== 'string' || !Number.isFinite(Date.parse(value.since)))
    return 'since must be a date';
  return null;
}

const isRule = (value: unknown): value is Rule => checkRule(value) === null;

/** A rule record's body, when it is one */
export const ruleOf = (record: { readonly body: unknown }): Rule | null =>
  isRule(record.body) ? record.body : null;

/** `$me` wherever it is a value, as the account running the rule */
function asRunner<T>(value: T, me: string): T {
  // eslint-disable-next-line typescript/consistent-type-assertions -- the same shape, with one string swapped for another
  return JSON.parse(JSON.stringify(value), (_key, found: unknown) => (found === ME ? me : found)) as T;
}

/** One record a rule holds for now */
export interface RuleMatch {
  readonly record: QueryRecord;
  /** What its query's `include` found, as the condition read it: a count as a number */
  readonly included: Readonly<Record<string, unknown>>;
  /** When it came to hold, as far as can be told: its last change, or the newest record an include found */
  readonly moment: number;
}

/**
 * The records a rule holds for now, most recently changed first, for `me`,
 * who runs it. Includes that count are run as lists and counted here, so the
 * newest of them can tell when the rule came to hold.
 */
export async function matching(
  node: P2PNode,
  space: string,
  ruleWhen: RuleWhen,
  me: string,
  limit = 200,
): Promise<ReadonlyArray<RuleMatch>> {
  const when = asRunner(ruleWhen, me);
  const query = plainQuery(when.query);
  const counted = new Set<string>();
  const include = Object.fromEntries(
    Object.entries(query.include ?? {}).map(([name, found]) => {
      if (!found.count) return [name, found];
      counted.add(name);
      const { count: _count, limit: _limit, ...listed } = found;
      return [name, listed];
    }),
  );
  const { records } = await node.records.query(space, {
    ...query,
    include,
    sort: query.sort ?? { '@updatedAt': 'desc' },
    limit: query.limit ?? limit,
  });
  const found: RuleMatch[] = [];
  for (const record of records) {
    let latest = Date.parse(record.updatedAt);
    const included: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record.included)) {
      if (typeof value === 'number') {
        included[name] = value;
        continue;
      }
      for (const one of value) latest = Math.max(latest, Date.parse(one.createdAt));
      included[name] = counted.has(name) ? value.length : value;
    }
    if (
      when.holds !== undefined &&
      !(await recordHolds(when.holds, { ...record, author: record.createdBy, included }))
    )
      continue;
    found.push({ record, included, moment: latest });
  }
  return found;
}

/** What a record is called, for `{title}`: its first text among the usual names, or its key */
function titleOf(record: QueryRecord): string {
  const body = isObject(record.body) ? record.body : {};
  for (const name of ['title', 'name', 'question', 'text']) {
    const value = body[name];
    if (typeof value === 'string' && value.trim())
      return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return record.key;
}

/** `{title}`, and `{<include>}` as a count, filled in */
export function fillRuleText(
  text: string,
  match: Pick<RuleMatch, 'record' | 'included'> | undefined,
  title = titleOf,
) {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (!match) return whole;
    if (name === 'title') return title(match.record);
    const value = match.included[name];
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return String(value.length);
    return whole;
  });
}

/** A rule as it runs: where it is kept, who made it, and what it says */
export interface ActiveRule {
  readonly space: string;
  readonly key: string;
  /** The account that made it */
  readonly maker: string;
  readonly body: Rule;
}

/** A rule set off: by a record it came to hold for, or by the time */
export interface RuleTrigger {
  readonly rule: ActiveRule;
  readonly match?: RuleMatch;
  /** When a time set it off */
  readonly at?: Date;
}

/** What a device does for a rule's `notify`: shows it, and says whether it could */
export type RuleNotifier = (title: string, text: string, record?: QueryRecord) => boolean;

export interface RunRulesOptions {
  /** A bot, running as an account of its own: nothing it writes sets a rule off */
  readonly bot?: boolean;
  /** Shows a notification. Without it, a `notify` rule's run says nothing could. */
  readonly notify?: RuleNotifier;
  /** Does what a rule asks an agent. Without it, rules that ask are left to a runner that can. */
  readonly ask?: (trigger: RuleTrigger) => Promise<Pick<RuleRun, 'did' | 'ok'>>;
  /** What a record is called, for `{title}` */
  readonly title?: (record: QueryRecord) => string;
  /** Records being acted on now, shared across calls so a second look leaves them alone */
  readonly busy?: Set<string>;
  /**
   * How long to wait after claiming a record before acting, to hear whether a
   * device of the same account claimed it too; the earlier claim acts and the
   * later steps back. 0, the default, doesn't wait.
   */
  readonly claimMs?: number;
  /** Each time a rule acted */
  readonly onRun?: (trigger: RuleTrigger, run: RuleRun) => void;
}

/** Does what a rule says, as whoever runs it; says what happened */
export async function act(
  node: P2PNode,
  trigger: RuleTrigger,
  options: RunRulesOptions = {},
): Promise<RuleRun> {
  const { rule: active, match } = trigger;
  const space = active.space;
  const body = active.body;
  const at = new Date().toISOString();
  const text = (template: string) => fillRuleText(template, match, options.title);
  const then = body.then;
  try {
    switch (then.kind) {
      case 'notify': {
        const shown = options.notify?.(body.name, text(then.text), match?.record) ?? false;
        return { did: shown ? `Notified: ${text(then.text)}` : 'Nothing here could notify', ok: shown, at };
      }
      case 'ask': {
        if (!options.ask) return { did: 'Nothing here can ask an agent', ok: false, at };
        return { ...(await options.ask(trigger)), at };
      }
      case 'add': {
        const collections = await node.collections.list(space);
        const target = collections.find((c) => c.name === then.collection && c.version !== null);
        const thing = (target?.title ?? then.collection.split('.').pop() ?? then.collection).toLowerCase();
        const fresh = target ? quickAddBody(target.schema, text(then.text)) : null;
        if (!target || !fresh)
          return { did: `This space can't add a ${thing} from a line of text`, ok: false, at };
        // Without a record, as when the time set it off, a link to it has nothing to point at.
        const links = (then.links ?? []).flatMap((l) =>
          l.to !== IT ? [l] : match ? [{ rel: l.rel, to: match.record.key }] : [],
        );
        const made = await node.records.put(space, target.name, fresh, { links });
        return { did: `Added a ${thing}: ${text(then.text)}`, ok: true, at, made: made.key };
      }
      case 'set': {
        const current = match ? await node.records.get(space, match.record.key) : null;
        const was = isObject(current?.body) ? current.body : null;
        if (!current || !was) return { did: 'It is not there any more', ok: false, at };
        if (!(await node.records.can(space, 'edit', current.key)))
          return { did: 'Only whoever made it can change it', ok: false, at };
        await node.records.update(space, current.key, { ...was, [then.field]: then.value });
        return { did: `${text('“{title}”')}: set ${then.field} to ${String(then.value)}`, ok: true, at };
      }
    }
  } catch (error) {
    return { did: error instanceof Error ? error.message : String(error), ok: false, at };
  }
}

/** The role someone holds in a space, or null */
const roleIn = (access: SpaceAccess | undefined, did: string) => {
  const name = access?.members.find((member) => member.did === did)?.role;
  return access?.roles.find((role) => role.name === name) ?? null;
};

/** Whether someone holds one of these roles; `member` is any role at all */
const holdsOneOf = (access: SpaceAccess | undefined, did: string, names: ReadonlyArray<string>) => {
  const role = roleIn(access, did);
  return !!role && (names.includes('member') || names.includes(role.name));
};

/**
 * The rules in a space that `account` runs, none paused and none whose
 * current version an agent wrote: those it made without `by`, and those
 * naming it in `by` whose maker may instruct it here (`std.rule/instruct`).
 */
export async function rulesFor(
  node: P2PNode,
  space: string,
  account: string,
  access?: SpaceAccess,
): Promise<ReadonlyArray<ActiveRule>> {
  const records = await node.records.list(space, { collection: rule.name });
  return records.flatMap((record: NodeRecord) => {
    const maker = record.createdBy;
    const body = ruleOf(record);
    // An agent may suggest a rule; it runs once the person saves it themselves.
    if (!record.verified || record.viaAgent || !maker || !body || body.paused) return [];
    const runs =
      body.by === undefined
        ? maker === account
        : body.by === account && (maker === account || roleHolds(roleIn(access, maker), INSTRUCT));
    return runs ? [{ space, key: record.key, maker, body }] : [];
  });
}

/** How many rules in a space an agent wrote for `account`, waiting for the person to save them */
export async function suggestedRules(node: P2PNode, space: string, account: string): Promise<number> {
  const records = await node.records.list(space, { collection: rule.name });
  return records.filter((record) => record.createdBy === account && record.viaAgent).length;
}

/** The records each rule has run for, by rule key, and the records rules wrote */
async function runsIn(
  node: P2PNode,
  space: string,
): Promise<{ by: Map<string, Set<string>>; made: Set<string> }> {
  const by = new Map<string, Set<string>>();
  const made = new Set<string>();
  for (const run of await node.records.list(space, { collection: ruleRun.name })) {
    if (isObject(run.body) && typeof run.body.made === 'string') made.add(run.body.made);
    const ran = run.links.find((l) => l.rel === 'rule')?.to;
    const on = run.links.find((l) => l.rel === 'about')?.to;
    if (!ran || !on) continue;
    const seen = by.get(ran) ?? new Set<string>();
    seen.add(on);
    by.set(ran, seen);
  }
  return { by, made };
}

/**
 * Whether this claim is the one that acts. Two devices of one account may both
 * claim a record before either hears the other; after a wait, the earlier
 * claim (by time, then key) acts and the later is taken back.
 */
async function first(node: P2PNode, space: string, mine: NodeRecord, wait: number): Promise<boolean> {
  if (wait <= 0) return true;
  await new Promise((resolve) => setTimeout(resolve, wait));
  const ran = mine.links.find((l) => l.rel === 'rule')?.to;
  const on = mine.links.find((l) => l.rel === 'about')?.to;
  if (!ran || !on) return true;
  const claims = (await node.records.linked(space, on, { rel: 'about', collection: ruleRun.name })).filter(
    (run) => run.links.some((l) => l.rel === 'rule' && l.to === ran),
  );
  const earliest = [...claims].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key),
  )[0];
  if (!earliest || earliest.key === mine.key) return true;
  await node.records.delete(space, mine.key).catch(() => {});
  return false;
}

/**
 * Runs, once, every rule `account` runs in a space: acts for each record a
 * rule newly holds for, and leaves a run for it. `startRules` calls it when
 * records change; a device can call it itself.
 */
export async function runRules(
  node: P2PNode,
  space: string,
  account: string,
  options: RunRulesOptions = {},
): Promise<void> {
  const collections = await node.collections.list(space);
  const defined = (name: string) => collections.some((c) => c.name === name && c.version !== null);
  if (!defined(rule.name) || !defined(ruleRun.name)) return;
  const access = await node.spaces.access(space).catch(() => undefined);
  const rules = (await rulesFor(node, space, account, access)).filter(
    (r) => r.body.when && (r.body.then.kind !== 'ask' || options.ask),
  );
  if (rules.length === 0) return;
  const busy = options.busy ?? new Set<string>();
  const { by: runs, made } = await runsIn(node, space);
  for (const active of rules) {
    const when = active.body.when!;
    if (!defined(nameOf(when.query.collection))) continue;
    const since = Date.parse(active.body.since);
    for (const match of await matching(node, space, when, account)) {
      const record = match.record;
      const claim = `${active.key} ${record.key}`;
      if (
        match.moment < since ||
        made.has(record.key) ||
        runs.get(active.key)?.has(record.key) ||
        busy.has(claim)
      )
        continue;
      // What the runner's agent, or the bot, wrote itself never sets a rule off: an agent asked to act can't set itself off.
      if (record.createdBy === account && (record.viaAgent || options.bot)) continue;
      if (when.from && !holdsOneOf(access, record.createdBy ?? '', when.from)) continue;
      busy.add(claim);
      try {
        const links = [
          { rel: 'rule', to: active.key },
          { rel: 'about', to: record.key },
        ];
        // Claimed first, so a second look while this acts leaves it alone.
        const run = await node.records.put(
          space,
          ruleRun.name,
          { did: 'Running…', ok: true, at: new Date().toISOString() },
          { links },
        );
        if (!(await first(node, space, run, options.claimMs ?? 0))) continue;
        const trigger = { rule: active, match };
        const done = await act(node, trigger, options);
        if (done.made) made.add(done.made);
        await node.records.update(space, run.key, done, { links });
        options.onRun?.(trigger, done);
      } finally {
        busy.delete(claim);
      }
    }
  }
}

export interface StartRulesOptions extends RunRulesOptions {
  /** The account running them: a person's, for their app or agent, or a bot's own */
  readonly account: string;
  /**
   * Whether rules run at the times they name. An app open now and then leaves
   * that to a runner that is always on. Default true.
   */
  readonly timed?: boolean;
  /** Called with the rules it runs, whenever they change */
  readonly onRules?: (rules: ReadonlyArray<ActiveRule>) => void;
  readonly onError?: (error: unknown) => void;
  /** How often the time is checked against `every`. Default 15 s. */
  readonly tickMs?: number;
  readonly now?: () => Date;
}

/**
 * Runs the rules `account` runs, in every space it follows, until stopped:
 * once at the start, after each change in a space, and at the times rules
 * name. The one loop every runner uses, an app, `weave agent` or a bot.
 * @returns Stops it
 */
export function startRules(node: P2PNode, options: StartRulesOptions): () => void {
  const { account } = options;
  const busy = options.busy ?? new Set<string>();
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let spaces: ReadonlyArray<string> = [];
  const kept = new Map<string, ReadonlyArray<ActiveRule>>();
  let shown: string | null = null;
  let running: Promise<void> | null = null;
  /** Spaces with a change not yet looked at; null means the list of spaces changed */
  const dirty = new Set<string | null>([null]);
  /** The minute each timed rule last ran, so it runs once in it */
  const ranAt = new Map<string, string>();
  const runnable = (r: ActiveRule) => r.body.then.kind !== 'ask' || !!options.ask;

  async function run(): Promise<void> {
    while (dirty.size && !stopped) {
      const changed = [...dirty];
      dirty.clear();
      try {
        if (changed.includes(null)) spaces = (await node.spaces.list()).map((space) => space.id);
        for (const space of kept.keys()) if (!spaces.includes(space)) kept.delete(space);
        const looking = changed.includes(null)
          ? spaces
          : changed.filter((s): s is string => !!s && spaces.includes(s));
        for (const space of looking) {
          if (stopped) return;
          const access = await node.spaces.access(space).catch(() => undefined);
          kept.set(space, (await rulesFor(node, space, account, access)).filter(runnable));
          await runRules(node, space, account, { ...options, busy });
        }
        const all = [...kept.values()].flat();
        const names = all.map((r) => `${r.space}/${r.key}/${r.body.name}`).join();
        if (names !== shown) {
          shown = names;
          options.onRules?.(all);
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  }

  function kick(): void {
    running ??= run().finally(() => {
      running = null;
      if (dirty.size && !stopped) kick();
    });
  }

  const unsubscribe = node.subscribe((event) => {
    if (event.type === 'spaces' || event.type === 'account') dirty.add(null);
    else if (event.type === 'records') dirty.add(spaces.includes(event.space) ? event.space : null);
    else return;
    kick();
  });
  kick();

  const tick =
    options.timed === false
      ? undefined
      : setInterval(() => {
          const at = now();
          const minute = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()} ${at.getHours()}:${at.getMinutes()}`;
          for (const active of [...kept.values()].flat()) {
            const every = active.body.every;
            const id = `${active.space}/${active.key}`;
            if (!every || ranAt.get(id) === minute || !cronMatches(every, at)) continue;
            ranAt.set(id, minute);
            const trigger = { rule: active, at };
            void act(node, trigger, options).then(
              (done) => options.onRun?.(trigger, done),
              (error: unknown) => options.onError?.(error),
            );
          }
        }, options.tickMs ?? 15_000);

  return () => {
    stopped = true;
    if (tick) clearInterval(tick);
    unsubscribe();
  };
}
