/**
 * Lists, files and media. A list is a record and each item another, linked
 * `in` it, so two people ticking items at once never undo each other.
 */
import {
  about,
  blob,
  count,
  many,
  one,
  own,
  person,
  placeRef,
  position,
  text,
  typed,
  url,
  when,
  words,
  type BlobRef,
  type Place,
} from '../fragments.js';

/**
 * A list of anything: shopping, packing, reading, people, a playlist. `kind`
 * is a hint for how to show it, not a constraint.
 */
export const list = typed<List>()({
  name: 'std.list',
  title: 'List',
  description: 'A list of things; its items are std.list-item records linked in it.',
  schema: {
    type: 'object',
    properties: {
      title: words(200),
      description: text(2000),
      icon: text(16, 'An emoji'),
      kind: text(32, 'How to show it, like "checklist", "shopping", "reading", "people" or "playlist"'),
    },
    required: ['title'],
  },
});
export interface List {
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly kind?: string;
}

/** One thing on a list: some text, a web page, a person, or a record it is `about`. */
export const listItem = typed<ListItem>()({
  name: 'std.list-item',
  title: 'List item',
  description: 'One thing on a list: text, a link, a person or a record.',
  schema: {
    type: 'object',
    properties: {
      text: text(1000),
      url: url(),
      did: person('A person on the list'),
      checked: { type: 'boolean' },
      quantity: { type: 'number', minimum: 0 },
      position: position('Sorts where it goes in its list'),
    },
  },
  links: { in: one(['std.list'], 'The list it is on'), about: about('A record it stands for') },
});
export interface ListItem {
  readonly text?: string;
  readonly url?: string;
  readonly did?: string;
  readonly checked?: boolean;
  readonly quantity?: number;
  readonly position?: string;
}

/** A folder of files, inside another or at the top. */
export const folder = typed<Folder>()({
  name: 'std.folder',
  title: 'Folder',
  description: 'A folder of files.',
  schema: { type: 'object', properties: { name: words(255) }, required: ['name'] },
  links: { parent: one(['std.folder'], 'The folder it is in') },
});
export interface Folder {
  readonly name: string;
}

/** A file, in a folder or at the top. */
export const file = typed<FileEntry>()({
  name: 'std.file',
  title: 'File',
  description: 'A file, in a folder.',
  schema: {
    type: 'object',
    properties: { name: words(255), blob: blob('Its bytes') },
    required: ['name', 'blob'],
  },
  links: { parent: one(['std.folder'], 'The folder it is in') },
});
export interface FileEntry {
  readonly name: string;
  readonly blob: BlobRef;
}

/** A photo, in any number of albums. */
export const photo = typed<Photo>()({
  name: 'std.photo',
  title: 'Photo',
  description: 'A photo, with where and when it was taken.',
  schema: {
    type: 'object',
    properties: {
      blob: blob(),
      alt: text(2000, 'What it shows'),
      width: count(1),
      height: count(1),
      takenAt: when(),
      place: placeRef('Where it was taken'),
    },
    required: ['blob'],
  },
  links: { in: many(['std.album'], 'The albums it is in') },
});
export interface Photo {
  readonly blob: BlobRef;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly takenAt?: string;
  readonly place?: Place;
}

/** An album of photos and videos. */
export const album = typed<Album>()({
  name: 'std.album',
  title: 'Album',
  description: 'An album of photos and videos.',
  schema: {
    type: 'object',
    properties: { title: words(200), description: text(2000) },
    required: ['title'],
  },
  links: { cover: one(['std.photo'], 'The photo on its cover') },
});
export interface Album {
  readonly title: string;
  readonly description?: string;
}

/** A video, with a still to show before it plays and captions. */
export const video = typed<Video>()({
  name: 'std.video',
  title: 'Video',
  description: 'A video, with a thumbnail and captions.',
  schema: {
    type: 'object',
    properties: {
      blob: blob(),
      thumbnail: blob(),
      duration: { type: 'number', minimum: 0, description: 'Seconds' },
      captions: blob('WebVTT'),
      alt: text(2000, 'What it shows'),
      title: text(300),
    },
    required: ['blob'],
  },
  links: { in: many('*', 'Albums, lists or channels it is in') },
});
export interface Video {
  readonly blob: BlobRef;
  readonly thumbnail?: BlobRef;
  readonly duration?: number;
  readonly captions?: BlobRef;
  readonly alt?: string;
  readonly title?: string;
}

const trackFields = {
  title: words(300),
  artists: { type: 'array', maxItems: 20, items: words(200) },
  album: text(300),
  duration: { type: 'number', minimum: 0, description: 'Seconds' },
  isrc: text(12, 'International Standard Recording Code'),
  mbid: text(36, 'MusicBrainz recording id'),
} as const;

/** A piece of music, known by its ids; `blob` when the space holds the audio. */
export const track = typed<Track>()({
  name: 'std.track',
  title: 'Track',
  description: 'A piece of music, by title, artists and ids.',
  schema: { type: 'object', properties: { ...trackFields, blob: blob() }, required: ['title'] },
  links: { in: many(['std.list'], 'Playlists it is on') },
});
export interface Track {
  readonly title: string;
  readonly artists?: ReadonlyArray<string>;
  readonly album?: string;
  readonly duration?: number;
  readonly isrc?: string;
  readonly mbid?: string;
  readonly blob?: BlobRef;
}

/** A track someone listened to, and when: a listening history. */
export const play = typed<Play>()({
  name: 'std.play',
  title: 'Play',
  description: 'A track someone listened to, and when.',
  schema: {
    type: 'object',
    properties: { ...trackFields, playedAt: when() },
    required: ['title', 'playedAt'],
  },
  rules: own,
});
export interface Play extends Omit<Track, 'blob'> {
  readonly playedAt: string;
}
