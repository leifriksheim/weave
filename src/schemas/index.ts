/**
 * @module schemas
 * A standard library of well-known record shapes — reactions, comments, tags,
 * attachments, references. Optional, and nothing special: the protocol knows
 * none of them. Each is an ordinary collection definition, and a space learns
 * one the same way it learns any other, when someone defines it there:
 *
 * ```ts
 * import { reaction, comment, useSchemas } from '@weaveprotocol/core/schemas';
 *
 * await useSchemas(node, space.id, [reaction, comment]);
 * await node.records.put(space.id, reaction, { emoji: '👍' }, {
 *   links: [{ rel: 'about', to: post.key }],
 * });
 * ```
 *
 * The point of sharing them is agreement, not privilege: two apps that both
 * use `std.reaction` see each other's reactions. An app that prefers its own
 * shape defines its own collection instead, and loses nothing but that.
 *
 * **Two kinds.** Most of these are annotations: they attach to anything
 * (their links point at `'*'`). A few are common nouns — a chat message, a
 * task on a board, a poll — shared so that two chat apps, or a board and a to-do list,
 * read the same records. Nouns say exactly what they point at. Keep both lists
 * small — each entry is only worth it if nearly every app would otherwise
 * invent the same thing.
 *
 * Nouns that keep a hand-made order carry a `position`: a string that sorts
 * where the record goes. {@link positionBetween} makes one between two others,
 * so moving a card rewrites only that card, and two people moving cards at
 * once never renumber each other's. It is optional, so a record made by
 * something that knows nothing of order still counts: it goes at the end.
 */
import type { DefineCollection, P2PNode } from '../node/types.js';
import type { Typed } from '../query/types.js';

/**
 * A definition that also carries its records' type, so querying or writing
 * with it is typed — `include: { votes: { rel: 'about', from: vote } }` gives
 * votes as `Vote`. The schemas here are plain JSON Schema, so the type is said
 * alongside rather than worked out.
 */
const typed =
  <T>() =>
  <const C extends DefineCollection>(definition: C): C & Typed<T> =>
    definition;
import type { LinkDeclaration } from '../records/links.js';

const about = (description: string): LinkDeclaration => ({ to: '*', cardinality: 'one', description });

/** An emoji reaction to any record. Link it: `{ rel: 'about', to: <key> }`. */
export const reaction = typed<Reaction>()({
  name: 'std.reaction',
  title: 'Reaction',
  description: 'An emoji reaction to any record.',
  schema: { type: 'object', properties: { emoji: { type: 'string', minLength: 1, maxLength: 16 } }, required: ['emoji'] },
  links: { about: about('The record reacted to') },
  // One of each emoji per person per record; only yours to take back.
  rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about', 'emoji'] },
});
export interface Reaction {
  readonly emoji: string;
}

/** A comment on any record, optionally a reply to another comment. */
export const comment = typed<Comment>()({
  name: 'std.comment',
  title: 'Comment',
  description: 'A comment on any record, optionally replying to another comment.',
  schema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['text'] },
  links: {
    about: about('The record commented on'),
    replyTo: { to: ['std.comment'], cardinality: 'one', description: 'The comment this replies to' },
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Comment {
  readonly text: string;
}

/** A label on one or more records. */
export const tag = typed<Tag>()({
  name: 'std.tag',
  title: 'Tag',
  description: 'A label on one or more records.',
  schema: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['label'] },
  links: { about: { to: '*', cardinality: 'many', description: 'The records tagged' } },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Tag {
  readonly label: string;
}

/** A file attached to a record. Describes the file; storing its bytes is separate. */
export const attachment = typed<Attachment>()({
  name: 'std.attachment',
  title: 'Attachment',
  description: 'A file attached to a record. Describes the file; storing its bytes is not part of this.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      mime: { type: 'string', minLength: 1 },
      size: { type: 'integer', minimum: 0 },
      url: { type: 'string' },
    },
    required: ['name', 'mime'],
  },
  links: { about: about('The record the file is attached to') },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Attachment {
  readonly name: string;
  readonly mime: string;
  readonly size?: number;
  readonly url?: string;
}

/** A note that one record refers to another. */
export const reference = typed<Reference>()({
  name: 'std.reference',
  title: 'Reference',
  description: 'A note that one record refers to another.',
  schema: { type: 'object', properties: { note: { type: 'string' } } },
  links: { about: about('The record doing the referring'), to: about('The record referred to') },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Reference {
  readonly note?: string;
}

/**
 * A chat message. The space is the room; order is by when it was written.
 * It can share one record — a poll to vote on, a task — which a chat that
 * knows the record's kind shows in place. The text should still make sense
 * alone ("Poll: Where to?"), for chats that don't.
 */
export const message = typed<Message>()({
  name: 'std.message',
  title: 'Message',
  description: 'A chat message, optionally replying to another, or sharing a record.',
  schema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['text'] },
  links: {
    replyTo: { to: ['std.message'], cardinality: 'one', description: 'The message this replies to' },
    shares: { to: '*', cardinality: 'one', description: 'A record this message shares, like a poll' },
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Message {
  readonly text: string;
}

/** A column on a board — To do, Doing, Done — in the order it sits. */
export const column = typed<Column>()({
  name: 'std.column',
  title: 'Column',
  description: 'A column on a board, holding tasks.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      position: { type: 'string', minLength: 1, maxLength: 200, description: 'Sorts where the column goes' },
    },
    required: ['name'],
  },
});
export interface Column {
  readonly name: string;
  readonly position?: string;
}

/** A task, in the column it sits in and at a place in it. */
export const task = typed<Task>()({
  name: 'std.task',
  title: 'Task',
  description: 'A task, placed in a column.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      notes: { type: 'string', maxLength: 10000 },
      position: { type: 'string', minLength: 1, maxLength: 200, description: 'Sorts where the task goes in its column' },
    },
    required: ['title'],
  },
  links: { column: { to: ['std.column'], cardinality: 'one', description: 'The column it sits in' } },
});
export interface Task {
  readonly title: string;
  readonly notes?: string;
  readonly position?: string;
}

/**
 * A question with fixed options. The options cannot change once it is asked —
 * votes point at them by position — but whoever asked can close it.
 */
export const poll = typed<Poll>()({
  name: 'std.poll',
  title: 'Poll',
  description: 'A question with options to vote on.',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 500 },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 } },
      closed: { type: 'boolean', description: 'No more votes, as the asker sees it' },
    },
    required: ['question', 'options'],
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'], fixed: ['options'] },
});
export interface Poll {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly closed?: boolean;
}

/**
 * One person's vote on a poll: the position of their choice in its options.
 * One per person per poll — voting again changes it; deleting takes it back.
 */
export const vote = typed<Vote>()({
  name: 'std.vote',
  title: 'Vote',
  description: "A vote on a poll: one per person, changed by voting again.",
  schema: {
    type: 'object',
    properties: { choice: { type: 'integer', minimum: 0, 'x-choicesFrom': { rel: 'about', field: 'options' } } },
    required: ['choice'],
  },
  links: { about: { to: ['std.poll'], cardinality: 'one', description: 'The poll voted on' } },
  rules: { edit: 'creator', delete: 'creator', onePer: ['@author', 'link:about'] },
});
export interface Vote {
  readonly choice: number;
}

/**
 * A call worth remembering, in the space it happened in. Calls themselves are
 * live and kept nowhere (`weave-protocol/calls`); this is only the history —
 * a ring nobody answered, or a call that ended and who was in it.
 */
export const call = typed<Call>()({
  name: 'std.call',
  title: 'Call',
  description: 'A missed call, or one that ended and who was in it.',
  schema: {
    type: 'object',
    properties: {
      status: { enum: ['missed', 'ended'] },
      to: { type: 'string', maxLength: 256, description: 'Who was rung, for a missed call' },
      startedAt: { type: 'string', maxLength: 64 },
      endedAt: { type: 'string', maxLength: 64 },
      people: { type: 'array', items: { type: 'string', maxLength: 256 }, maxItems: 64, description: 'Everyone who was in it' },
    },
    required: ['status', 'startedAt'],
  },
  rules: { edit: 'creator', delete: 'creator' },
});
export interface Call {
  readonly status: 'missed' | 'ended';
  readonly to?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly people?: ReadonlyArray<string>;
}

/** Shapes that attach to anything */
export const standardAnnotations: ReadonlyArray<DefineCollection> = [reaction, comment, tag, attachment, reference];
/** Common nouns apps share */
export const standardNouns: ReadonlyArray<DefineCollection> = [message, column, task, poll, vote, call];
/** Everything in the library */
export const standardSchemas: ReadonlyArray<DefineCollection> = [...standardAnnotations, ...standardNouns];

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A `position` that sorts after `before` and ahead of `after` — either may be
 * missing, for the ends. Positions compare as plain strings and never end in
 * `0`, so there is always room for another between any two. Equal positions
 * (two people dropping in the same spot at once) are fine; sort those by key.
 */
export function positionBetween(before?: string | null, after?: string | null): string {
  const a = before ?? '';
  let b = after && after > a ? after : null;
  let out = '';
  for (let i = 0; ; i++) {
    const low = i < a.length ? DIGITS.indexOf(a[i]!) : 0;
    const high = b !== null ? (i < b.length ? DIGITS.indexOf(b[i]!) : 0) : DIGITS.length;
    if (low === high) {
      out += DIGITS[low];
      continue;
    }
    // At an open end, step by one rather than halving, so a list that only
    // ever grows at the end (or the start) keeps short positions.
    const open = i < a.length ? (b === null ? 'after' : null) : b !== null ? 'before' : null;
    const mid = open === 'after' ? low + 1 : open === 'before' ? high - 1 : Math.floor((low + high) / 2);
    if (mid > low && mid < high) return out + DIGITS[mid];
    // Adjacent digits: keep the lower one, and anything above the rest of `a` will do.
    out += DIGITS[low];
    b = null;
  }
}

/**
 * Makes sure a space knows these collections: defines the ones it has no
 * definition for, and leaves the rest alone — so calling it every time a
 * space opens is fine, and it never bumps a definition someone else owns.
 * A space you cannot write in is skipped.
 */
export async function useSchemas(node: P2PNode, spaceId: string, schemas: ReadonlyArray<DefineCollection>): Promise<void> {
  const summary = await node.spaces.get(spaceId);
  if (!summary?.writable) return;
  const known = new Set((await node.collections.list(spaceId)).filter((c) => c.version !== null).map((c) => c.name));
  for (const schema of schemas) {
    if (!known.has(schema.name)) await node.collections.define(spaceId, schema);
  }
}

export { app, appScreen, checkApp, reviewApp, proposeApp, addApp, copyApp, MAX_APP_COLLECTIONS } from './apps.js';
export { SCREEN_GUIDE, SCREEN_CLIENT, screenDocument, createScreenBridge } from './screens.js';
export type { ScreenBridge, ScreenRecord, ScreenViewer } from './screens.js';
export type { App, AppDefinition, AppReview, AppNeedReview } from './apps.js';
