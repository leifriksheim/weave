/**
 * Messaging and publishing: chat, posts, long-form writing, documents, notes.
 * A document is one record per block, so people editing different blocks at
 * once never overwrite each other.
 */
import {
  about,
  authored,
  blob,
  choice,
  image,
  markdown,
  one,
  own,
  people,
  person,
  position,
  text,
  define,
  when,
  words,
} from '../fragments.js';
import type { BodyOf } from '../../query/types.js';

/**
 * A chat message. The space is the room, or it links the `channel` it is in;
 * order is by when it was written. It can share one record — a poll to vote
 * on, a task — which a chat that knows the record's kind shows in place. The
 * text should still make sense alone ("Poll: Where to?"), for chats that don't.
 *
 * `mentions` names who it calls on ("@Sam"), and `replyingTo` whose message
 * it answers. With its channel they are its topics, so "mentions me", "replies
 * to me" and "in #design" can be asked of a keeper that can't read it.
 */
export const message = define({
  name: 'std.message',
  title: 'Message',
  description: 'A chat message, optionally replying to another, or sharing a record.',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 10000 },
      mentions: people(64, 'Who it mentions, so they can be told'),
      replyingTo: person('Whose message it replies to, so they can be told'),
    },
    required: ['text'],
  },
  topics: ['link:channel', 'mentions', 'replyingTo'],
  links: {
    channel: one(['std.channel'], 'The channel it is in, when the space has several'),
    replyTo: { to: ['std.message'], cardinality: 'one', description: 'The message this replies to' },
    shares: { to: '*', cardinality: 'one', description: 'A record this message shares, like a poll' },
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export type Message = BodyOf<typeof message>;

/**
 * A call worth remembering, in the space it happened in. Calls themselves are
 * live and kept nowhere (`weave-protocol/calls`); this is only the history —
 * a ring nobody answered, or a call that ended and who was in it.
 */
export const call = define({
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
      people: {
        type: 'array',
        items: { type: 'string', maxLength: 256 },
        maxItems: 64,
        description: 'Everyone who was in it',
      },
    },
    required: ['status', 'startedAt'],
  },
  rules: { edit: 'creator', delete: 'creator' },
  topics: ['to', 'people'],
});
export type Call = BodyOf<typeof call>;

/** A channel in a space with more than one conversation. Messages link it as their `channel`. */
export const channel = define({
  name: 'std.channel',
  title: 'Channel',
  description: 'A named conversation within a space.',
  schema: {
    type: 'object',
    properties: { name: words(100), topic: text(500), position: position() },
    required: ['name'],
  },
  permissions: ['moderate'],
  rules: { create: 'can:moderate', edit: 'can:moderate' },
});
export type Channel = BodyOf<typeof channel>;

/**
 * A direct message between some members of a space: its text is sealed so
 * only the people in `to` and whoever wrote it can read it, with each one's
 * member key (`docs/direct-messages.md`). Other members see who wrote to whom and
 * when, not what. `to` is a topic, so "sent to me" can be asked of a keeper
 * that can't read it. Write and read it through `node.direct`.
 */
export const direct = define({
  name: 'std.direct',
  title: 'Direct message',
  description: 'A message only the people it is sent to can read.',
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'array',
        items: person(),
        minItems: 1,
        maxItems: 16,
        description: 'Who it is for, not whoever wrote it',
      },
      data: text(60000, 'The text, sealed with the message key'),
      boxes: {
        type: 'array',
        maxItems: 17,
        description: 'The message key, sealed to each reader: everyone in `to`, and whoever wrote it',
        items: {
          type: 'object',
          properties: { to: person(), sealed: text(1000) },
          required: ['to', 'sealed'],
        },
      },
    },
    required: ['to', 'data', 'boxes'],
  },
  topics: ['to'],
  rules: { edit: 'creator', delete: 'creator' },
});
export type Direct = BodyOf<typeof direct>;

/**
 * A post to a feed: short text, pictures, a reply or a quote. `root` is the
 * first post of the thread, so a reader gathers a thread with one query.
 * `mentions` and `replyingTo` are its topics, as on a `std.message`.
 */
export const post = define({
  name: 'std.post',
  title: 'Post',
  description: 'A post to a feed, optionally replying to or quoting another.',
  schema: {
    type: 'object',
    properties: {
      text: text(10000),
      images: { type: 'array', maxItems: 8, items: image() },
      langs: { type: 'array', maxItems: 3, items: text(35, 'BCP 47, like "en"', 2) },
      mentions: people(64, 'Who it mentions, so they can be told'),
      replyingTo: person('Whose post it replies to, so they can be told'),
    },
  },
  topics: ['mentions', 'replyingTo'],
  links: {
    replyTo: one(['std.post'], 'The post this replies to'),
    root: one(['std.post'], 'The first post of the thread'),
    shares: about('A record it quotes'),
  },
  permissions: ['moderate'],
  rules: authored,
});
export type Post = BodyOf<typeof post>;

/** Passing a post on as it is: one per person per post. */
export const repost = define({
  name: 'std.repost',
  title: 'Repost',
  description: 'Passing a record on as it is: one per person per record.',
  schema: {
    type: 'object',
    properties: { respondingTo: person('Whose record it responds to, so they can be told') },
  },
  links: { about: about('What is reposted') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
  topics: ['respondingTo'],
});
export type Repost = BodyOf<typeof repost>;

/** Long-form writing, optionally in a publication. `draft` keeps it unlisted. */
export const article = define({
  name: 'std.article',
  title: 'Article',
  description: 'Long-form writing, in CommonMark.',
  schema: {
    type: 'object',
    properties: {
      mentions: people(64, 'Who it mentions, so they can be told'),
      title: words(300),
      summary: text(1000),
      content: markdown(200000),
      cover: blob(),
      slug: text(200, 'For its address, like "my-first-post"', 1),
      publishedAt: when(),
      draft: { type: 'boolean' },
    },
    required: ['title'],
  },
  links: { in: one(['std.publication'], 'The publication it is in') },
  permissions: ['moderate'],
  rules: authored,
  topics: ['mentions'],
});
export type Article = BodyOf<typeof article>;

/** A blog, a newsletter: what articles are published in. */
export const publication = define({
  name: 'std.publication',
  title: 'Publication',
  description: 'A blog or newsletter that articles are published in.',
  schema: {
    type: 'object',
    properties: { title: words(200), description: text(2000), icon: blob() },
    required: ['title'],
  },
});
export type Publication = BodyOf<typeof publication>;

/** A document: its title here, its content in `std.doc-block`s linked `in` it. */
export const doc = define({
  name: 'std.doc',
  title: 'Document',
  description: 'A document made of blocks that people can edit at once.',
  schema: { type: 'object', properties: { title: words(500) }, required: ['title'] },
});
export type Doc = BodyOf<typeof doc>;

const BLOCK_TYPES = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bullet',
  'numbered',
  'todo',
  'quote',
  'code',
  'image',
  'divider',
] as const;

/**
 * One block of a document, in order by `position`. A nested list item or a
 * toggle's contents has a `parent` block.
 */
export const docBlock = define({
  name: 'std.doc-block',
  title: 'Block',
  description: 'One block of a document: a paragraph, heading, list item, image…',
  schema: {
    type: 'object',
    properties: {
      mentions: people(64, 'Who it mentions, so they can be told'),
      type: choice(BLOCK_TYPES),
      text: text(20000),
      checked: { type: 'boolean', description: 'For a todo' },
      language: text(32, 'For code'),
      image: image(),
      position: position('Sorts where it goes in its document or parent'),
    },
    required: ['type'],
  },
  links: {
    in: one(['std.doc'], 'The document it is in'),
    parent: one(['std.doc-block'], 'The block it is nested under'),
  },
  topics: ['mentions'],
});
export type DocBlock = BodyOf<typeof docBlock>;

/**
 * A wiki page: one per slug, anyone may change it, and every version is kept
 * so its history can be read and restored.
 */
export const wikiPage = define({
  name: 'std.wiki-page',
  title: 'Wiki page',
  description: 'A page anyone can edit, one per name, keeping every version.',
  schema: {
    type: 'object',
    properties: {
      slug: words(200, 'Its name in links, like "house-rules"'),
      title: words(300),
      content: markdown(200000),
    },
    required: ['slug', 'title'],
  },
  history: 'all',
  rules: { onePer: ['slug'] },
});
export type WikiPage = BodyOf<typeof wikiPage>;

/** A note, as a notes app keeps them. */
export const note = define({
  name: 'std.note',
  title: 'Note',
  description: 'A note: a title and some text.',
  schema: {
    type: 'object',
    properties: {
      mentions: people(64, 'Who it mentions, so they can be told'),
      title: text(500),
      content: markdown(200000),
      pinned: { type: 'boolean' },
      color: text(32),
    },
  },
  topics: ['mentions'],
});
export type Note = BodyOf<typeof note>;

/** This file's part of `standardGroups` */
export const publishingGroups = {
  'Messaging and publishing': [
    message,
    channel,
    direct,
    post,
    repost,
    article,
    publication,
    doc,
    docBlock,
    wikiPage,
    note,
    call,
  ],
};
