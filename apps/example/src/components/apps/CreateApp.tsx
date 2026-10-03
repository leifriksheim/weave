import { useState } from 'react';
import type { SpaceSummary } from '@weaveprotocol/core';
import { Modal } from '@weave/app-shared/Modal';
import { ConnectAgent, useKnownAgent } from '../ConnectAgent';
import { Icon } from '../Icon';
import { useMadeApps } from './MadeApps';
import { DESIGNS, designPrompt, type Design } from './designs';
import { styles, palette, ui, variants } from '../../styles';

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

/** The look picked last time, in this browser */
const DESIGN_KEY = 'weave:app-design';
const rememberedDesign = (): Design => {
  try {
    const id = globalThis.localStorage.getItem(DESIGN_KEY);
    return DESIGNS.find((one) => one.id === id) ?? DESIGNS[0]!;
  } catch {
    return DESIGNS[0]!;
  }
};

/** Making an app by describing it to an agent, which proposes it as a `std.app` record to add. */
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
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [design, setDesign] = useState(rememberedDesign);
  const pick = (next: Design) => {
    setDesign(next);
    try {
      globalThis.localStorage.setItem(DESIGN_KEY, next.id);
    } catch {
      // Only remembering the pick is lost.
    }
  };

  if (connecting) return <ConnectAgent onClose={() => setConnecting(false)} />;

  const what = idea.trim().replace(/[.\s]+$/, '');
  const prompt = `In my Weave space "${space.name}", make an app: ${what}. Use the standard collections where they fit, and propose it to the space, saying what is worth being notified about. ${designPrompt(design)}`;
  const agent = known ?? 'your agent';
  const adds = mayDefine ? 'you add it' : 'someone who runs the space adds it';
  const byHand = mayDefine ? onBuildByHand : undefined;

  const copy = () => {
    setBefore(new Set(apps.map((one) => one.key)));
    const clipboard = globalThis.navigator.clipboard;
    if (!clipboard) return setCopyFailed(true);
    clipboard.writeText(prompt).then(
      () => {
        setCopyFailed(false);
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopyFailed(true),
    );
  };
  const proposed = before && apps.find((one) => !before.has(one.key) && one.body)?.body;

  return (
    <Modal title="Create an app" onClose={onClose} width={560}>
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

      <DesignPicker value={design} onChange={pick} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={copy}
          disabled={!what}
          data-variant="primary"
          style={{ ...styles.button, ...action }}
        >
          {copied ? (
            '✓ Copied'
          ) : (
            <>
              <Icon name="sparkle" size={14} /> Copy prompt for {agent}
            </>
          )}
        </button>
        {!known && (
          <button
            type="button"
            onClick={() => setConnecting(true)}
            data-variant="quiet"
            style={{ ...variants.quiet, ...action }}
          >
            <Icon name="terminal" size={14} /> Connect an agent
          </button>
        )}
      </div>
      {copyFailed && <p style={promptBox}>{prompt}</p>}

      {proposed && (
        <div style={note}>
          <p style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
            <span style={{ color: palette.accent.good }}>✓</span> {known ?? 'Your agent'} proposed “
            {proposed.title}”
          </p>
          <p style={{ fontSize: 13, color: palette.ink.body }}>
            Nothing changes in {space.name} until {adds}.{' '}
            <button
              type="button"
              onClick={() => {
                onClose();
                onReview();
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              Review it
            </button>
          </p>
        </div>
      )}

      {(known || byHand) && (
        <div style={footer}>
          {known && (
            <span>
              <span style={{ color: palette.accent.good }}>✓</span> {known} connected ·{' '}
              <button
                type="button"
                onClick={() => setConnecting(true)}
                data-variant="ghost"
                style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
              >
                Change
              </button>
            </span>
          )}
          {byHand && (
            <button
              type="button"
              onClick={() => {
                onClose();
                byHand();
              }}
              data-variant="ghost"
              style={{ ...styles.linkButton, fontSize: 13, padding: 0 }}
            >
              Build one by hand
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

/** The looks, each as a small swatch of itself */
function DesignPicker({ value, onChange }: { value: Design; onChange: (design: Design) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
        Look <span style={{ fontWeight: 400, color: palette.ink.muted }}>· {value.blurb}</span>
      </span>
      <div
        role="radiogroup"
        aria-label="Look"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}
      >
        {DESIGNS.map((one) => {
          const on = one.id === value.id;
          return (
            <button
              key={one.id}
              type="button"
              role="radio"
              aria-checked={on}
              title={one.blurb}
              onClick={() => onChange(one)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                padding: '8px 2px 7px',
                borderRadius: 8,
                border: `1px solid ${on ? palette.ink.strong : palette.surface.line}`,
                boxShadow: on ? `0 0 0 1px ${palette.ink.strong}` : 'none',
                background: palette.surface.card,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 40,
                  height: 30,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: 4,
                  borderRadius: Math.min(one.swatch.radius, 8),
                  border: `1px solid ${palette.surface.line}`,
                  background: palette.surface.sunken,
                }}
              >
                <span
                  style={{
                    fontFamily: one.swatch.font,
                    fontWeight: one.swatch.weight,
                    fontSize: 11,
                    lineHeight: 1,
                    color: palette.ink.strong,
                    textAlign: 'left',
                  }}
                >
                  Aa
                </span>
                <span
                  style={{
                    alignSelf: 'flex-end',
                    width: 18,
                    height: 7,
                    borderRadius: Math.min(one.swatch.radius, 4),
                    background: one.swatch.accent,
                  }}
                />
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: on ? 600 : 500,
                  color: on ? palette.ink.strong : palette.ink.muted,
                }}
              >
                {one.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const note = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 8,
  background: palette.surface.sunken,
} as const;

const chip = { ...ui.chip, fontWeight: 400 };

const action = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '0 14px',
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
