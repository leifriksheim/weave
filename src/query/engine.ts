/**
 * @module query/engine
 * Runs a query: narrow by collection, filter, sort, page, then follow links.
 *
 * Deliberately no planner. A browser holds a replica, not a warehouse; at that
 * scale an optimiser would be more code than it saves. Filtering happens after
 * records are opened, so in a private space it sees decrypted bodies.
 */
import type { NodeRecord } from '../node/types.js';
import { checkQuery, fieldValue, matches } from './filter.js';
import type { Include, Query, QueryRecord, QueryResult } from './types.js';

/** What the engine needs from a space: its current records, one by key, and what links where. */
export interface QuerySource {
  /** Current, not deleted */
  list(collection: string): Promise<ReadonlyArray<NodeRecord>>;
  get(key: string): Promise<NodeRecord | null>;
  linked(key: string, options: { rel?: string; collection?: string }): Promise<ReadonlyArray<NodeRecord>>;
}

/** Orders two values of a field: missing sorts first, then numbers and strings by value. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * A total order. Ties always break on the key — stable on every node,
 * so paging neither skips nor repeats between peers holding the same data.
 */
function sortRecords<T extends NodeRecord>(records: T[], sort: Query['sort']): T[] {
  const fields = Object.entries(sort ?? { '@createdAt': 'asc' });
  return records.sort((a, b) => {
    for (const [field, direction] of fields) {
      const order = compareValues(fieldValue(a, field), fieldValue(b, field));
      if (order !== 0) return direction === 'desc' ? -order : order;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

async function expand(source: QuerySource, record: NodeRecord, includes: Query['include']): Promise<QueryRecord> {
  if (!includes) return record;
  const included: Record<string, ReadonlyArray<QueryRecord> | number> = {};
  for (const [name, include] of Object.entries(includes) as Array<[string, Include]>) {
    let related: NodeRecord[];
    if (include.direction === 'out') {
      const targets = await Promise.all(record.links.filter((l) => l.rel === include.rel).map((l) => source.get(l.to)));
      // A link to a record not held here is normal; it simply finds nothing.
      related = targets.filter((r): r is NodeRecord => r !== null && (!include.from || r.collection === include.from));
    } else {
      related = [...(await source.linked(record.key, { rel: include.rel, ...(include.from ? { collection: include.from } : {}) }))];
    }
    if (include.where) related = related.filter((r) => matches(r, include.where!));
    if (include.count) {
      included[name] = related.length;
      continue;
    }
    const page = include.limit === undefined ? related : related.slice(0, include.limit);
    included[name] = await Promise.all(page.map((r) => expand(source, r, include.include)));
  }
  return { ...record, included };
}

/**
 * Runs a query against a space.
 * @throws When the query is malformed — with a message saying what to fix
 */
export async function runQuery<T = unknown>(source: QuerySource, query: Query): Promise<QueryResult<T>> {
  const problem = checkQuery(query);
  if (problem) throw new Error(`Invalid query: ${problem}`);

  const candidates = [...(await source.list(query.collection))];
  const filtered = query.where ? candidates.filter((r) => matches(r, query.where!)) : candidates;
  const sorted = sortRecords(filtered, query.sort);

  // The cursor is the key of the last record of the previous page. If that
  // record has since gone, start from where it would have been.
  let start = 0;
  if (query.cursor) {
    const at = sorted.findIndex((r) => r.key === query.cursor);
    start = at >= 0 ? at + 1 : 0;
  }
  const page = query.limit === undefined ? sorted.slice(start) : sorted.slice(start, start + query.limit);
  const records = await Promise.all(page.map((r) => expand(source, r, query.include)));
  const more = start + page.length < sorted.length && page.length > 0;
  return { records: records as ReadonlyArray<QueryRecord<T>>, cursor: more ? page[page.length - 1]!.key : null };
}
