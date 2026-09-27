import { useEffect, useState } from 'react';
import { plainQuery, type Query, type ResultOf } from '../query/types.js';
import { useNode } from './context.js';

export interface QueryState<R> {
  /** The latest result, or null until the first one arrives. `result.complete` is false while what it needs is still on its way. */
  readonly result: R | null;
  /** Why the query failed — usually a malformed query, saying what to fix */
  readonly error: Error | null;
}

/**
 * Runs a query and keeps it current as records change, locally or by sync.
 * The query is plain data, compared by value, so writing it inline is fine.
 * Name the collection by its definition and the result comes back typed.
 *
 * @param spaceId The space to query
 * @param query What to find
 */
export function useQuery<const Q extends Query>(spaceId: string, query: Q): QueryState<ResultOf<Q>> {
  const node = useNode();
  const [state, setState] = useState<QueryState<ResultOf<Q>>>({ result: null, error: null });
  // Compared by its plain form: a definition's validator is not data.
  const key = JSON.stringify(plainQuery(query));

  useEffect(() => {
    setState({ result: null, error: null });
    return node.records.watch(
      spaceId,
      JSON.parse(key) as Query,
      (result) => setState({ result: result as ResultOf<Q>, error: null }),
      (error) => setState((previous) => ({ result: previous.result, error })),
    );
  }, [node, spaceId, key]);

  return state;
}
