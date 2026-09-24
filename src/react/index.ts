/**
 * @module react
 * React bindings: follow the sign-in flow, draw it, and keep what you read from
 * a space live as records sync in.
 *
 * ```tsx
 * const auth = createWeaveAuth({ network: { relays } });
 *
 * function Root() {
 *   return <WeaveProvider auth={auth}><App /></WeaveProvider>;
 * }
 *
 * function App() {
 *   const { state } = useWeave();
 *   if (state?.stage !== 'ready') return <WeaveAuth auth={auth} />;
 *   return <Todos space={…} />;
 * }
 *
 * function Todos({ space }) {
 *   const { result } = useQuery(space, { collection: 'app.todo.item', sort: { '@createdAt': 'asc' } });
 *   const node = useNode();   // to write: node.records.put(space, 'app.todo.item', { text })
 *   …
 * }
 * ```
 *
 * `react` is a peer dependency: this entry point is the only part of the
 * protocol that imports it.
 */
export { WeaveProvider, useWeave, useAuth, useSession, useNode } from './context.js';
export type { WeaveProviderProps } from './context.js';
export { useWeaveAuth } from './use-weave-auth.js';
export { WeaveAuth } from './weave-auth.js';
export type { WeaveAuthProps } from './weave-auth.js';
export { useLive } from './use-live.js';
export { useQuery } from './use-query.js';
export type { QueryState } from './use-query.js';
export { useSpaces } from './use-spaces.js';
export type { SpacesState } from './use-spaces.js';
export { useOpenSpace, useRecord, useLinked, useCollections, useProfiles, useSpaceStatus, useCan } from './use-space.js';
