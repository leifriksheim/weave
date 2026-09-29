/**
 * What a command still needs, asked for by what it is: a space picked from
 * your spaces, a collection from the space's, a record from its newest, a role
 * from its roles, a person from its members. Anything else is typed. With
 * nobody to ask (`ask.ts`), each missing value fails naming its flag and where
 * to look, so an agent is never left waiting.
 */
import type { NodeAction, P2PNode } from '@weaveprotocol/core';
import * as ask from './ask.js';
import { isRecord } from './json.js';

type Spec = NodeAction['input']['properties'][string];

/** A record, in a few words, for a list to pick it from */
function summary(body: unknown): string {
  if (!isRecord(body)) return '';
  for (const field of ['title', 'name', 'text', 'question', 'label', 'content', 'do']) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return JSON.stringify(body).slice(0, 60);
}

export async function pickSpace(node: P2PNode, message = 'Which space?'): Promise<string> {
  const spaces = await node.spaces.list();
  if (!spaces.length && ask.interactive())
    throw new Error('This account is in no spaces yet. Create one with `weave spaces create`, or join one.');
  return ask.select({
    flag: 'space',
    message,
    hint: 'Its id is in `weave spaces list`.',
    options: spaces.map((space) => ({
      value: space.id,
      label: space.name,
      hint: `${space.visibility}${space.role ? ` · ${space.role}` : ' · can read'}`,
    })),
  });
}

export async function pickCollection(node: P2PNode, space: string): Promise<string> {
  const defined = (await node.collections.list(space)).filter((c) => c.version !== null);
  const other = '\u0000other';
  const picked = await ask.select({
    flag: 'collection',
    message: 'Which collection?',
    hint: `The space's are in \`weave collections list --space ${space}\`.`,
    options: [
      ...defined.map((c) => ({ value: c.name, label: c.title || c.name, hint: c.name })),
      { value: other, label: 'Another…', hint: 'type its name' },
    ],
  });
  return picked === other
    ? ask.text({ flag: 'collection', message: 'Its name', placeholder: 'carpool.ride' })
    : picked;
}

async function pickRecord(node: P2PNode, space: string): Promise<string> {
  const records = await node.records.list(space, { newestFirst: true, limit: 30 });
  return ask.select({
    flag: 'key',
    message: 'Which record?',
    hint: `Keys are in \`weave records list --space ${space}\`.`,
    options: records.map((record) => ({
      value: record.key,
      label: summary(record.body) || record.key,
      hint: record.collection,
    })),
  });
}

async function pickPerson(node: P2PNode, space: string): Promise<string> {
  const [access, profiles] = await Promise.all([node.spaces.access(space), node.spaces.profiles(space)]);
  const name = (did: string) => profiles.find((p) => p.did === did)?.name ?? did.slice(-8);
  return ask.select({
    flag: 'did',
    message: 'Who?',
    hint: `Members are in \`weave spaces access --space ${space}\`.`,
    options: access.members.map((m) => ({ value: m.did, label: name(m.did), hint: m.role })),
  });
}

/** A value for one field, asked for by what it is */
async function askFor(
  node: P2PNode,
  field: string,
  spec: Spec,
  input: Record<string, unknown>,
): Promise<unknown> {
  const space = typeof input.space === 'string' ? input.space : null;
  if (field === 'space') return pickSpace(node);
  if (field === 'collection' && space) return pickCollection(node, space);
  if (field === 'key' && space) return pickRecord(node, space);
  if (field === 'did' && space) return pickPerson(node, space);
  if (spec.enum?.length)
    return ask.select({
      flag: field,
      message: spec.description ?? `Which ${field}?`,
      options: spec.enum.map((value) => ({ value, label: value })),
    });
  if (field === 'role' && space) {
    const access = await node.spaces.access(space);
    return ask.select({
      flag: 'role',
      message: 'Which role?',
      hint: `Roles are in \`weave spaces access --space ${space}\`.`,
      options: access.roles.map((role) => ({ value: role.name, label: role.title ?? role.name })),
    });
  }
  if (spec.type === 'object' || spec.type === 'array') {
    const text = await ask.text({
      flag: field,
      message: `${spec.description ?? field} (JSON)`,
      placeholder: spec.type === 'array' ? '["…"]' : '{"text": "…"}',
      validate: (value) => {
        try {
          JSON.parse(value);
          return undefined;
        } catch {
          return 'That is not JSON';
        }
      },
    });
    return JSON.parse(text);
  }
  return ask.text({
    flag: field,
    message: spec.description ?? field,
    ...(field === 'invite' ? { hint: 'Paste the invite link you were given.' } : {}),
  });
}

/**
 * An invite's role, picked from the roles below yours and "view only":
 * asked at a terminal when neither `--role` nor `--view-only` was given.
 */
async function inviteRole(node: P2PNode, space: string): Promise<Record<string, unknown>> {
  if (!ask.interactive()) return {};
  const access = await node.spaces.access(space);
  const mine = access.role?.rank ?? 0;
  const below = access.roles.filter((role) => role.rank < mine);
  const view = '\u0000view';
  const picked = await ask.select({
    flag: 'role',
    message: 'What may they do?',
    options: [
      ...below.map((role) => ({ value: role.name, label: role.title ?? role.name, hint: 'their role' })),
      { value: view, label: 'Only read it', hint: 'view only' },
    ],
    ...(below.at(-1) ? { initialValue: below.at(-1)!.name } : {}),
  });
  return picked === view ? { viewOnly: true } : { role: picked };
}

/** An action's input with everything it requires, asked for at a terminal, or refused naming each flag */
export async function completeInput(
  node: P2PNode,
  action: NodeAction,
  given: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = { ...given };
  const required = action.input.required ?? [];
  for (const [field, spec] of Object.entries(action.input.properties)) {
    if (input[field] !== undefined || !required.includes(field)) continue;
    input[field] = await askFor(node, field, spec, input);
  }
  if (action.name === 'spaces_invite' && input.role === undefined && input.viewOnly === undefined)
    Object.assign(input, await inviteRole(node, String(input.space)));
  return input;
}
