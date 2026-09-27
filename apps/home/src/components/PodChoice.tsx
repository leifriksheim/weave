import { useState } from 'react';
import type { AuthError, Place, PodContents } from '@weaveprotocol/core/session';
import { Modal } from './Modal';
import { styles, palette } from '../styles';

/**
 * Asked after picking a pod while signed in, before anything changes.
 *
 * Two situations, told apart by what the pod already holds:
 *
 * - **The pod has never seen this account.** There is only one sensible
 *   thing to do — bring it in — so it is a confirmation, not a choice.
 * - **The pod already has this account.** Now there are two copies, and the
 *   person decides: combine them (safe: records are versioned, so nothing is
 *   overwritten), or just switch to the pod's copy and leave this one be.
 *
 * Other accounts in the pod are mentioned, because "will this touch my
 * partner's account?" is the question people actually have, and never touched.
 */
export function PodChoice({
  pod,
  contents,
  from,
  loading,
  error,
  onConfirm,
  onCancel,
}: {
  pod: Place;
  contents: PodContents;
  from: Place;
  loading: boolean;
  error: AuthError | null;
  onConfirm: (how: 'combine' | 'switch') => void;
  onCancel: () => void;
}) {
  const [how, setHow] = useState<'combine' | 'switch'>('combine');
  const podName = pod.directory?.name ?? 'this pod';
  const here = from.kind === 'folder' ? `in “${from.directory?.name ?? 'your current pod'}”` : 'in this browser';
  const others =
    contents.others > 0
      ? ` The pod also has ${contents.others} other ${contents.others === 1 ? 'account' : 'accounts'} — ${contents.others === 1 ? 'it' : 'they'} won't be touched.`
      : '';

  if (!contents.account) {
    return (
      <Modal title={`Move to “${podName}”?`} onClose={onCancel}>
        <p style={text}>
          Your account and all its spaces will be copied into this pod, and Weave will keep your data there from now on.
          {others}
        </p>
        <p style={note}>Nothing is deleted. The copy {here} stays until you remove it.</p>
        {error && <p style={styles.error}>{error.message}</p>}
        <Actions loading={loading} confirm="Move to pod" busy="Moving…" onConfirm={() => onConfirm('combine')} onCancel={onCancel} />
      </Modal>
    );
  }

  return (
    <Modal title={`“${podName}” already has your account`} onClose={onCancel}>
      <p style={text}>
        What should happen to the data {here}?{others}
      </p>
      <div role="radiogroup" aria-label="What to do with your data" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Choice
          checked={how === 'combine'}
          onSelect={() => setHow('combine')}
          title="Combine them"
          recommended
          description={`Bring everything ${here} into “${podName}”. Nothing is overwritten or lost — an item edited in both places is settled the same way your devices settle it when they sync.`}
        />
        <Choice
          checked={how === 'switch'}
          onSelect={() => setHow('switch')}
          title="Use the pod as it is"
          description={`Switch to the pod's copy and bring nothing over. Anything only ${here} stays behind.`}
        />
      </div>
      {error && <p style={styles.error}>{error.message}</p>}
      <Actions loading={loading} confirm="Continue" busy={how === 'combine' ? 'Combining…' : 'Switching…'} onConfirm={() => onConfirm(how)} onCancel={onCancel} />
    </Modal>
  );
}

function Choice({ checked, onSelect, title, description, recommended }: { checked: boolean; onSelect: () => void; title: string; description: string; recommended?: boolean }) {
  return (
    <button
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        textAlign: 'left',
        padding: 14,
        borderRadius: 8,
        border: `1px solid ${checked ? palette.ink.strong : palette.surface.line}`,
        background: palette.surface.card,
        width: '100%',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          marginTop: 2,
          flexShrink: 0,
          borderRadius: 999,
          border: `1px solid ${checked ? palette.ink.strong : palette.surface.lineStrong}`,
          boxShadow: checked ? `inset 0 0 0 4px ${palette.surface.card}` : 'none',
          background: checked ? palette.ink.strong : palette.surface.card,
        }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, fontSize: 14, color: palette.ink.strong }}>
          {title}
          {recommended && <span style={{ ...styles.badge, fontSize: 11 }}>Recommended</span>}
        </span>
        <span style={{ fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>{description}</span>
      </span>
    </button>
  );
}

function Actions({ loading, confirm, busy, onConfirm, onCancel }: { loading: boolean; confirm: string; busy: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
      <button onClick={onCancel} disabled={loading} data-variant="quiet" style={{ ...styles.smallButton, height: 36 }}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={loading} data-variant="primary" style={{ ...styles.addButton, height: 36 }}>
        {loading ? busy : confirm}
      </button>
    </div>
  );
}

const text = { fontSize: 14, lineHeight: 1.6, color: palette.ink.body };
const note = { fontSize: 13, lineHeight: 1.5, color: palette.ink.muted };
