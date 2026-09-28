/// <reference types="vite/client" />

/** What `relay.ts` reads; each app declares the rest of its own. */
interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`weave run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_WEAVE_NODES?: string;
}
