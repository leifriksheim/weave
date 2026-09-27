/**
 * @module elements
 * Web components for Weave, usable from any framework or none. Importing this
 * registers them.
 *
 * - `<weave-auth>` — the sign-in flow: where the data lives, which account,
 *   the ways into it. Fires `weave-session` when someone signs in or out.
 */
export { WeaveAuthElement, defineWeaveAuth } from './weave-auth.js';
export type { WeaveSessionEventDetail } from './weave-auth.js';
export { createWeaveAuth } from '../session/auth.js';
export type { WeaveAuth, WeaveAuthConfig, AuthState, WeaveSession } from '../session/auth.js';
