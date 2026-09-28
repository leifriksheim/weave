import { useEffect, useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { Modal } from '@weave/app-shared/Modal';
import { ConnectAgent, Pulse, useKnownAgent } from '../ConnectAgent';
import { Icon } from '../Icon';
import { useMadeApps } from './MadeApps';
import { styles, palette, variants } from '../../styles';

/** Things a group might ask for, to start from */
const IDEAS = [
  { label: 'Potluck sign-up', text: 'a potluck sign-up, where everyone says what they bring' },
  {
    label: 'Reading list',
    text: 'a reading list: what we are reading, when we meet, and a rating from each of us',
  },
  { label: 'Shopping list', text: 'a shared shopping list we can tick off in the shop' },
  { label: 'Chore rota', text: 'a chore rota that takes turns, week by week' },
] as const;

/** How long to wait for a proposal before suggesting the agent isn't connected */
const PATIENCE = 60_000;

/**
 * Making a new app for a space, by describing it to an agent.
 *
 * The agent works in the space through the CLI's MCP server (or this page's
 * WebMCP tools) and proposes the app as a `std.app` record. Nothing is added
 * until someone who may add collections adds it on the Apps screen, so the
 * dialog only has to get the idea and the agent together: describe it, copy
 * the prompt, paste it. Whether an agent is connected is only a hint from
 * this browser, so it never blocks copying; what shows it worked is the
 * proposal turning up in the space, which the dialog waits for.
 */
export function CreateApp({
  space,
  mayDefine,
  onClose,
  onReview,
  onBuildByHand,
}: {
  space: SpaceSummary;
  mayDefine: boolean;
  onClose: () => void;
  /** Shows the space's apps, where proposals are added */
  onReview: () => void;
  onBuildByHand?: () => void;
}) {
  const known = useKnownAgent();
  const apps = useMadeApps(space);
  const [idea, setIdea] = useState('');
  const [connecting, setConnecting] = useState(false);
  // The apps there were when the prompt was copied; one not among them is the answer.
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!before) return;
    const timer = globalThis.setTimeout(() => setSlow(true), PATIENCE);
    return () => globalThis.clearTimeout(timer);
  }, [before]);

  if (connecting) return <ConnectAgent onClose={() => setConnecting(false)} />;

  const what = idea.trim().replace(/[.\s]+$/, '');
  const prompt = `In my Weave space "${space.name}", make an app: ${what}. Use the standard collections where they fit, and propose it to the space, saying what is worth being notified about.`;
  const agent = known ?? 'your agent';
  const adds = mayDefine ? 'you add it' : 'someone who runs the space adds it';

  const copy = () => {
    setBefore(new Set(apps.map((one) => one.key)));
    setSlow(false);
    const clipboard = globalThis.navigator.clipboard;
    if (!clipboard) return setCopyFailed(true);
    clipboard.writeText(prompt).then(
      () => setCopyFailed(false),
      () => setCopyFailed(true),
    );
  };

  if (before) {
    const proposed = apps.find((one) => !before.has(one.key) && one.body);
    if (proposed?.body)
      return (
        <Modal title="Create an app" onClose={onClose}>
          <Headline>
            <span style={{ color: palette.accent.good }}>✓</span> {known ?? 'Your agent'} proposed “
            {proposed.body.title}”
          </Headline>
          <p style={styles.hint}>
            It's under Apps with what it would allow. Nothing changes in {space.name} until {adds}.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} data-variant="quiet" style={variants.quiet}>
              Later
            </button>
            <button
              onClick={() => {
                onClose();
                onReview();
              }}
              data-variant="primary"
              style={styles.button}
            >
              Review it
            </button>
          </div>
        </Modal>
      );

    return (
      <Modal title="Create an app" onClose={onClose}>
        <Headline>
          {copyFailed ? (
            'Copy the prompt'
          ) : (
            <>
              <span style={{ color: palette.accent.good }}>✓</span> Copied. Paste it into {agent}
            </>
          )}
        </Headline>
        {copyFailed && <p style={promptBox}>{prompt}</p>}
        <p style={styles.hint}>
          When it's done, the app turns up here and under Apps as a proposal. Nothing changes in {space.name}{' '}
          until {adds}.
        </p>
        <p style={{ ...styles.footerHint, textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pulse /> Waiting for the proposal. You can close this; it will still arrive.
        </p>
        {slow && (
          <p style={{ fontSize: 13, color: palette.ink.body }}>
            Nothing yet?{' '}
            {known ? `Check ${known} is still connected, or ` : 'Your agent may not be connected: '}
            <button
              type="button"
              onClick={() => setConnecting(true)}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              connect an agent
            </button>
            .
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setBefore(null)} data-variant="quiet" style={variants.quiet}>
            Back
          </button>
          <button onClick={onClose} data-variant="primary" style={styles.button}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create an app" onClose={onClose}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
          What should {space.name} have?
        </span>
        <textarea
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="A place to plan our summer trip, with a packing list and who's driving"
          rows={3}
          style={{
            ...styles.input,
            height: 'auto',
            padding: '10px 12px',
            lineHeight: 1.5,
            resize: 'vertical',
          }}
        />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {IDEAS.map((one) => (
          <button
            key={one.label}
            type="button"
            onClick={() => setIdea(one.text)}
            data-variant="quiet"
            style={chip}
          >
            {one.label}
          </button>
        ))}
      </div>

      <button
        onClick={copy}
        disabled={!what}
        data-variant="primary"
        style={{
          ...styles.button,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Icon name="sparkle" size={14} /> Copy prompt for {agent}
      </button>

      <div style={footer}>
        <span>
          {known ? (
            <>
              <span style={{ color: palette.accent.good }}>✓</span> {known} connected
            </>
          ) : (
            'No agent connected from this browser'
          )}
          {' · '}
          <button
            type="button"
            onClick={() => setConnecting(true)}
            data-variant="ghost"
            style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
          >
            {known ? 'Change' : 'Connect one'}
          </button>
        </span>
        {onBuildByHand && mayDefine && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onBuildByHand();
            }}
            data-variant="ghost"
            style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
          >
            Build one by hand
          </button>
        )}
      </div>
    </Modal>
  );
}

function Headline({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 15, fontWeight: 600, color: palette.ink.strong }}>{children}</p>;
}

const chip = {
  height: 28,
  padding: '0 10px',
  borderRadius: 999,
  background: palette.surface.card,
  color: palette.ink.body,
  fontSize: 12.5,
} as const;

const footer = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  paddingTop: 12,
  borderTop: `1px solid ${palette.surface.line}`,
  fontSize: 13,
  color: palette.ink.muted,
} as const;

const promptBox = {
  padding: '10px 12px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
  fontSize: 13,
  lineHeight: 1.5,
  color: palette.ink.body,
  userSelect: 'all',
} as const;
