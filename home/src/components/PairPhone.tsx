import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PairingOffer, PairingStage } from 'weave-protocol/session';
import { useAuth } from 'weave-protocol/react';
import { servedOverLan, relayProblem, relayOnlyLocal } from '../relay';
import { Info } from './Info';
import { styles, palette } from '../styles';

/** What each stage of the handover should say out loud. */
function describe(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Waiting for your phone…';
    case 'connected':
      return 'Phone found. Sending your spaces…';
    case 'sent':
      return stage.spaces === 1 ? 'Sent 1 space. Done.' : `Sent ${stage.spaces} spaces. Done.`;
    case 'received':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

/**
 * Hands this account to a phone.
 *
 * The QR is a link, not data — phone cameras open links natively, so there is
 * no scanner here and it works on iOS as well as Android. The link carries the
 * recovery code in its fragment, which browsers never send to a server, so the
 * seed reaches the phone without passing through whatever is hosting this page.
 */
export function PairPhone() {
  const { auth } = useAuth();
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [stage, setStage] = useState<PairingStage | null>(null);
  const [starting, setStarting] = useState(false);
  const offerRef = useRef<PairingOffer | null>(null);

  // Stop listening when this panel goes away, or the relay connection leaks.
  useEffect(() => () => offerRef.current?.stop(), []);

  const start = async () => {
    setStarting(true);
    try {
      const started = await auth.offerToPhone(setStage);
      offerRef.current = started;
      setOffer(started);
      setQr(await QRCode.toDataURL(started.url, { width: 260, margin: 1 }));
    } catch (error) {
      setStage({ kind: 'failed', reason: error instanceof Error ? error.message : 'Could not start' });
    } finally {
      setStarting(false);
    }
  };

  const stop = () => {
    offerRef.current?.stop();
    offerRef.current = null;
    setOffer(null);
    setQr(null);
    setStage(null);
  };

  return (
    <details style={styles.panel}>
      <summary data-variant="ghost" style={styles.panelSummary}>Add your phone</summary>
      <div style={styles.panelBody}>
        {!offer ? (
          <>
            <p style={styles.errorHint}>
              Show a code and point your phone's camera at it.
              <Info label="What your phone becomes">
                The same account, with its own copy of every space — a peer in its own right rather
                than a screen for this one. It keeps working after you close this, and syncs with
                anyone in the space, not just this computer.
              </Info>
            </p>
            {(relayProblem() ?? relayOnlyLocal()) && <p style={styles.error}>{relayProblem() ?? relayOnlyLocal()}</p>}
            {!relayProblem() && !relayOnlyLocal() && !servedOverLan() && (
              <p style={styles.error}>
                This page is on localhost, which your phone cannot reach. Restart with{' '}
                <code>npm run dev -- --host</code> and open the network address it prints.
              </p>
            )}
            <button onClick={() => void start()} disabled={starting} data-variant="primary" style={styles.addButton}>
              {starting ? 'Starting…' : 'Show pairing code'}
            </button>
          </>
        ) : (
          <>
            {qr && (
              <img
                src={qr}
                alt="Pairing code"
                width={260}
                height={260}
                style={{
                  display: 'block',
                  margin: '14px auto',
                  padding: 12,
                  // A quiet zone in white is part of the code, not decoration:
                  // a camera needs the contrast to find the pattern.
                  background: '#fff',
                  border: `1px solid ${palette.surface.line}`,
                  borderRadius: palette.radius.md,
                }}
              />
            )}
            {stage && (
              <p style={stage.kind === 'failed' ? styles.error : styles.hint}>{describe(stage)}</p>
            )}
            <p style={styles.errorHint}>
              Anyone who photographs this gets the account.
              <Info label="What is in the code">
                Your account password, and the address of the relay that introduces the two devices.
                It travels in the part of the link after the <code>#</code>, which browsers never
                send to a server.
              </Info>
            </p>
            <div style={styles.linkRow}>
              <button onClick={stop} data-variant="ghost" style={styles.linkButton}>
                {stage?.kind === 'sent' ? 'Done' : 'Stop'}
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
