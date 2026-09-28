/**
 * @module schemas/apps
 * An app as a record: a title, and the collections it needs.
 *
 * Someone — often an agent — proposes a way of working together by writing
 * one `std.app` record. Nothing is defined yet, so a proposal can't break
 * anything. A person allowed to define collections reads what it would do
 * (in sentences worked out from its rules, `describeCollection`) and adds it:
 * their node defines each collection, signed by them. From then on every app
 * that draws a space from its definitions shows it, with nothing deployed.
 *
 * An agent can propose but never add: every peer ignores definitions signed
 * under an agent's note (see `identity/agent-note.ts`).
 *
 * A changed app is a new proposal that names the one it `updates`. Once the
 * update is added, the app it replaced is superseded: it would only undo the
 * update, so it is not offered again.
 */
import type { DefineCollection, NodeCollection, NodeRecord, P2PNode } from '../node/types.js';
import type { Typed } from '../query/types.js';
import type { JsonSchema } from '../schema/collection-def.js';
import { checkStoredCollection, isStoredCollection, toJsonSchema } from '../schema/collection-def.js';
import { standardDefinition } from './standard.js';
import { isObject } from '../utils/guards.js';
import { canonicalize } from '../schema/expression.js';
import type { LinkDeclaration } from '../records/links.js';
import type { CollectionRules } from '../records/rules.js';
import { describeCollection } from '../records/describe.js';
import { checkAppNotify, MAX_PROPOSALS, type AppNotify } from '../space/notify.js';

/** One collection an app needs, as `collections_define` takes it — without a version, which the space decides */
export interface AppDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly schema: JsonSchema;
  readonly history?: 'latest' | 'all';
  readonly links?: Readonly<Record<string, LinkDeclaration>>;
  readonly permissions?: ReadonlyArray<string>;
  readonly rules?: CollectionRules;
  /** Fields whose values keepers can match without reading: `mentions`, `channel` */
  readonly topics?: ReadonlyArray<string>;
  /** Its own screen: one HTML document, run sealed (see `schemas/screens.ts`) */
  readonly screen?: string;
  /** Exact origins that screen may connect to; none keeps it sealed */
  readonly network?: ReadonlyArray<string>;
}

export interface App {
  readonly title: string;
  /** What it is for, in its proposer's words — shown as theirs, never as what it does */
  readonly description?: string;
  readonly needs: ReadonlyArray<AppDefinition>;
  /** Where it was copied from: `<space id>/<record key>` */
  readonly from?: string;
  /** The key of the app in this space that this one is a new version of */
  readonly updates?: string;
  /**
   * What is worth hearing about, in its own collections: "New ride". Offered
   * to each person as subscriptions when they ask; never turned on for them.
   */
  readonly notify?: ReadonlyArray<AppNotify>;
}

/** At most this many collections in one app */
export const MAX_APP_COLLECTIONS = 10;

/** A way of working together that someone proposed: what it's called, and the collections it needs. */
export const app: DefineCollection & Typed<App> = {
  name: 'std.app',
  title: 'App',
  description: 'A way of working together: what it is called, and the collections it needs, not yet added.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      needs: { type: 'array', minItems: 1, maxItems: MAX_APP_COLLECTIONS, items: { type: 'object' } },
      from: { type: 'string', maxLength: 300 },
      updates: { type: 'string', minLength: 1, maxLength: 100 },
      notify: { type: 'array', minItems: 1, maxItems: MAX_PROPOSALS, items: { type: 'object' } },
    },
    required: ['title', 'needs'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
};

/** Why this can't be an app, or null when it can */
export function checkApp(value: unknown): string | null {
  if (!isObject(value)) return 'An app must be an object';
  const body = value;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100)
    return 'An app needs a title of 1–100 characters';
  if (
    body.description !== undefined &&
    (typeof body.description !== 'string' || body.description.length > 1000)
  ) {
    return "An app's description is at most 1000 characters";
  }
  if (
    body.updates !== undefined &&
    (typeof body.updates !== 'string' || !body.updates || body.updates.length > 100)
  ) {
    return 'An app\'s "updates" is the key of the app it replaces';
  }
  if (!Array.isArray(body.needs) || body.needs.length === 0 || body.needs.length > MAX_APP_COLLECTIONS) {
    return `An app needs 1–${MAX_APP_COLLECTIONS} collections`;
  }
  const needs: unknown[] = body.needs;
  const names = new Set<string>();
  for (const [index, need] of needs.entries()) {
    const at = `needs[${index}]`;
    if (!isObject(need)) return `${at} must be a collection definition`;
    if (typeof need.name === 'string' && need.name.startsWith('sys.'))
      return `${at}: sys.* collections are the protocol's own`;
    if ('version' in need) return `${at}: leave out "version" — the space decides it when the app is added`;
    const stored = { ...need, version: 1 };
    if (!isStoredCollection(stored)) return `${at}: ${checkStoredCollection(stored)}`;
    if (names.has(stored.name)) return `${at}: ${stored.name} is listed twice`;
    names.add(stored.name);
    try {
      describeCollection(stored);
    } catch (error) {
      return `${at}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (body.notify !== undefined) {
    if (!Array.isArray(body.notify) || body.notify.length === 0 || body.notify.length > MAX_PROPOSALS)
      return `An app's notify lists 1–${MAX_PROPOSALS} things worth hearing about`;
    const notify: unknown[] = body.notify;
    for (const [index, entry] of notify.entries()) {
      const problem = checkAppNotify(entry);
      if (problem) return `notify[${index}]: ${problem}`;
      if (isObject(entry) && typeof entry.collection === 'string' && !names.has(entry.collection))
        return `notify[${index}]: ${entry.collection} is not one of the app's needs`;
    }
  }
  return null;
}

/**
 * An app's needs as an agent gives them: each a definition, or the name of a
 * standard one (`"std.poll"`) to use exactly as the library has it. A `std.*`
 * name means the standard thing, so a definition that names one must be the
 * library's — only its `screen`, `network`, `title` and `description` may be
 * the app's own. Throws saying which need is wrong and what to do instead.
 */
export function standardNeeds(needs: unknown): unknown {
  if (!Array.isArray(needs)) return needs;
  const given: unknown[] = needs;
  return given.map((need, index) => {
    const at = `needs[${index}]`;
    const name = typeof need === 'string' ? need : isObject(need) ? need.name : undefined;
    if (typeof name !== 'string' || !name.startsWith('std.')) return need;
    const standard = standardDefinition(name);
    if (!standard) {
      throw new Error(
        `${at}: ${name} is not in the standard library, and std.* names are only its. ` +
          'Name a collection of your own after your app, like "carpool.ride".',
      );
    }
    const library: AppDefinition = {
      name: standard.name,
      schema: toJsonSchema(standard.schema),
      ...(standard.title !== undefined ? { title: standard.title } : {}),
      ...(standard.description !== undefined ? { description: standard.description } : {}),
      ...(standard.history !== undefined ? { history: standard.history } : {}),
      ...(standard.links !== undefined ? { links: standard.links } : {}),
      ...(standard.permissions !== undefined ? { permissions: standard.permissions } : {}),
      ...(standard.rules !== undefined ? { rules: standard.rules } : {}),
      ...(standard.topics !== undefined ? { topics: standard.topics } : {}),
    };
    if (typeof need === 'string') return library;
    if (!isObject(need)) return need;
    const theirs = essence({
      schema: need.schema,
      history: typeof need.history === 'string' ? need.history : undefined,
      links: need.links,
      permissions: Array.isArray(need.permissions)
        ? need.permissions.filter((p): p is string => typeof p === 'string')
        : undefined,
      rules: need.rules,
      topics: Array.isArray(need.topics)
        ? need.topics.filter((t): t is string => typeof t === 'string')
        : undefined,
    });
    const ours = essence(library);
    const same = (['schema', 'history', 'links', 'permissions', 'rules', 'topics'] as const).every(
      (part) => theirs[part] === ours[part],
    );
    if (!same) {
      throw new Error(
        `${at}: ${name} is the standard ${standard.title ?? name}, and this is a different shape. ` +
          `Pass "${name}" to use it as it is, or name your own after your app.`,
      );
    }
    return { ...need, ...library, ...pick(need, ['title', 'description', 'screen', 'network']) };
  });
}

const pick = (from: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

/** What adding one collection would do in a space */
export interface AppNeedReview {
  readonly definition: AppDefinition;
  /** `new`: not in the space yet. `same`: already there, as is. `change`: there, and this would change it. */
  readonly status: 'new' | 'same' | 'change';
  /** What it allows, from its rules — never from its description */
  readonly summary: ReadonlyArray<string>;
  /** For a change: what would be different, in words */
  readonly changes: ReadonlyArray<string>;
  /**
   * For a change: the titles of the apps in use that need this collection as
   * the space has it now, which the change could break. Empty when the review
   * was not given the space's apps.
   */
  readonly usedBy: ReadonlyArray<string>;
}

/** The space's apps, so a review can say which of them a change would touch */
export interface ReviewContext {
  /** Every app record in the space */
  readonly apps: ReadonlyArray<NodeRecord<App>>;
  /** The key of the app under review, when it is already a record, so it doesn't count itself */
  readonly key?: string;
}

export interface AppReview {
  readonly needs: ReadonlyArray<AppNeedReview>;
  /** Every collection it needs is in the space, as it says */
  readonly added: boolean;
  /** Why it can't be added as it stands, or null */
  readonly problem: string | null;
}

/** The parts of a definition that decide what it is, in one comparable form */
function essence(definition: {
  title?: string | undefined;
  description?: string | undefined;
  schema: unknown;
  history?: string | undefined;
  links?: unknown;
  permissions?: ReadonlyArray<string> | undefined;
  rules?: unknown;
  topics?: ReadonlyArray<string> | undefined;
  screen?: string | undefined;
  network?: ReadonlyArray<string> | undefined;
}) {
  return {
    title: definition.title ?? '',
    description: definition.description ?? '',
    schema: canonicalize(definition.schema ?? null),
    history: definition.history ?? 'latest',
    links: canonicalize(definition.links ?? {}),
    permissions: canonicalize([...(definition.permissions ?? [])].sort()),
    rules: canonicalize(definition.rules ?? {}),
    topics: canonicalize([...(definition.topics ?? [])].sort()),
    screen: definition.screen ?? '',
    network: canonicalize([...(definition.network ?? [])].sort()),
  };
}

const fieldNames = (schema: unknown) =>
  Object.keys((isObject(schema) && isObject(schema.properties) ? schema.properties : null) ?? {});

/** What would change, in words, going from what the space has to what the app says */
function differences(held: NodeCollection, wanted: AppDefinition): string[] {
  const a = essence(held);
  const b = essence(wanted);
  const out: string[] = [];
  const before = new Set(fieldNames(held.schema));
  const after = new Set(fieldNames(wanted.schema));
  const added = [...after].filter((field) => !before.has(field));
  const removed = [...before].filter((field) => !after.has(field));
  if (added.length) out.push(`adds ${added.map((f) => `“${f}”`).join(', ')}`);
  if (removed.length) out.push(`drops ${removed.map((f) => `“${f}”`).join(', ')}`);
  if (!added.length && !removed.length && a.schema !== b.schema) out.push('changes the shape of its fields');
  if (a.rules !== b.rules || a.permissions !== b.permissions) out.push('changes who may do what');
  if (a.links !== b.links) out.push('changes what it points at');
  if (a.topics !== b.topics) out.push('changes what can be matched without reading it');
  if (a.history !== b.history)
    out.push(b.history === 'all' ? 'starts keeping every version' : 'stops keeping old versions');
  if (a.screen !== b.screen)
    out.push(!b.screen ? 'takes its screen away' : !a.screen ? 'gives it a screen' : 'changes its screen');
  if (a.network !== b.network) {
    const before = new Set(held.network ?? []);
    const reached = (wanted.network ?? []).filter((origin) => !before.has(origin));
    out.push(
      reached.length ? `lets its screen reach ${reached.join(', ')}` : 'lets its screen reach fewer places',
    );
  }
  if (a.title !== b.title || a.description !== b.description) out.push('renames or redescribes it');
  return out;
}

/** The screen an app brings, if any: the first of its collections that carries one, and where it may connect */
export function appScreen(
  body: App,
): { readonly collection: string; readonly screen: string; readonly network: ReadonlyArray<string> } | null {
  const found = body.needs.find((need) => typeof need.screen === 'string' && need.screen.trim());
  return found ? { collection: found.name, screen: found.screen!, network: found.network ?? [] } : null;
}

/**
 * What adding an app would do in a space: which of its collections are new,
 * already there, or would change one that is — each with what it allows.
 */
export function reviewApp(
  body: App,
  collections: ReadonlyArray<NodeCollection>,
  context?: ReviewContext,
): AppReview {
  const problem = checkApp(body);
  if (problem) return { needs: [], added: false, problem };
  const byName = new Map(collections.filter((c) => c.version !== null).map((c) => [c.name, c]));
  const inUse = context ? appsInUse(context.apps, collections, [context.key, body.updates]) : [];
  const needs = body.needs.map((definition): AppNeedReview => {
    const summary = describeCollection(definition);
    const held = byName.get(definition.name);
    if (!held) return { definition, status: 'new', summary, changes: [], usedBy: [] };
    const changes = metByLibrary(held, definition) ? [] : differences(held, definition);
    const usedBy = changes.length
      ? inUse
          .filter((other) => other.needs.some((need) => need.name === definition.name))
          .map((other) => other.title)
      : [];
    return { definition, status: changes.length ? 'change' : 'same', summary, changes, usedBy };
  });
  return { needs, added: needs.every((need) => need.status === 'same'), problem: null };
}

/**
 * Whether a standard need is met by what the space holds because the space
 * holds the library's current definition of it. The library only adds to
 * its definitions, so an app made against an earlier one still works with
 * it, and offering the earlier one back would only take the additions away.
 * The app's own screen still has to be the one the space has.
 */
function metByLibrary(held: NodeCollection, wanted: AppDefinition): boolean {
  if (!wanted.name.startsWith('std.')) return false;
  const standard = standardDefinition(wanted.name);
  if (!standard) return false;
  const library = essence({ ...standard, schema: toJsonSchema(standard.schema) });
  const space = essence(held);
  const app = essence(wanted);
  return (
    (['schema', 'history', 'links', 'permissions', 'rules', 'topics'] as const).every(
      (part) => space[part] === library[part],
    ) && (['screen', 'network'] as const).every((part) => space[part] === app[part])
  );
}

/** The apps added and not replaced since, leaving out the ones named in `except` */
function appsInUse(
  records: ReadonlyArray<NodeRecord<App>>,
  collections: ReadonlyArray<NodeCollection>,
  except: ReadonlyArray<string | undefined>,
): ReadonlyArray<App> {
  const superseded = supersededApps(records, collections);
  return records.flatMap((record) =>
    record.body &&
    !except.includes(record.key) &&
    !superseded.has(record.key) &&
    reviewApp(record.body, collections).added
      ? [record.body]
      : [],
  );
}

/**
 * The apps a newer version has replaced: each one that an added app
 * `updates`, and, through it, each one that app replaced in turn. Adding one
 * of these would only undo the update.
 */
export function supersededApps(
  records: ReadonlyArray<NodeRecord<App>>,
  collections: ReadonlyArray<NodeCollection>,
): ReadonlySet<string> {
  const replaces = new Map<string, string>();
  for (const record of records) {
    if (record.body?.updates && record.body.updates !== record.key)
      replaces.set(record.key, record.body.updates);
  }
  const superseded = new Set<string>();
  for (const record of records) {
    if (!record.body || !reviewApp(record.body, collections).added) continue;
    // Walk back from each added app; the guard stops at a loop.
    for (
      let key = replaces.get(record.key);
      key && !superseded.has(key) && key !== record.key;
      key = replaces.get(key)
    )
      superseded.add(key);
  }
  return superseded;
}

/**
 * Proposes an app in a space: one `std.app` record. Anyone in the space may,
 * an agent included; nothing is defined until a person adds it.
 */
export async function proposeApp(node: P2PNode, spaceId: string, body: App): Promise<NodeRecord<App>> {
  const problem = checkApp(body);
  if (problem) throw new Error(problem);
  if (body.updates) {
    const replaced = await node.records.get(spaceId, body.updates);
    if (!replaced || replaced.collection !== app.name)
      throw new Error(`"updates" names no app in this space: ${body.updates}`);
  }
  return node.records.put<App>(spaceId, app.name, body);
}

/**
 * Adds a proposed app: defines each collection it needs that the space
 * doesn't have as it says — new ones, and changes to ones it has. Signed by
 * whoever adds it, so they must be allowed to define collections here; an
 * agent never is.
 */
export async function addApp(node: P2PNode, spaceId: string, key: string): Promise<AppReview> {
  const record = await node.records.get<App>(spaceId, key);
  if (!record?.body || record.collection !== app.name) throw new Error(`No app ${key} in this space`);
  // Knowing std.app itself means its own rules hold from now on: only its proposer edits a proposal.
  const known = await node.collections.list(spaceId);
  if (!known.some((c) => c.name === app.name && c.version !== null))
    await node.collections.define(spaceId, app);
  const review = reviewApp(record.body, known);
  if (review.problem) throw new Error(review.problem);
  const apps = await node.records.list<App>(spaceId, { collection: app.name });
  if (supersededApps(apps, known).has(key))
    throw new Error('A newer version of this app has been added; adding this one would undo it');
  for (const need of review.needs) {
    if (need.status === 'same') continue;
    await node.collections.define(spaceId, need.definition);
  }
  return reviewApp(record.body, await node.collections.list(spaceId));
}

/** Copies an app into another space, as a proposal there — people in that space decide for themselves. */
export async function copyApp(
  node: P2PNode,
  fromSpace: string,
  key: string,
  toSpace: string,
): Promise<NodeRecord<App>> {
  const record = await node.records.get<App>(fromSpace, key);
  if (!record?.body || record.collection !== app.name) throw new Error(`No app ${key} in this space`);
  const { title, description, needs, notify } = record.body;
  return proposeApp(node, toSpace, {
    title,
    ...(description !== undefined ? { description } : {}),
    needs,
    ...(notify !== undefined ? { notify } : {}),
    from: `${fromSpace}/${key}`,
  });
}
