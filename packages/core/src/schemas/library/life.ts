/**
 * Places and travel, home and life: places and visits, trips, live
 * locations, recipes and meal plans, journals, measurements, workouts, and
 * the books, films and albums people get through.
 */
import {
  blob,
  choice,
  count,
  day,
  image,
  markdown,
  one,
  own,
  placeFields,
  point,
  text,
  typed,
  url,
  when,
  words,
  type BlobRef,
  type ImageRef,
  type Place,
} from '../fragments.js';

/** A place worth remembering: a café, a campsite, a friend's house. */
export const place = typed<PlaceEntry>()({
  name: 'std.place',
  title: 'Place',
  description: 'A place: a name, an address, a point on the map.',
  schema: {
    type: 'object',
    properties: { ...placeFields(), name: words(200), category: text(100), url: url() },
    required: ['name'],
  },
});
export interface PlaceEntry extends Place {
  readonly name: string;
  readonly category?: string;
  readonly url?: string;
}

/** Having been somewhere. */
export const visit = typed<Visit>()({
  name: 'std.visit',
  title: 'Visit',
  description: 'Someone having been at a place.',
  schema: {
    type: 'object',
    properties: { at: when(), note: text(2000) },
    required: ['at'],
  },
  links: { about: one(['std.place'], 'The place') },
  rules: own,
});
export interface Visit {
  readonly at: string;
  readonly note?: string;
}

/** A trip; its events, bookings and places link `in` it. */
export const trip = typed<Trip>()({
  name: 'std.trip',
  title: 'Trip',
  description: 'A trip, with dates.',
  schema: {
    type: 'object',
    properties: { title: words(200), start: day(), end: day(), note: markdown(10000) },
    required: ['title'],
  },
});
export interface Trip {
  readonly title: string;
  readonly start?: string;
  readonly end?: string;
  readonly note?: string;
}

/** Where someone is now, shared live: one per person, overwritten as they move. */
export const location = typed<Location>()({
  name: 'std.location',
  title: 'Location',
  description: 'Where someone is now: one per person.',
  schema: {
    type: 'object',
    properties: {
      ...point(),
      accuracy: { type: 'number', minimum: 0, description: 'Metres' },
      at: when(),
    },
    required: ['lat', 'lon', 'at'],
  },
  rules: { ...own, onePer: ['@author'] },
});
export interface Location {
  readonly lat: number;
  readonly lon: number;
  readonly accuracy?: number;
  readonly at: string;
}

/** A recipe, after schema.org's. */
export const recipe = typed<Recipe>()({
  name: 'std.recipe',
  title: 'Recipe',
  description: 'A recipe: ingredients and steps.',
  schema: {
    type: 'object',
    properties: {
      title: words(300),
      description: text(2000),
      ingredients: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            text: words(500, 'As written, like "2 cloves garlic, crushed"'),
            quantity: { type: 'number', minimum: 0 },
            unit: text(32),
          },
          required: ['text'],
        },
      },
      steps: { type: 'array', maxItems: 200, items: words(5000) },
      servings: count(1),
      prepMinutes: count(0),
      cookMinutes: count(0),
      image: image(),
      source: url('Where it came from'),
    },
    required: ['title'],
  },
});
export interface Recipe {
  readonly title: string;
  readonly description?: string;
  readonly ingredients?: ReadonlyArray<{
    readonly text: string;
    readonly quantity?: number;
    readonly unit?: string;
  }>;
  readonly steps?: ReadonlyArray<string>;
  readonly servings?: number;
  readonly prepMinutes?: number;
  readonly cookMinutes?: number;
  readonly image?: ImageRef;
  readonly source?: string;
}

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

/** A meal on the plan: one per day per meal, and anyone may change it. */
export const meal = typed<Meal>()({
  name: 'std.meal',
  title: 'Meal',
  description: 'A planned meal: one per day per meal.',
  schema: {
    type: 'object',
    properties: { date: day(), meal: choice(MEALS), note: text(1000) },
    required: ['date', 'meal'],
  },
  links: { about: one(['std.recipe'], 'The recipe') },
  rules: { onePer: ['date', 'meal'] },
});
export interface Meal {
  readonly date: string;
  readonly meal: (typeof MEALS)[number];
  readonly note?: string;
}

/** A day's journal entry: one per person per day. */
export const journalEntry = typed<JournalEntry>()({
  name: 'std.journal-entry',
  title: 'Journal entry',
  description: 'What someone wrote about a day: one entry per day.',
  schema: {
    type: 'object',
    properties: { date: day(), content: markdown(200000), mood: text(32) },
    required: ['date'],
  },
  rules: { ...own, onePer: ['@author', 'date'] },
});
export interface JournalEntry {
  readonly date: string;
  readonly content?: string;
  readonly mood?: string;
}

/** A measurement at a moment: a weight, a blood pressure, a meter reading. */
export const measurement = typed<Measurement>()({
  name: 'std.measurement',
  title: 'Measurement',
  description: 'Something measured at a moment: a kind, a value, a unit.',
  schema: {
    type: 'object',
    properties: {
      kind: words(64, 'Like "weight", "steps" or "electricity"'),
      value: { type: 'number' },
      unit: words(32, 'Like "kg" or "kWh"'),
      at: when(),
      note: text(1000),
    },
    required: ['kind', 'value', 'unit', 'at'],
  },
  rules: own,
});
export interface Measurement {
  readonly kind: string;
  readonly value: number;
  readonly unit: string;
  readonly at: string;
  readonly note?: string;
}

/** A workout: a run, a ride, a session at the gym. */
export const workout = typed<Workout>()({
  name: 'std.workout',
  title: 'Workout',
  description: 'A run, a ride, a session: when, how long, how far.',
  schema: {
    type: 'object',
    properties: {
      type: words(64, 'Like "run", "ride" or "strength"'),
      start: when(),
      duration: { type: 'number', minimum: 0, description: 'Seconds' },
      distance: { type: 'number', minimum: 0, description: 'Metres' },
      route: blob('GPX'),
      note: text(2000),
    },
    required: ['type', 'start'],
  },
  rules: own,
});
export interface Workout {
  readonly type: string;
  readonly start: string;
  readonly duration?: number;
  readonly distance?: number;
  readonly route?: BlobRef;
  readonly note?: string;
}

const WORK_KINDS = ['book', 'film', 'show', 'album', 'game', 'podcast', 'other'] as const;

/** A book, film, show, album or game, known by its ids. Progress is `about` it. */
export const work = typed<Work>()({
  name: 'std.work',
  title: 'Work',
  description: 'A book, film, show, album or game.',
  schema: {
    type: 'object',
    properties: {
      kind: choice(WORK_KINDS),
      title: words(500),
      creators: { type: 'array', maxItems: 20, items: words(200) },
      year: count(0, 9999),
      ids: {
        type: 'object',
        properties: {
          isbn: text(17),
          imdb: text(16),
          mbid: text(36, 'MusicBrainz release group'),
          wikidata: text(16),
        },
      },
      cover: blob(),
    },
    required: ['kind', 'title'],
  },
});
export interface Work {
  readonly kind: (typeof WORK_KINDS)[number];
  readonly title: string;
  readonly creators?: ReadonlyArray<string>;
  readonly year?: number;
  readonly ids?: {
    readonly isbn?: string;
    readonly imdb?: string;
    readonly mbid?: string;
    readonly wikidata?: string;
  };
  readonly cover?: BlobRef;
}

/** Where someone is with a work: want to, reading, finished. One per person per work. */
export const progress = typed<Progress>()({
  name: 'std.progress',
  title: 'Progress',
  description: 'Where someone is with a book, film or game: one per person.',
  schema: {
    type: 'object',
    properties: {
      status: choice(['want', 'doing', 'done', 'dropped']),
      percent: { type: 'number', minimum: 0, maximum: 100 },
      finishedAt: when(),
      note: text(2000),
    },
    required: ['status'],
  },
  links: { about: one(['std.work'], 'The work') },
  rules: { ...own, onePer: ['@author', 'link:about'] },
});
export interface Progress {
  readonly status: 'want' | 'doing' | 'done' | 'dropped';
  readonly percent?: number;
  readonly finishedAt?: string;
  readonly note?: string;
}
