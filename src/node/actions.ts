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
      'Create a space. "personal" takes writes from its owner only, "shared" from anyone invited. ' +
      '"private" encrypts every record; "public" signs them in the clear.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['personal', 'shared'] },
        visibility: { type: 'string', enum: ['private', 'public'] },
      },
      required: ['name', 'type', 'visibility'],
    },
    readOnly: false,
    run: (node, input) =>
      node.spaces.create({
        name: str(input, 'name'),
        type: input.type as 'personal' | 'shared',
        visibility: input.visibility as 'private' | 'public',
      }),
  },
  {
    name: 'spaces_invite',
    description:
      'Create an invite someone else can use to join a space. For a private space the invite contains ' +
      'the space key: anyone holding it can read everything. Only share it with the intended person.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: false,
    sensitive: true,
    run: async (node, input) => ({ invite: await node.spaces.invite(str(input, 'space')) }),
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
    run: (node, input) => node.spaces.join(str(input, 'invite')),
  },
  {
    name: 'spaces_leave',
    description: 'Forget a space on this node, with its key. Other members keep their copies.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: false,
    run: async (node, input) => {
      await node.spaces.leave(str(input, 'space'));
      return { left: str(input, 'space') };
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
    name: 'collections_list',
    description:
      'What a space holds and how it connects: each collection with its title, description, JSON Schema, declared ' +
      'link roles and record count — including the built-in sys.* annotations (reaction, comment, tag, attachment, ' +
      'reference) that attach to any record. Read this before writing, to match the shapes and links others use.',
    input: { type: 'object', properties: { space }, required: ['space'] },
    readOnly: true,
    run: (node, input) => node.collections.list(str(input, 'space')),
  },
  {
    name: 'collections_define',
    description:
      'Define a collection in a space, so every app and person in it knows its shape. The schema is JSON Schema ' +
      'using only: type, properties, required, items, enum, minimum, maximum, minLength, maxLength, ' +
      'additionalProperties (boolean), title, description. Name it reverse-DNS, e.g. "app.trip.expense". ' +
      'Redefining bumps the version; only whoever first defined it, or the space owner, may. Records are then checked against it when written.',
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
      },
      required: ['space', 'name', 'schema'],
    },
    readOnly: false,
    run: (node, input) =>
      node.collections.define(str(input, 'space'), {
        name: str(input, 'name'),
        schema: input.schema as Record<string, unknown>,
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.version === 'number' ? { version: input.version } : {}),
        ...(input.history === 'all' || input.history === 'latest' ? { history: input.history } : {}),
        ...(typeof input.links === 'object' && input.links !== null ? { links: input.links as Record<string, never> } : {}),
      }),
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
    run: (node, input) =>
      node.records.list(str(input, 'space'), {
        ...(typeof input.collection === 'string' ? { collection: input.collection } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        ...(input.newestFirst === true ? { newestFirst: true } : {}),
      }),
  },
  {
    name: 'records_get',
    description: 'Read one record.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: true,
    run: (node, input) => node.records.get(str(input, 'space'), str(input, 'key')),
  },
  {
    name: 'records_history',
    description:
      'The versions of a record kept here, newest first. Collections defined with history "all" keep every version, ' +
      'each linked to the one before by hash; otherwise only the current and first versions are kept.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: true,
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
      '(e.g. "about") or one collection (e.g. "sys.comment").',
    input: {
      type: 'object',
      properties: { space, key, rel: { type: 'string' }, collection: { type: 'string' } },
      required: ['space', 'key'],
    },
    readOnly: true,
    run: (node, input) =>
      node.records.linked(str(input, 'space'), str(input, 'key'), {
        ...(typeof input.rel === 'string' ? { rel: input.rel } : {}),
        ...(typeof input.collection === 'string' ? { collection: input.collection } : {}),
      }),
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
    run: (node, input) => node.records.update(str(input, 'space'), str(input, 'key'), input.body, linksOf(input)),
  },
  {
    name: 'records_delete',
    description: 'Delete a record for every member of the space. Anyone who may write in the space may delete in it.',
    input: { type: 'object', properties: { space, key }, required: ['space', 'key'] },
    readOnly: false,
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
