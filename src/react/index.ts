/**
 * @module react
 * React bindings: follow the sign-in flow, draw it, and keep what you read from
 * a space live as records sync in.
 *
 * ```tsx
 * const auth = createWeaveAuth({ network: { relays } });
 *
 * function App() {
 *   const { session } = useWeaveAuth(auth);
 *   if (!session) return <WeaveAuth auth={auth} />;
 *   return <Todos node={session.node} />;
 * }
 *
 * function Todos({ node, space }) {
 *   const todos = useQuery(node, space, { collection: 'app.todo.item', sort: { '@createdAt': 'asc' } });
 *   …
 * }
 * ```
 *
 * `react` is a peer dependency: this entry point is the only part of the
 * protocol that imports it.
 */
export { useWeaveAuth } from './use-weave-auth.js';
export { WeaveAuth } from './weave-auth.js';
export type { WeaveAuthProps } from './weave-auth.js';
export { useLive } from './use-live.js';
export { useQuery } from './use-query.js';
export type { QueryState } from './use-query.js';
export { useSpaces } from './use-spaces.js';
export type { SpacesState } from './use-spaces.js';
