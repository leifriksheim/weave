import type { SpaceSummary } from '@weaveprotocol/core';
import { useNotifyFor } from '../../notifications';
import { Icon } from '../Icon';
import { styles, palette } from '../../styles';
import type { AppEntry } from './entries';

/**
 * The bell on an open app: notifications for what it says is worth hearing
 * about, in this space. Once they are on, it opens the account home, where
 * they are paused or removed.
 */
export function NotifyButton({ space, app }: { space: SpaceSummary; app: AppEntry }) {
  const { on, error, turnOn, manage } = useNotifyFor(space.id, app.notify);
  if (app.notify.length === 0) return null;
  const what = app.notify.map((n) => n.label).join(', ');
  return (
    <button
      onClick={on ? manage : turnOn}
      data-variant="quiet"
      title={error ?? (on ? `Notifying you: ${what}. Click to change.` : `Notify me: ${what}`)}
      aria-label={on ? 'Notifications on' : 'Notify me'}
      aria-pressed={on}
      style={{
        ...styles.smallButton,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: error ? palette.accent.danger : on ? palette.ink.strong : palette.ink.body,
      }}
    >
      <Icon name={on ? 'bellOn' : 'bell'} size={14} />
      <span className="bar-label">{on ? 'Notifying' : 'Notify me'}</span>
    </button>
  );
}
