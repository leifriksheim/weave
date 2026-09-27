/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the signaling relay lives, e.g. ws://localhost:8787 */
  readonly VITE_SIGNALING_URL?: string;
  /** Always-on nodes (`weave run`), comma separated, e.g. ws://localhost:8787/peer */
  readonly VITE_WEAVE_NODES?: string;
  /** The account home's connect page, e.g. http://localhost:5174/connect */
  readonly VITE_WEAVE_HOME?: string;
  /** What "Connect an agent" tells people to run, before the code. Default `npx @weaveprotocol/cli connect` */
  readonly VITE_WEAVE_CONNECT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
