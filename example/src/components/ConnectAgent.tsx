import { useEffect, useRef, useState } from 'react';
import { connectToHome, offerAgentLink, type AgentAsking, type AgentLinkStage } from '@weaveprotocol/core/session';
import { useConnection } from '@weaveprotocol/core/react';
import { Choice, Modal } from './Modal';
import { relayUrls } from '../relay';
import { styles, palette, variants } from '../styles';

/** What people run, before the code */
const COMMAND = import.meta.env.VITE_WEAVE_CONNECT ?? 'npx @weaveprotocol/cli connect';
/** The relay the CLI meets on unless told otherwise (`cli/src/agent.ts`) */
const CLI_RELAY = 'wss://p2p-web-relay.fly.dev';

const LASTS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '1 week' },
  { value: '30', label: '30 days' },
  { value: '365', label: '1 year' },
] as const;
type Lasts = (typeof LASTS)[number]['value'];

type Step =
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'asking'; readonly stage: Extract<AgentLinkStage, { kind: 'asking' }> }
  | { readonly kind: 'connected'; readonly agent: AgentAsking }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Connecting an agent on this computer — Claude Code, Claude Desktop, Cursor.
 *
 * Shows one command to paste in a terminal. When it runs, the terminal turns
 * up here and says who it is; a click opens the account home, which signs it
 * an agent's note for the whole account, for as long as chosen. From then on
 * it is a node of its own, and this tab can close. An agent in this browser
 * needs none of this: it works as you, over WebMCP (`webmcp.ts`).
 */
export function ConnectAgent({ onClose }: { onClose: () => void }) {
  const { state } = useConnection();
  const [days, setDays] = useState<Lasts>('30');
  const [step, setStep] = useState<Step>({ kind: 'starting' });
  const [code, setCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let stop = () => {};
    setStep({ kind: 'starting' });
    setCode(null);
    void offerAgentLink({ relays: relayUrls() }, (stage) => {
      if (stopped) return;
      setStep(stage.kind === 'asking' ? { kind: 'asking', stage } : stage);
    }).then(
      (offer) => {
        if (stopped) return offer.stop();
        stop = offer.stop;
        setCode(offer.code);
      },
      (e: unknown) => !stopped && setStep({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      stopped = true;
      stop();
    };
  }, [attempt]);

  const relays = relayUrls();
  const command = code ? `${COMMAND} ${code}${relays.includes(CLI_RELAY) || !relays[0] ? '' : ` --relay ${relays[0]}`}` : '';

  const copy = () => {
    void globalThis.navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1500);
    });
  };

  const allow = (stage: Extract<AgentLinkStage, { kind: 'asking' }>) => {
    setBusy(true);
    setError(null);
    // From the click itself: the home opens in a popup.
    connectToHome({
      home: state.home,
      audience: stage.agent.did,
      request: { name: stage.agent.name, access: 'write', scope: 'account', chooseSpaces: false, agent: true, days: Number(days) },
    })
      .then((grant) => stage.allow(grant))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Connect an agent" onClose={onClose}>
      <p style={{ ...styles.hint, marginBottom: 0 }}>
        Lets Claude Code, Claude Desktop or Cursor work in your spaces — even with this tab closed. What it writes shows “via agent”. It can
        propose apps; adding one is always yours.
      </p>

      {step.kind === 'connected' ? (
        <Connected agent={step.agent} onClose={onClose} />
      ) : step.kind === 'failed' ? (
        <>
          <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{step.reason}</p>
          <button onClick={() => setAttempt((n) => n + 1)} data-variant="primary" style={styles.button}>
            Make a new code
          </button>
        </>
      ) : step.kind === 'asking' ? (
        <>
          <div style={note}>
            <p style={styles.todoText}>“{step.stage.agent.name}” wants to connect</p>
            <p style={styles.errorHint}>
              It gets every space in your account, for {LASTS.find((option) => option.value === days)!.label}. Your account home opens to confirm.
            </p>
          </div>
          <Choice label="How long it may work" value={days} options={LASTS} onChange={setDays} />
          {error && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => step.stage.deny()} disabled={busy} data-variant="quiet" style={variants.quiet}>
              Don't allow
            </button>
            <button onClick={() => allow(step.stage)} disabled={busy} data-variant="primary" style={styles.button}>
              {busy ? 'Waiting for your account home…' : 'Allow'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <p style={styles.fieldLabel}>Run this in a terminal</p>
            <div style={commandBox}>
              <code style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 12.5, lineHeight: 1.5, color: palette.ink.strong }}>
                {command || 'Making a code…'}
              </code>
              <button onClick={copy} disabled={!code} data-variant="quiet" style={{ ...variants.quiet, width: 'auto', height: 30, padding: '0 10px', fontSize: 13 }}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <Choice label="How long it may work" value={days} options={LASTS} onChange={setDays} />
          <p style={{ ...styles.footerHint, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Pulse /> Waiting for your terminal. Keep this open until it's connected.
          </p>
        </>
      )}
    </Modal>
  );
}

function Connected({ agent, onClose }: { agent: AgentAsking; onClose: () => void }) {
  return (
    <>
      <div style={note}>
        <p style={{ ...styles.todoText, color: palette.accent.good }}>✓ Connected: {agent.name}</p>
        <p style={styles.errorHint}>
          It was added to Claude Code, Claude Desktop and Cursor, where they're installed — start a new session there, or restart the app,
          to use it. You can disconnect it any time in your account settings.
        </p>
      </div>
      <button onClick={onClose} data-variant="primary" style={styles.button}>
        Done
      </button>
    </>
  );
}

/** A small dot that breathes while waiting */
function Pulse() {
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const animation = dot.current?.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 1400, iterations: Infinity });
    return () => animation?.cancel();
  }, []);
  return <span ref={dot} style={{ width: 7, height: 7, borderRadius: 999, background: palette.ink.muted, flexShrink: 0 }} />;
}

const note = {
  padding: '12px 14px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
} as const;

const commandBox = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 10px 10px 12px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
  fontFamily: palette.mono,
} as const;
