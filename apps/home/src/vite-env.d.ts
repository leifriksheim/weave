/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`weave run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_WEAVE_NODES?: string;
  /** The host offered under "Keep my spaces online" (`weave host`), e.g. https://host.example */
  readonly VITE_WEAVE_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
