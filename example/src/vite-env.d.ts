/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`p2p run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_P2P_NODES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
