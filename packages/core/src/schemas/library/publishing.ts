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
  position,
  text,
  typed,
  when,
  words,
  type BlobRef,
  type ImageRef,
} from '../fragments.js';

/**
 * A chat message. The space is the room, or `channel` names one within it;
 * order is by when it was written. It can share one record — a poll to vote
 * on, a task — which a chat that knows the record's kind shows in place. The
 * text should still make sense alone ("Poll: Where to?"), for chats that don't.
 */
export const message = typed<Message>()({
  name: 'std.message',
  title: 'Message',
  description: 'A chat message, optionally replying to another, or sharing a record.',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', minLength: 1, maxLength: 10000 },
      channel: text(100, 'The key of the std.channel it is in, when the space has several'),
    },
    required: ['text'],
  },
  links: {
    replyTo: { to: ['std.message'], cardinality: 'one', description: 'The message this replies to' },
    root: one(['std.message'], 'The first message of the thread it is in'),
    shares: { to: '*', cardinality: 'one', description: 'A record this message shares, like a poll' },
  },
  permissions: ['moderate'],
  rules: { edit: 'creator', delete: ['creator', 'can:moderate'] },
});
export interface Message {
  readonly text: string;
  readonly channel?: string;
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
});
export interface Call {
  readonly status: 'missed' | 'ended';
  readonly to?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly people?: ReadonlyArray<string>;
}

/** A channel in a space with more than one conversation. Messages name it in `channel`. */
export const channel = typed<Channel>()({
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
export interface Channel {
  readonly name: string;
  readonly topic?: string;
  readonly position?: string;
}

/**
 * A post to a feed: short text, pictures, a reply or a quote. `root` is the
 * first post of the thread, so a reader gathers a thread with one query.
 */
export const post = typed<Post>()({
  name: 'std.post',
  title: 'Post',
  description: 'A post to a feed, optionally replying to or quoting another.',
  schema: {
    type: 'object',
    properties: {
      text: text(10000),
      images: { type: 'array', maxItems: 8, items: image() },
      langs: { type: 'array', maxItems: 3, items: text(35, 'BCP 47, like "en"', 2) },
    },
  },
  links: {
    replyTo: one(['std.post'], 'The post this replies to'),
    root: one(['std.post'], 'The first post of the thread'),
    shares: about('A record it quotes'),
  },
  permissions: ['moderate'],
  rules: authored,
});
export interface Post {
  readonly text?: string;
  readonly images?: ReadonlyArray<ImageRef>;
  readonly langs?: ReadonlyArray<string>;
}

/** Passing a post on as it is: one per person per post. */
export const repost = typed<Repost>()({
  name: 'std.repost',
  title: 'Repost',
  description: 'Passing a record on as it is: one per person per record.',
  schema: { type: 'object', properties: {} },
  links: { about: about('What is reposted') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
});
export type Repost = Readonly<Record<string, never>>;

/** Long-form writing, optionally in a publication. `draft` keeps it unlisted. */
export const article = typed<Article>()({
  name: 'std.article',
  title: 'Article',
  description: 'Long-form writing, in CommonMark.',
  schema: {
    type: 'object',
    properties: {
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
});
export interface Article {
  readonly title: string;
  readonly summary?: string;
  readonly content?: string;
  readonly cover?: BlobRef;
  readonly slug?: string;
  readonly publishedAt?: string;
  readonly draft?: boolean;
}

/** A blog, a newsletter: what articles are published in. */
export const publication = typed<Publication>()({
  name: 'std.publication',
  title: 'Publication',
  description: 'A blog or newsletter that articles are published in.',
  schema: {
    type: 'object',
    properties: { title: words(200), description: text(2000), icon: blob() },
    required: ['title'],
  },
});
export interface Publication {
  readonly title: string;
  readonly description?: string;
  readonly icon?: BlobRef;
}

/** A document: its title here, its content in `std.doc-block`s linked `in` it. */
export const doc = typed<Doc>()({
  name: 'std.doc',
  title: 'Document',
  description: 'A document made of blocks that people can edit at once.',
  schema: { type: 'object', properties: { title: words(500) }, required: ['title'] },
});
export interface Doc {
  readonly title: string;
}

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
export const docBlock = typed<DocBlock>()({
  name: 'std.doc-block',
  title: 'Block',
  description: 'One block of a document: a paragraph, heading, list item, image…',
  schema: {
    type: 'object',
    properties: {
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
});
export interface DocBlock {
  readonly type: (typeof BLOCK_TYPES)[number];
  readonly text?: string;
  readonly checked?: boolean;
  readonly language?: string;
  readonly image?: ImageRef;
  readonly position?: string;
}

/**
 * A wiki page: one per slug, anyone may change it, and every version is kept
 * so its history can be read and restored.
 */
export const wikiPage = typed<WikiPage>()({
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
export interface WikiPage {
  readonly slug: string;
  readonly title: string;
  readonly content?: string;
}

/** A note, as a notes app keeps them. */
export const note = typed<Note>()({
  name: 'std.note',
  title: 'Note',
  description: 'A note: a title and some text.',
  schema: {
    type: 'object',
    properties: {
      title: text(500),
      content: markdown(200000),
      pinned: { type: 'boolean' },
      color: text(32),
    },
  },
});
export interface Note {
  readonly title?: string;
  readonly content?: string;
  readonly pinned?: boolean;
  readonly color?: string;
}
