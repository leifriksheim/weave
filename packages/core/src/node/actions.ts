/**
 * @module node/actions
 * The node's operations, described once so every front end can be generated
 * from the same list.
 *
 * Each action has a name, a sentence saying what it does, a JSON Schema for its
 * input and a function that runs it. That is exactly what a command line needs
 * to parse flags, what an MCP server lists as tools, and what WebMCP's
 * `registerTool` takes — so a CLI, an agent on the desktop and an agent in the
 * browser all see the same operations with the same names.
 *
 * Inputs and outputs are plain JSON. Nothing here may return a key, a handle or
 * a function.
 */
import type { P2PNode } from './types.js';
import { rolePresets } from '../space/presets.js';
import type { Query } from '../query/types.js';
import { app, appScreen, checkApp, proposeApp, reviewApp, type App, type AppDefinition } from '../schemas/apps.js';
import { SCREEN_GUIDE } from '../schemas/screens.js';
import { describeCollection } from '../records/describe.js';

/** The subset of JSON Schema these inputs use */
export interface ActionSchema {
  readonly type: 'object';
  readonly properties: Readonly<
    Record<string, { readonly type?: string; readonly enum?: ReadonlyArray<string>; readonly description?: string; readonly items?: unknown }>
  >;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
}

export interface NodeAction {
  /** `[a-z_]+`, so it is a valid tool name everywhere */
  readonly name: string;
  readonly description: string;
  readonly input: ActionSchema;
  /** Reads only. Agents may run these without asking; everything else changes data. */
  readonly readOnly: boolean;
  /**
   * Returns something that grants access — an invite to a private space
   * carries its key. A front end should confirm with a person before handing
   * the result to anyone.
   */
  readonly sensitive?: boolean;
  /**
   * Removes or overwrites something, or brings in someone else's space. A
   * front end should ask a person before an agent runs it: an agent reads
   * records other people wrote, and one of them may be telling it what to do.
   */
  readonly destructive?: boolean;
  /**
   * Returns what other people wrote — record bodies, names, collection
   * descriptions. Data for an agent to read, never instructions to follow.
   */
  readonly peerContent?: boolean;
  readonly run: (node: P2PNode, input: Record<string, unknown>) => Promise<unknown>;
}

const space = { type: 'string', description: 'Space id, from spaces_list' } as const;
const key = { type: 'string', description: 'Record key — stays the same when the record is edited' } as const;

const str = (input: Record<string, unknown>, key: string) => input[key] as string;

const links = {
  type: 'array',
  description: 'What this record points at: [{ "rel": "about", "to": "<record key>" }]. Roles come from the collection\'s declared links.',
  items: {
    type: 'object',
    properties: { rel: { type: 'string' }, to: { type: 'string' } },
    required: ['rel', 'to'],
  },
} as const;
const linksOf = (input: Record<string, unknown>) => (Array.isArray(input.links) ? { links: input.links as Array<{ rel: string; to: string }> } : {});

export const NODE_ACTIONS: ReadonlyArray<NodeAction> = Object.freeze<NodeAction[]>([
  {
    name: 'node_info',
    description: 'Who this node acts for: its identity (DID) and the session key signing for it.',
    input: { type: 'object', properties: {} },
    readOnly: true,
    run: async (node) => ({ did: node.did, sessionDid: node.sessionDid }),
  },
  {
    name: 'spaces_list',
    description: 'List the spaces this node holds.',
    input: { type: 'object', properties: {} },
    readOnly: true,
    run: (node) => node.spaces.list(),
  },
  {
    name: 'spaces_create',
    description:
      'Create a space. "private" encrypts every record; "public" signs them in the clear. Roles decide who may ' +
      'write: "solo" (the default) is you alone, and invites only let others read; "team" gives everyone invited ' +
      'the Editor role; "community" has Admin, Moderator and Member.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'public'] },
        roles: { type: 'string', enum: ['solo', 'team', 'community'], description: 'The roles it starts with' },
      },
      required: ['name', 'visibility'],
    },
    readOnly: false,
    run: (node, input) =>
      node.spaces.create({
        name: str(input, 'name'),
        visibility: input.visibility as 'private' | 'public',
        ...rolePresets[input.roles === 'team' || input.roles === 'community' ? input.roles : 'solo'],
      }),
  },
  {
    name: 'spaces_invite',
    description:
      'Create an invite someone else can use to join a space. For a private space the invite contains ' +
      'the space key: anyone holding it can read everything. Unless viewOnly is set, it also gives them a role — ' +
      'the one named, or the lowest below yours. Only share it with the intended person.',
    input: {
      type: 'object',
      properties: {
        space,
        role: { type: 'string', description: 'The role they will hold — see spaces_access' },
        viewOnly: { type: 'boolean', description: 'They can read the space but not change it' },
      },
      required: ['space'],
    },
    readOnly: false,
    sensitive: true,
    run: async (node, input) => ({
      invite: await node.spaces.invite(
        str(input, 'space'),
        input.viewOnly === true ? { write: false } : typeof input.role === 'string' ? { role: input.role } : {},
      ),
    }),
  },
  {
    name: 'spaces_preview_invite',
    description: 'Describe what an invite offers without joining.',
    input: { type: 'object', properties: { invite: { type: 'string' } }, required: ['invite'] },
    readOnly: true,
    run: async (node, input) => node.spaces.preview(str(input, 'invite')),
  },
  {
    name: 'spaces_join',
    description: 'Join a space from an invite or an invite link, storing it (and its key, if private) on this node.',
    input: { type: 'object', properties: { invite: { type: 'string' } }, required: ['invite'] },
    readOnly: false,
    destructive: true,
    run: (node, input) => node.spaces.join(str(input, 'invite')),
  },
  {
    name: 'spaces_leave',
    description: 'Forget a space on this node, with its key. Other members keep their copies.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: false,
    destructive: true,
    run: async (node, input) => {
      await node.spaces.leave(str(input, 'space'));
      return { left: str(input, 'space') };
    },
  },
  {
    name: 'spaces_access',
    description:
      'Who holds what in a space: its roles (highest rank first, each with its permissions), its members by identity ' +
      '(did) and role, its invites, and your own role. You may change people and roles ranked below you.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    run: (node, input) => node.spaces.access(str(input, 'space')),
  },
  {
    name: 'spaces_set_member',
    description:
      'Give someone a role in a space, change it, or take it away (role ""). You may change people ranked below you, ' +
      'give roles up to your own rank, and always remove yourself. Records they wrote that this node has seen stay.',
    input: {
      type: 'object',
      properties: {
        space,
        did: { type: 'string', description: 'Their identity' },
        role: { type: 'string', description: 'The role name, or "" to take their role away' },
      },
      required: ['space', 'did', 'role'],
    },
    readOnly: false,
    destructive: true,
    run: async (node, input) => {
      await node.spaces.setMember(str(input, 'space'), str(input, 'did'), typeof input.role === 'string' && input.role !== '' ? input.role : null);
      return node.spaces.access(str(input, 'space'));
    },
  },
  {
    name: 'spaces_close_invite',
    description: 'Close an invite, by its key from spaces_access. Whoever joined with it before stays.',
    input: { type: 'object', properties: { space, key: { type: 'string' } }, required: ['space', 'key'] },
    readOnly: false,
    destructive: true,
    run: async (node, input) => {
      await node.spaces.closeInvite(str(input, 'space'), str(input, 'key'));
      return node.spaces.access(str(input, 'space'));
    },
  },
  {
    name: 'spaces_status',
    description: 'Connection state, connected peers and data fingerprint for a space.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    run: (node, input) => node.spaces.status(str(input, 'space')),
  },
  {
    name: 'spaces_profiles',
    description:
      'Who is who in a space: the name each person gave, by their identity (did). A record names its author by ' +
      'did in "root" and "createdBy" — look the name up here. Only each person can set their own.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    peerContent: true,
    run: (node, input) => node.spaces.profiles(str(input, 'space')),
  },
  {
    name: 'collections_list',
    description:
      'What a space holds and how it connects: each collection with its title, description, JSON Schema, declared ' +
      'link roles and record count. Read this before writing, to match the shapes and links others use. Common ' +
      'shapes — std.reaction, std.comment, std.tag, std.attachment, std.reference, std.message, std.task, std.column, std.poll, std.vote — appear only once a space defines them.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    peerContent: true,
    run: (node, input) => node.collections.list(str(input, 'space')),
  },
  {
    name: 'collections_define',
    description:
      'Define a collection in a space, so every app and person in it knows its shape. The schema is JSON Schema ' +
      'using only: type, properties, required, items, enum, minimum, maximum, minLength, maxLength, minItems, maxItems, ' +
      'additionalProperties (boolean), title, description. For choices with labels use ' +
      'oneOf: [{ "const": "low", "title": "Low" }, …]. When a value picks from a list in a linked record — a vote\'s choice ' +
      'from its poll\'s options — add "x-choicesFrom": { "rel": "about", "field": "options" } to the field (a number is a ' +
      'position in that list; text is the option itself), so apps can show labels and tallies. Name it reverse-DNS, e.g. "app.trip.expense". ' +
      'Redefining bumps the version; only whoever first defined it, or someone who can manage the space, may. Records are then checked against it when written. ' +
      'An agent acting for someone can\'t define collections: every peer ignores it. Propose an app with apps_propose instead.',
    input: {
      type: 'object',
      properties: {
        space,
        name: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        schema: { type: 'object' },
        version: { type: 'integer' },
        history: { type: 'string', enum: ['latest', 'all'], description: 'Keep every version of its records ("all"), or only the current one' },
        links: {
          type: 'object',
          description:
            'Link roles its records may carry: { "about": { "to": ["app.poll"], "cardinality": "one" } }. "to" is "*" for any collection.',
        },
        permissions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permissions its rules may name, like ["moderate"]. A space\'s roles hold them as "<collection>/<permission>".',
        },
        rules: {
          type: 'object',
          description:
            'What its records allow, enforced by every peer: { "create": "member", "edit": "creator", "delete": ["creator", "can:moderate"], ' +
            '"onePer": ["@author", "link:about"], "fixed": ["options"] }. Who is "member" (anyone holding a role here, the default), ' +
            '"creator" (whoever created that record) or "can:<permission>" (anyone whose role holds one of the permissions declared ' +
            'above). onePer makes at most one record per author + linked record (+ body field): writing again changes it. fixed fields ' +
            'keep their first value.',
        },
        screen: { type: 'string', description: 'Optional: its own screen, one HTML document — read apps_screen_guide first' },
      },
      required: ['space', 'name', 'schema'],
    },
    readOnly: false,
    destructive: true,
    run: async (node, input) => {
      const defined = await node.collections.define(str(input, 'space'), {
        name: str(input, 'name'),
        schema: input.schema as Record<string, unknown>,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.version === 'number' ? { version: input.version } : {}),
        ...(input.history === 'all' || input.history === 'latest' ? { history: input.history } : {}),
        ...(typeof input.links === 'object' && input.links !== null ? { links: input.links as Record<string, never> } : {}),
        ...(Array.isArray(input.permissions) ? { permissions: input.permissions.filter((p): p is string => typeof p === 'string') } : {}),
        ...(typeof input.rules === 'object' && input.rules !== null ? { rules: input.rules as Record<string, never> } : {}),
        ...(typeof input.screen === 'string' ? { screen: input.screen } : {}),
      });
      // What it allows, from its rules — worth repeating to the person as it is.
      return { ...defined, summary: describeCollection({ ...defined, schema: defined.schema ?? undefined }) };
    },
  },
  {
    name: 'apps_list',
    description:
      'The apps proposed in a space: each with its title, who proposed it (viaAgent when an agent did), and for every collection ' +
      'it needs whether it is new, already there, or would change one — with what it allows, worked out from its rules. ' +
      '"added" is true once a person has added it.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    peerContent: true,
    run: async (node, input) => {
      const spaceId = str(input, 'space');
      const collections = await node.collections.list(spaceId);
      const found = await node.records.list<App>(spaceId, { collection: app.name });
      return found.map((record) => {
        const review = record.body ? reviewApp(record.body, collections) : null;
        return {
          key: record.key,
          title: record.body?.title ?? null,
          description: record.body?.description ?? null,
          proposedBy: record.createdBy,
          ...(record.viaAgent ? { viaAgent: true } : {}),
          ...(record.body && appScreen(record.body) ? { screen: appScreen(record.body)!.collection } : {}),
          added: review?.added ?? false,
          problem: review?.problem ?? (record.body ? null : 'It could not be read'),
          needs: review?.needs.map(({ definition, status, summary, changes }) => ({ name: definition.name, status, summary, changes })) ?? [],
        };
      });
    },
  },
  {
    name: 'apps_screen_guide',
    description:
      'How to write a screen — an app\'s own HTML UI, kept on its main collection\'s definition as "screen" and run sealed ' +
      'in the app: what it can use (window.weave: list, put, update, remove, onChange, me) and what it can\'t (network, storage).',
    input: { type: 'object', properties: {} },
    readOnly: true,
    run: async () => SCREEN_GUIDE,
  },
  {
    name: 'apps_propose',
    description:
      'Propose an app in a space: a new way for its people to work together — a carpool, a sign-up sheet, a decision log. ' +
      'Give it a title, a line on what it is for, and the collections it needs, each exactly as collections_define takes it ' +
      '(name, title, description, schema, links, permissions, rules — no version). Nothing is defined yet: everyone in the ' +
      'space sees the proposal, with what it allows worked out from its rules, and a person who may define collections adds it. ' +
      'Read collections_list first and reuse what the space already has (std.poll, std.task…) rather than inventing a twin. ' +
      'For anything plain lists and forms can\'t show — a game board, a calendar, a whiteboard — give the main collection ' +
      'a "screen": its own HTML UI (one document, inline scripts and styles, no network). Inside it, use exactly: ' +
      'weave.me ({ did, name }), await weave.list("<collection>", { where: { "link:<rel>": key } }), ' +
      'await weave.put("<collection>", body, { links: [{ rel, to: key }] }), await weave.update(key, body), await weave.remove(key), ' +
      'weave.onChange(redraw). Records are { key, body, links, createdBy, mine }. Read apps_screen_guide for the rest. ' +
      'Returns what each collection will allow; tell the person that, not your own description.',
    input: {
      type: 'object',
      properties: {
        space,
        title: { type: 'string', description: 'What people will call it, e.g. "Carpool"' },
        description: { type: 'string', description: 'What it is for, in a sentence' },
        needs: {
          type: 'array',
          description: 'Collection definitions, as collections_define takes them — without version',
          items: { type: 'object' },
        },
      },
      required: ['space', 'title', 'needs'],
    },
    readOnly: false,
    run: async (node, input) => {
      const spaceId = str(input, 'space');
      const body: App = {
        title: str(input, 'title'),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        needs: input.needs as ReadonlyArray<AppDefinition>,
      };
      const problem = checkApp(body);
      if (problem) throw new Error(problem);
      const record = await proposeApp(node, spaceId, body);
      const review = reviewApp(body, await node.collections.list(spaceId));
      return {
        key: record.key,
        proposed: true,
        added: false,
        next: 'A person in the space who may define collections adds it from the Apps tab.',
        needs: review.needs.map(({ definition, status, summary, changes }) => ({ name: definition.name, status, summary, changes })),
      };
    },
  },
  {
    name: 'collections_delete',
    description:
      'Remove a collection\'s definition from a space. Refused while it still has records — delete those first. ' +
      'Only whoever first defined it, or someone who can manage the space, may.',
    input: {
      type: 'object',
      properties: { space, name: { type: 'string' } },
      required: ['space', 'name'],
    },
    readOnly: false,
    destructive: true,
    run: (node, input) => node.collections.delete(str(input, 'space'), str(input, 'name')),
  },
  {
    name: 'records_list',
    description: 'List records in a space, oldest first unless newestFirst is set.',
    input: {
      type: 'object',
      properties: {
        space,
        collection: { type: 'string', description: 'Only this collection, e.g. "app.todo.item"' },
        limit: { type: 'integer' },
        newestFirst: { type: 'boolean' },
      },
      required: ['space'],
    },
    readOnly: true,
    peerContent: true,
    run: (node, input) =>
      node.records.list(str(input, 'space'), {
        ...(typeof input.collection === 'string' ? { collection: input.collection } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(input.newestFirst === true ? { newestFirst: true } : {}),
      }),
  },
  {
    name: 'records_query',
    description:
      'Find records: filter, sort, page, and pull in what links to them. ' +
      'where: { done: false, "@author": "did:…", amount: { "$gt": 10 } } — bare names are body fields (dotted for nested), ' +
      '"@key", "@author", "@root", "@createdAt", "@updatedAt", "@seq" are about the record; ' +
      'operators $eq $ne $gt $gte $lt $lte $in $nin $exists $contains, combined with $and $or $not. ' +
      'include: { reactions: { rel: "about", from: "std.reaction", count: true } } — records linking to each result ' +
      '(direction "out" for what each result links to), nested up to 3 deep. ' +
      'sort: { "@createdAt": "desc" }. Pass the returned cursor back to get the next page.',
    input: {
      type: 'object',
      properties: {
        space,
        collection: { type: 'string', description: 'The collection to query, e.g. "app.todo.item"' },
        where: { type: 'object', description: 'Filter' },
        include: { type: 'object', description: 'Linked records to pull in, by name' },
        sort: { type: 'object', description: '{ field: "asc" | "desc" }; ties break on the key' },
        limit: { type: 'integer' },
        cursor: { type: 'string', description: 'From the previous page' },
      },
      required: ['space', 'collection'],
    },
    readOnly: true,
    peerContent: true,
    run: (node, input) => {
      const { space: spaceId, ...query } = input;
      return node.records.query(spaceId as string, query as unknown as Query);
    },
  },
  {
    name: 'records_get',
    description: 'Read one record.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: true,
    peerContent: true,
    run: (node, input) => node.records.get(str(input, 'space'), str(input, 'key')),
  },
  {
    name: 'records_history',
    description:
      'The versions of a record kept here, newest first. Collections defined with history "all" keep every version, ' +
      'each linked to the one before by hash; otherwise only the current and first versions are kept.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: true,
    peerContent: true,
    run: (node, input) => node.records.history(str(input, 'space'), str(input, 'key')),
  },
  {
    name: 'records_put',
    description:
      'Create a record in a collection. Collections are named like "app.todo.item"; the body is any JSON object. ' +
      'It gets a random key unless one is given. It is signed by this node and synced to the space.',
    input: {
      type: 'object',
      properties: {
        space,
        collection: { type: 'string' },
        body: { type: 'object' },
        key: { type: 'string', description: 'Optional chosen key: a–z, 0–9 and : . _ -' },
        links,
      },
      required: ['space', 'collection', 'body'],
    },
    readOnly: false,
    run: (node, input) =>
      node.records.put(str(input, 'space'), str(input, 'collection'), input.body, {
        ...(typeof input.key === 'string' ? { key: input.key } : {}),
        ...linksOf(input),
      }),
  },
  {
    name: 'records_linked',
    description:
      'The records pointing at a record: its reactions, comments, tags, votes… Optionally only one link role ' +
      '(e.g. "about") or one collection (e.g. "std.comment").',
    input: {
      type: 'object',
      properties: { space, key, rel: { type: 'string' }, collection: { type: 'string' } },
      required: ['space', 'key'],
    },
    readOnly: true,
    peerContent: true,
    run: (node, input) =>
      node.records.linked(str(input, 'space'), str(input, 'key'), {
        ...(typeof input.rel === 'string' ? { rel: input.rel } : {}),
        ...(typeof input.collection === 'string' ? { collection: input.collection } : {}),
      }),
  },
  {
    name: 'records_can',
    description:
      'Whether you may do something before trying: "create" in a collection (target = its name), or "edit" / "delete" a record ' +
      '(target = its key). Follows the collection\'s rules and the space\'s.',
    input: {
      type: 'object',
      properties: { space, action: { type: 'string', enum: ['create', 'edit', 'delete'] }, target: { type: 'string' } },
      required: ['space', 'action', 'target'],
    },
    readOnly: true,
    run: (node, input) => node.records.can(str(input, 'space'), str(input, 'action') as 'create' | 'edit' | 'delete', str(input, 'target')),
  },
  {
    name: 'records_update',
    description: 'Write the next version of a record: a new body under the same key. Its links are kept unless given.',
    input: {
      type: 'object',
      properties: { space, key, body: { type: 'object' }, links },
      required: ['space', 'key', 'body'],
    },
    readOnly: false,
    destructive: true,
    run: (node, input) => node.records.update(str(input, 'space'), str(input, 'key'), input.body, linksOf(input)),
  },
  {
    name: 'records_delete',
    description: 'Delete a record for every member of the space. Anyone who may write in the space may delete in it.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: false,
    destructive: true,
    run: async (node, input) => {
      await node.records.delete(str(input, 'space'), str(input, 'key'));
      return { deleted: str(input, 'key') };
    },
  },
]);

/** Why an input does not fit an action's schema, or null when it does. */
export function checkActionInput(action: NodeAction, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Input must be an object';
  const record = input as Record<string, unknown>;
  for (const key of action.input.required ?? []) {
    if (record[key] === undefined) return `Missing "${key}"`;
  }
  for (const [key, value] of Object.entries(record)) {
    const spec = action.input.properties[key];
    if (!spec) return `Unknown field "${key}"`;
    if (spec.enum && !spec.enum.includes(value as string)) return `"${key}" must be one of ${spec.enum.join(', ')}`;
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const expected = spec.type === 'integer' ? 'number' : spec.type;
    if (expected && actual !== expected) return `"${key}" must be ${spec.type === 'object' ? 'an object' : `a ${spec.type}`}`;
    if (spec.type === 'integer' && !Number.isInteger(value)) return `"${key}" must be a whole number`;
  }
  return null;
}

/**
 * Runs an action by name, checking its input first.
 * @throws When the action is unknown or the input does not fit
 */
export async function runAction(node: P2PNode, name: string, input: unknown = {}): Promise<unknown> {
  const action = NODE_ACTIONS.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Unknown action: ${name}`);
  const problem = checkActionInput(action, input);
  if (problem) throw new Error(`${name}: ${problem}`);
  return action.run(node, input as Record<string, unknown>);
}
