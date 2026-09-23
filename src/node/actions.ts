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
  readonly properties: Readonly<Record<string, { readonly type?: string; readonly enum?: ReadonlyArray<string>; readonly description?: string }>>;
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
const id = { type: 'string', description: 'Record id' } as const;

const str = (input: Record<string, unknown>, key: string) => input[key] as string;

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
    description: 'Join a space from an invite, storing it (and its key, if private) on this node.',
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
    input: { type: 'object', properties: { space, id }, required: ['space', 'id'] },
    readOnly: true,
    run: (node, input) => node.records.get(str(input, 'space'), str(input, 'id')),
  },
  {
    name: 'records_put',
    description:
      'Write a new record into a collection. Collections are named like "app.todo.item"; ' +
      'the body is any JSON object. It is signed by this node and synced to the space.',
    input: {
      type: 'object',
      properties: { space, collection: { type: 'string' }, body: { type: 'object' } },
      required: ['space', 'collection', 'body'],
    },
    readOnly: false,
    run: (node, input) => node.records.put(str(input, 'space'), str(input, 'collection'), input.body),
  },
  {
    name: 'records_update',
    description: 'Replace a record with a new body. The result has a new id; the old record is deleted.',
    input: {
      type: 'object',
      properties: { space, id, body: { type: 'object' } },
      required: ['space', 'id', 'body'],
    },
    readOnly: false,
    run: (node, input) => node.records.update(str(input, 'space'), str(input, 'id'), input.body),
  },
  {
    name: 'records_delete',
    description: 'Delete a record for every member of the space. Only its author or the space owner can.',
    input: { type: 'object', properties: { space, id }, required: ['space', 'id'] },
    readOnly: false,
    run: async (node, input) => {
      await node.records.delete(str(input, 'space'), str(input, 'id'));
      return { deleted: str(input, 'id') };
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
