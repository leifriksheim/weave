/**
 * @module records/views
 * `sys.view`: how to show some records — a query and a layout, as data.
 *
 * An agent that builds you a "what's overdue" screen writes one of these; any
 * app that renders views then shows it, without the agent shipping any code
 * and without the app knowing the collection. The format is protocol, so every
 * app reads the same thing; how a `table` or a `board` looks is each app's own.
 */
import type { StoredCollection } from '../schema/collection-def.js';
import { checkQuery } from '../query/filter.js';
import type { Query } from '../query/types.js';

export const VIEW_COLLECTION = 'sys.view';

/** Layouts every renderer should understand. One it does not know, it may show as a list. */
export const VIEW_LAYOUTS = ['list', 'table', 'cards', 'board'] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];

export interface ViewField {
  /** A body field (dotted for nested) or a record field like `@createdAt` — the same names a query uses */
  readonly field: string;
  readonly label?: string;
}

export interface View {
  readonly title: string;
  readonly description?: string;
  /** What to show. Its `include`s are shown as counts or lists alongside each record. */
  readonly query: Query;
  readonly layout: ViewLayout;
  /** What to show of each record, in order. Default: the renderer's choice. */
  readonly fields?: ReadonlyArray<ViewField>;
  /** The field whose values make a board's columns. Required for `board`. */
  readonly groupBy?: string;
}

export const VIEW_DEFINITION: StoredCollection = Object.freeze<StoredCollection>({
  name: VIEW_COLLECTION,
  title: 'View',
  description:
    'How to show some records: a query (the same one records_query takes) and a layout — ' +
    'list, table, cards, or board (columns by groupBy). Any app that renders views shows it.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 2000 },
      query: { type: 'object', description: 'A query: { collection, where?, include?, sort?, limit? }' },
      layout: { type: 'string', enum: [...VIEW_LAYOUTS] },
      fields: {
        type: 'array',
        items: { type: 'object', properties: { field: { type: 'string', minLength: 1 }, label: { type: 'string' } }, required: ['field'] },
      },
      groupBy: { type: 'string', minLength: 1 },
    },
    required: ['title', 'query', 'layout'],
  },
  version: 1,
  links: {
    about: { to: '*', cardinality: 'one', description: 'A record the view belongs to, when it is about one — the comments on a document' },
  },
});

/** What the schema cannot say about a view: whether its query runs, and whether a board says what to group by. */
export function checkView(body: unknown): ReadonlyArray<{ path: string; message: string }> {
  const view = body as Partial<View> | null;
  if (view === null || typeof view !== 'object' || typeof view.query !== 'object' || view.query === null) return [];
  const issues: Array<{ path: string; message: string }> = [];
  const problem = checkQuery(view.query);
  if (problem) issues.push({ path: '/query', message: problem });
  if (view.layout === 'board' && typeof view.groupBy !== 'string') {
    issues.push({ path: '/groupBy', message: 'A board needs groupBy: the field whose values are its columns' });
  }
  return issues;
}
