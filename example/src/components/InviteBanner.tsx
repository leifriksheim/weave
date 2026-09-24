import { useState } from 'react';
import type { SpaceSummary } from 'weave-protocol';
import { useNode } from 'weave-protocol/react';
import { clearInviteFromUrl, previewInvite, readInviteFromUrl } from '../spaces';
import { styles } from '../styles';

/** Offered when the page was opened from a share link: join the space, or not now. */
export function InviteBanner({ onJoin }: { onJoin: (invite: string) => Promise<SpaceSummary | null> }) {
  const node = useNode();
  const [invite, setInvite] = useState(readInviteFromUrl);
  if (!invite) return null;

  const done = () => {
    setInvite(null);
    clearInviteFromUrl();
  };

  let description = 'a space';
  let detail = '';
  try {
    const preview = previewInvite(node, invite);
    description = `“${preview.space.name}”`;
    detail = `${preview.space.visibility} · ${
      preview.space.type === 'shared' ? (preview.carriesWrite ? 'shared' : 'shared, view only') : 'personal'
    } · invited by ${preview.invitedBy.slice(-6)}`;
  } catch {
    detail = 'This invite could not be read.';
  }

  return (
    <div style={styles.inviteBanner}>
      <p style={styles.todoText}>You were invited to {description}</p>
      <p style={styles.todoMeta}>{detail}</p>
      <div style={styles.linkRow}>
        <button onClick={() => void onJoin(invite).then(done)} data-variant="primary" style={styles.addButton}>
          Join this space
        </button>
        <button onClick={done} data-variant="ghost" style={styles.linkButton}>
          Not now
        </button>
      </div>
    </div>
  );
}
