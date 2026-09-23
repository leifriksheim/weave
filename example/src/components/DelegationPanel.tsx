import { useState } from 'react';
import { delegateToGuest, type GuestDelegation, type Session } from '../protocol';
import { styles } from '../styles';

const short = (did: string) => `${did.slice(0, 14)}…${did.slice(-6)}`;

/** Shows the live UCAN chain: root identity → this tab's session key → a guest. */
export function DelegationPanel({ session, spaceId }: { session: Session; spaceId: string }) {
  const [guest, setGuest] = useState<GuestDelegation | null>(null);
  const [busy, setBusy] = useState(false);

  const { payload } = session.node.delegation();
  const expiresIn = Math.max(0, Math.round((payload.exp * 1000 - Date.now()) / 60000));

  const handleDelegate = async () => {
    setBusy(true);
    try {
      setGuest(await delegateToGuest(spaceId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details style={styles.panel}>
      <summary data-variant="ghost" style={styles.panelSummary}>UCAN delegation chain</summary>
      <div style={styles.panelBody}>
        <div style={styles.chain}>
          <div style={styles.chainRow}>
            <span>root</span>
            <span>{short(payload.iss)}</span>
          </div>
          <div style={styles.chainRow}>
            <span style={styles.chainArrow}>↳</span>
            <span>grants</span>
            <span style={styles.ok}>
              {payload.att.map((c) => `${c.can} on ${c.with}`).join(', ')}
            </span>
            <span>· expires in {expiresIn}m</span>
          </div>
          <div style={styles.chainRow}>
            <span>session</span>
            <span>{short(payload.aud)}</span>
          </div>
        </div>

        <p>
          The session key lives in memory only. It signs every todo in this tab, and the UCAN
          above is what proves the root identity allowed it to.
        </p>

        <button onClick={handleDelegate} disabled={busy} data-variant="primary" style={styles.addButton}>
          {busy ? 'Delegating…' : 'Attenuate to a read-only guest'}
        </button>

        {guest && (
          <>
            <div style={styles.chain}>
              <div style={styles.chainRow}>
                <span style={styles.chainArrow}>↳</span>
                <span>grants</span>
                <span style={styles.ok}>
                  {guest.token.payload.att.map((c) => `${c.can} on ${c.with}`).join(', ')}
                </span>
              </div>
              <div style={styles.chainRow}>
                <span>guest</span>
                <span>{short(guest.guestDid)}</span>
              </div>
              <div style={styles.chainRow}>
                <span style={guest.chainValid ? styles.ok : styles.bad}>
                  {guest.chainValid
                    ? '✓ chain validates back to the root DID'
                    : `✗ ${guest.reason ?? 'chain invalid'}`}
                </span>
              </div>
            </div>
            <code style={styles.token}>{guest.token.encoded}</code>
          </>
        )}
      </div>
    </details>
  );
}
