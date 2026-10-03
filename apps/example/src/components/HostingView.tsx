import type { SpaceSummary } from '@weaveprotocol/core';
import { SpaceHosting } from '@weave/app-shared/SpaceHosting';
import { SpaceBots } from '@weave/app-shared/CommunitySetup';
import { styles, palette } from '../styles';

/** Keeping a space online: its host, its fund, and the AI helpers that host runs */
export function HostingView({ space, onAutomations }: { space: SpaceSummary; onAutomations: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, maxWidth: 760 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Hosting</h2>
        <p style={{ fontSize: 14, color: palette.ink.muted, lineHeight: 1.55 }}>
          Keep {space.name} reachable when everyone is offline, paid from one fund anyone here can add to. The
          host keeps it encrypted and can't read it.
        </p>
      </header>
      <SpaceHosting spaceId={space.id} writable={space.writable} />
      <SpaceBots spaceId={space.id} writable={space.writable} onAutomations={onAutomations} />
    </div>
  );
}
