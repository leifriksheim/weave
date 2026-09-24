import { useEffect, useState } from 'react';
import type { P2PNode } from '../node/types.js';
import type { Query, QueryResult } from '../query/types.js';

export interface QueryState<T> {
  /** The latest result, or null until the first one arrives */
  readonly result: QueryResult<T> | null;
  /** Why the query failed — usually a malformed query, saying what to fix */
  readonly error: Error | null;
}

/**
 * Runs a query and keeps it current as records change, locally or by sync.
 * The query is plain data, compared by value, so writing it inline is fine.
 *
 * @param node The signed-in node
 * @param spaceId The space to query
 * @param query What to find
 */
export function useQuery<T = unknown>(node: P2PNode, spaceId: string, query: Query): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ result: null, error: null });
  const key = JSON.stringify(query);

  useEffect(() => {
    setState({ result: null, error: null });
    return node.records.watch<T>(
      spaceId,
      JSON.parse(key) as Query,
      (result) => setState({ result, error: null }),
      (error) => setState((previous) => ({ result: previous.result, error })),
    );
  }, [node, spaceId, key]);

  return state;
}
