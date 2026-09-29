/**
 * Watches: what the agent does without being asked each time.
 *
 * A `std.watch` record says "when records like this appear or change, or at
 * these times, do that". This follows the account's spaces, keeps the watches
 * the account wrote, and says when one is set off. What to do then is the
 * caller's (`weave agent` runs the model on it).
 *
 * A watch counts only when its current version is the account's own, not
 * written via an agent: an agent may suggest a watch, and the person turns it
 * on by saving it themselves. `viaAgent` is signed into the note the version
 * was written under, so the agent can't leave it out. For the same reason
 * nothing the agent itself wrote sets a watch off, so it can't set itself off.
 *
 * Matching is the query format's (`matches`), on each new version: a task
 * moving to "done" is a new version of the same record. What was already
 * there when a watch was first seen is never news.
 */
import { checkQuery, matches, type Filter, type NodeRecord, type P2PNode } from '@weaveprotocol/core';
import { watch as watchSchema, type Watch } from '@weaveprotocol/core/schemas';
import { isRecord } from './json.js';

/** How many of the newest records of a collection are looked at after each change */
const LOOK_BACK = 50;

/** A watch as it runs: where it is kept, and what it says */
export interface ActiveWatch {
  readonly space: string;
  readonly key: string;
  readonly body: Watch;
}

/** A watch set off: by a record, or by the time */
export interface WatchTrigger {
  readonly watch: ActiveWatch;
  /** The space the record is in */
  readonly space?: string;
  readonly record?: NodeRecord;
  /** When a time set it off */
  readonly at?: Date;
}

const isFilter = (value: unknown): value is Filter =>
  isRecord(value) && checkQuery({ collection: 'any', where: value }) === null;

/** `$me` in a value stands for the account */
export function withMe(value: unknown, account: string): unknown {
  if (value === '$me') return account;
  if (Array.isArray(value)) return value.map((each: unknown) => withMe(each, account));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withMe(v, account)]));
  return value;
}

// --- Cron: five fields, minute hour day month weekday ---

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
] as const;

/** The values one cron field allows, or a reason it can't be read */
function cronField(text: string, min: number, max: number): Set<number> | string {
  const allowed = new Set<number>();
  for (const part of text.split(',')) {
    const found = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!found) return `"${part}" is not a number, a range, * or a step`;
    const [, all, from, to, step] = found;
    const start = all === '*' ? min : Number(from);
    const end = all === '*' ? max : to !== undefined ? Number(to) : step !== undefined ? max : start;
    const by = step !== undefined ? Number(step) : 1;
    if (start < min || end > max || start > end || by < 1) return `"${part}" is outside ${min}–${max}`;
    for (let value = start; value <= end; value += by) allowed.add(value);
  }
  return allowed;
}

/** Why a cron expression can't be read, or null */
export function checkCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return 'A schedule is five fields: minute hour day month weekday';
  for (const [index, field] of CRON_FIELDS.entries()) {
    const read = cronField(parts[index] ?? '', field.min, field.max);
    if (typeof read === 'string') return `${field.name}: ${read}`;
  }
  return null;
}

/** Whether a cron expression names this minute, in local time. As in cron, a day and a weekday both given means either. */
export function cronMatches(expression: string, at: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const sets = CRON_FIELDS.map((field, index) => cronField(parts[index] ?? '', field.min, field.max));
  const [minute, hour, day, month, weekday] = sets;
  if (!(minute instanceof Set && hour instanceof Set && day instanceof Set && month instanceof Set))
    return false;
  if (!(weekday instanceof Set)) return false;
  if (weekday.has(7)) weekday.add(0);
  if (!minute.has(at.getMinutes()) || !hour.has(at.getHours()) || !month.has(at.getMonth() + 1)) return false;
  const anyDay = parts[2] === '*';
  const anyWeekday = parts[4] === '*';
  const onDay = day.has(at.getDate());
  const onWeekday = weekday.has(at.getDay());
  if (anyDay && anyWeekday) return true;
  if (anyDay) return onWeekday;
  if (anyWeekday) return onDay;
  return onDay || onWeekday;
}

// --- Which watches count ---

/** A watch body that can run: a name, something to do, and a query or a schedule that can be read */
function runnable(body: unknown): body is Watch {
  if (!isRecord(body) || typeof body.name !== 'string' || typeof body.do !== 'string' || !body.do)
    return false;
  if (body.paused === true) return false;
  const query = body.query;
  const queryOk = isRecord(query) && checkQuery(query) === null;
  const everyOk = typeof body.every === 'string' && checkCron(body.every) === null;
  return queryOk || everyOk;
}

/** The watches in one space that count: the account's own, not via an agent, and not paused */
async function watchesIn(node: P2PNode, space: string, account: string): Promise<ActiveWatch[]> {
  const records = await node.records.list(space, { collection: watchSchema.name });
  return records
    .filter((record) => record.verified && !record.deleted && record.root === account && !record.viaAgent)
    .flatMap((record) => (runnable(record.body) ? [{ space, key: record.key, body: record.body }] : []));
}

/** The watches in a space an agent wrote, waiting for the person to save them */
export async function suggestedIn(node: P2PNode, space: string, account: string): Promise<number> {
  const records = await node.records.list(space, { collection: watchSchema.name });
  return records.filter((record) => !record.deleted && record.root === account && record.viaAgent).length;
}

export interface WatchingOptions {
  readonly node: P2PNode;
  /** The account the agent acts for */
  readonly account: string;
  readonly onTrigger: (trigger: WatchTrigger) => void;
  readonly onError?: (error: unknown) => void;
  /** Called with the watches that count, whenever they change */
  readonly onWatches?: (watches: ReadonlyArray<ActiveWatch>) => void;
  /** How often the time is checked against schedules. Default 15 s. */
  readonly tickMs?: number;
  readonly now?: () => Date;
}

/**
 * Starts following the account's spaces for the watches it wrote.
 * @returns Stops it
 */
export function startWatching(options: WatchingOptions): () => void {
  const { node, account } = options;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let spaces = new Set<string>();
  const kept = new Map<string, ActiveWatch[]>();
  let watches: ActiveWatch[] = [];
  /** The seq last seen of each record, by space and collection: a higher one is news */
  const seen = new Map<string, Map<string, number>>();
  /** Spaces with a change not yet looked at; null means the list of spaces changed */
  const dirty = new Set<string | null>([null]);
  /** The minute each schedule last ran, so it runs once in it */
  const ranAt = new Map<string, string>();
  let running: Promise<void> | null = null;

  const covers = (watch: ActiveWatch, space: string) =>
    !watch.body.spaces || watch.body.spaces.includes(space);
  const collectionsIn = (space: string) =>
    new Set(watches.flatMap((w) => (w.body.query && covers(w, space) ? [w.body.query.collection] : [])));

  async function look(space: string, collection: string): Promise<void> {
    const where = `${space}\n${collection}`;
    const first = !seen.has(where);
    const known = seen.get(where) ?? new Map<string, number>();
    seen.set(where, known);
    const records = await node.records.list(space, { collection, newestFirst: true, limit: LOOK_BACK });
    for (const record of records) {
      const before = known.get(record.key);
      if (before !== undefined && before >= record.seq) continue;
      known.set(record.key, record.seq);
      // Never news: what was there first, what was deleted, and what the agent did itself.
      if (first || record.deleted || !record.verified) continue;
      if (record.viaAgent && record.root === account) continue;
      for (const watch of watches) {
        if (stopped) return;
        const query = watch.body.query;
        if (!query || query.collection !== collection || !covers(watch, space)) continue;
        const where = withMe(query.where ?? {}, account);
        if (isFilter(where) && matches(record, where)) options.onTrigger({ watch, space, record });
      }
    }
  }

  function refresh(): void {
    const before = watches.map((w) => `${w.space}/${w.key}`).join();
    watches = [...kept.values()].flat();
    if (watches.map((w) => `${w.space}/${w.key}`).join() !== before) options.onWatches?.(watches);
  }

  async function run(): Promise<void> {
    while (dirty.size && !stopped) {
      const changed = [...dirty];
      dirty.clear();
      try {
        if (changed.includes(null)) {
          spaces = new Set((await node.spaces.list()).map((space) => space.id));
          for (const space of kept.keys()) if (!spaces.has(space)) kept.delete(space);
          for (const space of spaces) kept.set(space, await watchesIn(node, space, account));
        } else {
          for (const space of changed)
            if (space && spaces.has(space)) kept.set(space, await watchesIn(node, space, account));
        }
        refresh();
        const looking = changed.includes(null) ? [...spaces] : changed.filter((s): s is string => !!s);
        // A watch looks at every space it covers, so one saved in one space starts from what is there now in all.
        for (const space of spaces) {
          for (const collection of collectionsIn(space)) {
            if (looking.includes(space) || !seen.has(`${space}\n${collection}`))
              await look(space, collection);
          }
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
    else if (event.type === 'records') dirty.add(spaces.has(event.space) ? event.space : null);
    else return;
    kick();
  });
  kick();

  const tick = setInterval(() => {
    const at = now();
    const minute = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()} ${at.getHours()}:${at.getMinutes()}`;
    for (const watch of watches) {
      const every = watch.body.every;
      const id = `${watch.space}/${watch.key}`;
      if (!every || ranAt.get(id) === minute || !cronMatches(every, at)) continue;
      ranAt.set(id, minute);
      options.onTrigger({ watch, at });
    }
  }, options.tickMs ?? 15_000);

  return () => {
    stopped = true;
    clearInterval(tick);
    unsubscribe();
  };
}

/**
 * What the model is told when a watch is set off: the watch's own words, which
 * are the person's, and what set it off, marked as data (`note`).
 */
export function triggerPrompt(trigger: WatchTrigger, note: string): string {
  const { watch, record, space, at } = trigger;
  const about = `Your watch "${watch.body.name}" (record ${watch.key} in space ${watch.space}) was set off`;
  const cause = record
    ? `${about} by this record in space ${space ?? watch.space}.\n\n${note}\n\n${JSON.stringify(
        {
          collection: record.collection,
          key: record.key,
          author: record.root,
          ...(record.viaAgent ? { viaAgent: true } : {}),
          version: record.seq,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          body: record.body,
          links: record.links,
        },
        null,
        2,
      )}`
    : `${about} by the time: it runs at "${watch.body.every ?? ''}", and it is now ${(at ?? new Date()).toString()}.`;
  return `${cause}\n\nWhat the watch says to do, in the person's words:\n${watch.body.do}`;
}
