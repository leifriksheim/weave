import { useState } from 'react';
import type { NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useConnection } from '@weaveprotocol/core/react';
import { useSubscriptions } from '../../notifications';
import { Icon } from '../Icon';
import { styles, palette } from '../../styles';
import { WatchBuilder } from './WatchBuilder';
import { Empty, SectionHead, iconDot, list, row, section } from './parts';

/**
 * What you asked to hear about in a space: your own, seen by nobody else,
 * unlike the space's automations, which everyone shares. Added here, paused
 * or removed in your account.
 */
export function NotificationsView({
  space,
  collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const { state } = useConnection();
  const [adding, setAdding] = useState(false);
  const watches = useSubscriptions().filter((sub) => sub.spaces === 'all' || sub.spaces.includes(space.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 760 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Notifications</h2>
        <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.55 }}>
          Hear about what matters to you in {space.name}: a new message that mentions you, a task given to
          you. Only you see these.
        </p>
      </header>

      <section style={section}>
        <SectionHead
          title="Notify me"
          about="This app lets you know while it's open."
          action="New notification"
          onAction={() => setAdding(true)}
        />
        {watches.length === 0 ? (
          <Empty>You haven't asked to hear about anything here yet.</Empty>
        ) : (
          <ul style={list}>
            {watches.map((sub) => (
              <li key={sub.id} style={row}>
                <span style={iconDot}>
                  <Icon name={sub.paused ? 'bell' : 'bellOn'} size={14} />
                </span>
                <span style={{ flex: 1, minWidth: 0, opacity: sub.paused ? 0.55 : 1 }}>
                  <span style={{ display: 'block', color: palette.ink.strong, fontWeight: 500 }}>
                    {sub.label}
                  </span>
                  <span style={{ fontSize: 12.5, color: palette.ink.muted }}>
                    {sub.spaces === 'all' ? 'In all your spaces' : `In ${space.name}`}
                    {sub.where !== undefined ? ' · with conditions' : ''}
                    {sub.paused ? ' · paused' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {watches.length > 0 && (
          <button
            onClick={() =>
              globalThis.open(
                `${new URL('.', state.home).href}#notifications`,
                'weave-account',
                'popup,width=720,height=820',
              )
            }
            data-variant="ghost"
            style={{ ...styles.linkButton, alignSelf: 'flex-start' }}
          >
            Pause or remove them in your account ↗
          </button>
        )}
      </section>

      {adding && <WatchBuilder space={space} collections={collections} onClose={() => setAdding(false)} />}
    </div>
  );
}
