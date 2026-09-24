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
 */
import type { DefineCollection, NodeCollection, NodeRecord, P2PNode } from '../node/types.js';
import type { Typed } from '../query/types.js';
import type { JsonSchema } from '../schema/collection-def.js';
import { checkStoredCollection } from '../schema/collection-def.js';
import { canonicalize } from '../schema/expression.js';
import type { LinkDeclaration } from '../records/links.js';
import type { CollectionRules } from '../records/rules.js';
import { describeCollection } from '../records/describe.js';

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
  /** Its own screen: one HTML document, run sealed (see `schemas/screens.ts`) */
  readonly screen?: string;
}

export interface App {
  readonly title: string;
  /** What it is for, in its proposer's words — shown as theirs, never as what it does */
  readonly description?: string;
  readonly needs: ReadonlyArray<AppDefinition>;
  /** Where it was copied from: `<space id>/<record key>` */
  readonly from?: string;
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
    },
    required: ['title', 'needs'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
};

/** Why this can't be an app, or null when it can */
export function checkApp(value: unknown): string | null {
  const body = value as Partial<App> | null;
  if (!body || typeof body !== 'object') return 'An app must be an object';
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100) return 'An app needs a title of 1–100 characters';
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) {
    return 'An app\'s description is at most 1000 characters';
  }
  if (!Array.isArray(body.needs) || body.needs.length === 0 || body.needs.length > MAX_APP_COLLECTIONS) {
    return `An app needs 1–${MAX_APP_COLLECTIONS} collections`;
  }
  const names = new Set<string>();
  for (const [index, need] of body.needs.entries()) {
    const at = `needs[${index}]`;
    if (!need || typeof need !== 'object') return `${at} must be a collection definition`;
    if (typeof need.name === 'string' && need.name.startsWith('sys.')) return `${at}: sys.* collections are the protocol's own`;
    if ('version' in need) return `${at}: leave out "version" — the space decides it when the app is added`;
    const problem = checkStoredCollection({ ...need, version: 1 });
    if (problem) return `${at}: ${problem}`;
    if (names.has(need.name)) return `${at}: ${need.name} is listed twice`;
    names.add(need.name);
    try {
      describeCollection(need);
    } catch (error) {
      return `${at}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/** What adding one collection would do in a space */
export interface AppNeedReview {
  readonly definition: AppDefinition;
  /** `new`: not in the space yet. `same`: already there, as is. `change`: there, and this would change it. */
  readonly status: 'new' | 'same' | 'change';
  /** What it allows, from its rules — never from its description */
  readonly summary: ReadonlyArray<string>;
  /** For a change: what would be different, in words */
  readonly changes: ReadonlyArray<string>;
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
  screen?: string | undefined;
}) {
  return {
    title: definition.title ?? '',
    description: definition.description ?? '',
    schema: canonicalize(definition.schema ?? null),
    history: definition.history ?? 'latest',
    links: canonicalize(definition.links ?? {}),
    permissions: canonicalize([...(definition.permissions ?? [])].sort()),
    rules: canonicalize(definition.rules ?? {}),
    screen: definition.screen ?? '',
  };
}

const fieldNames = (schema: unknown) => Object.keys((schema as { properties?: Record<string, unknown> } | null)?.properties ?? {});

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
  if (a.history !== b.history) out.push(b.history === 'all' ? 'starts keeping every version' : 'stops keeping old versions');
  if (a.screen !== b.screen) out.push(!b.screen ? 'takes its screen away' : !a.screen ? 'gives it a screen' : 'changes its screen');
  if (a.title !== b.title || a.description !== b.description) out.push('renames or redescribes it');
  return out;
}

/** The screen an app brings, if any: the first of its collections that carries one */
export function appScreen(body: App): { readonly collection: string; readonly screen: string } | null {
  const found = body.needs.find((need) => typeof need.screen === 'string' && need.screen.trim());
  return found ? { collection: found.name, screen: found.screen! } : null;
}

/**
 * What adding an app would do in a space: which of its collections are new,
 * already there, or would change one that is — each with what it allows.
 */
export function reviewApp(body: App, collections: ReadonlyArray<NodeCollection>): AppReview {
  const problem = checkApp(body);
  if (problem) return { needs: [], added: false, problem };
  const byName = new Map(collections.filter((c) => c.version !== null).map((c) => [c.name, c]));
  const needs = body.needs.map((definition): AppNeedReview => {
    const summary = describeCollection(definition);
    const held = byName.get(definition.name);
    if (!held) return { definition, status: 'new', summary, changes: [] };
    const changes = differences(held, definition);
    return { definition, status: changes.length ? 'change' : 'same', summary, changes };
  });
  return { needs, added: needs.every((need) => need.status === 'same'), problem: null };
}

/**
 * Proposes an app in a space: one `std.app` record. Anyone in the space may,
 * an agent included; nothing is defined until a person adds it.
 */
export async function proposeApp(node: P2PNode, spaceId: string, body: App): Promise<NodeRecord<App>> {
  const problem = checkApp(body);
  if (problem) throw new Error(problem);
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
  if (!known.some((c) => c.name === app.name && c.version !== null)) await node.collections.define(spaceId, app);
  const review = reviewApp(record.body, known);
  if (review.problem) throw new Error(review.problem);
  for (const need of review.needs) {
    if (need.status === 'same') continue;
    await node.collections.define(spaceId, need.definition);
  }
  return reviewApp(record.body, await node.collections.list(spaceId));
}

/** Copies an app into another space, as a proposal there — people in that space decide for themselves. */
export async function copyApp(node: P2PNode, fromSpace: string, key: string, toSpace: string): Promise<NodeRecord<App>> {
  const record = await node.records.get<App>(fromSpace, key);
  if (!record?.body || record.collection !== app.name) throw new Error(`No app ${key} in this space`);
  const { title, description, needs } = record.body;
  return proposeApp(node, toSpace, { title, ...(description !== undefined ? { description } : {}), needs, from: `${fromSpace}/${key}` });
}
