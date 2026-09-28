import { useState, type ReactNode } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { Modal } from '@weave/app-shared/Modal';
import { ConnectAgent } from '../ConnectAgent';
import { Icon } from '../Icon';
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

/**
 * Making a new app for a space, by describing it to an agent.
 *
 * The agent works in the space through the CLI's MCP server (or this page's
 * WebMCP tools) and proposes the app as a `std.app` record. Nothing is added
 * until someone who may add collections adds it on the Apps screen, so the
 * dialog only has to get the idea and the agent together. Building one by
 * hand, from a collection's fields, stays one click away.
 */
export function CreateApp({
  space,
  mayDefine,
  onClose,
  onBuildByHand,
}: {
  space: SpaceSummary;
  mayDefine: boolean;
  onClose: () => void;
  onBuildByHand?: () => void;
}) {
  const [idea, setIdea] = useState('');
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);

  if (connecting) return <ConnectAgent onClose={() => setConnecting(false)} />;

  const what = idea.trim().replace(/[.\s]+$/, '');
  const prompt = `In my Weave space "${space.name}", make an app: ${what ? `${what}.` : '…'} Use the standard collections where they fit, and propose it to the space.`;
  const copy = () => {
    void globalThis.navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal title="Create an app" onClose={onClose}>
      <p style={{ ...styles.hint, marginBottom: 0 }}>
        Say what {space.name} needs and an AI agent builds it for you. It shows up on the Apps screen as a
        proposal, and nothing changes until {mayDefine ? 'you add it' : 'someone who runs the space adds it'}.
      </p>

      <Step n={1} title="Describe it">
        <textarea
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="A place to plan our summer trip, with a packing list and who's driving"
          rows={3}
          aria-label="What the app should do"
          style={{
            ...styles.input,
            height: 'auto',
            padding: '10px 12px',
            lineHeight: 1.5,
            resize: 'vertical',
          }}
        />
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
      </Step>

      <Step n={2} title="Give it to your agent">
        <div style={promptBox}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5, color: palette.ink.body }}>
            {prompt}
          </span>
          <button
            onClick={copy}
            disabled={!idea.trim()}
            data-variant="quiet"
            style={{ ...variants.quiet, width: 'auto', height: 30, padding: '0 10px', fontSize: 13 }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          Paste it into Claude Code, Claude Desktop or Cursor once it's connected to your account. An agent
          running in this browser can use this page directly.
        </p>
        <button
          onClick={() => setConnecting(true)}
          data-variant="primary"
          style={{
            ...styles.button,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Icon name="terminal" /> Connect an agent
        </button>
      </Step>

      {onBuildByHand && mayDefine && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onBuildByHand();
          }}
          data-variant="ghost"
          style={{ ...styles.linkButton, alignSelf: 'center' }}
        >
          Or build one by hand from a collection's fields
        </button>
      )}
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 14,
          fontWeight: 600,
          color: palette.ink.strong,
        }}
      >
        <span style={stepNumber}>{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

const stepNumber = {
  width: 20,
  height: 20,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  background: palette.ink.strong,
  color: '#fff',
  fontSize: 11,
  fontWeight: 600,
} as const;

const chip = {
  height: 28,
  padding: '0 10px',
  borderRadius: 999,
  background: palette.surface.card,
  color: palette.ink.body,
  fontSize: 12.5,
} as const;

const promptBox = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '10px 10px 10px 12px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
} as const;
