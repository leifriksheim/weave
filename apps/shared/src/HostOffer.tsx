import { useEffect, useState, type ReactNode } from 'react';
import { describeHost, type HostDescription } from '@weaveprotocol/core';
import { DEFAULT_HOST } from './relay';
import { HostAddressForm, type Wanted } from './HostAddress';
import { FeatureIcon, StatusPill, type Tone } from './Feature';
import { styles, palette } from './styles';

/** The host this build offers, with its name and price; `asked` once it answered or failed to */
export function useOffer() {
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [asked, setAsked] = useState(!DEFAULT_HOST);
  useEffect(() => {
    if (!DEFAULT_HOST) return;
    void describeHost(DEFAULT_HOST)
      .then(setOffer, () => {})
      .finally(() => setAsked(true));
  }, []);
  return { offer, asked };
}

/** Calls `ask` now, and again when the tab comes back (from a checkout page in another tab) */
export function useAskAgain(ask: () => unknown) {
  useEffect(() => {
    void ask();
    const again = () => document.visibilityState === 'visible' && void ask();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [ask]);
}

/**
 * Choosing a host: the one this build offers with its price and Continue, or
 * another by its address.
 */
export function HostOfferPicker({
  offer,
  price,
  busy,
  onContinue,
  onAddress,
  addressLabel,
}: {
  offer: HostDescription | null;
  price: string;
  busy: boolean;
  onContinue: () => void;
  onAddress: (url: string, wanted: Wanted) => Promise<void>;
  addressLabel?: string;
}) {
  const [other, setOther] = useState(false);
  if (other || !offer)
    return (
      <>
        <HostAddressForm onAddress={onAddress} {...(addressLabel ? { label: addressLabel } : {})} />
        {offer && (
          <button onClick={() => setOther(false)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
            Use {offer.name} instead
          </button>
        )}
      </>
    );
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 12,
          padding: '12px 14px',
          borderRadius: 10,
          background: palette.surface.sunken,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 500, color: palette.ink.strong }}>{offer.name}</span>
        <span style={{ fontSize: 13, color: palette.ink.muted }}>{price}</span>
      </div>
      <button onClick={onContinue} disabled={busy} data-variant="primary" style={styles.button}>
        {busy ? 'One moment…' : 'Continue'}
      </button>
      <button onClick={() => setOther(true)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
        Use another host
      </button>
    </>
  );
}

/** What went wrong, then Keep it and Stop using, at the foot of a dialog that stops a host */
export function StopFooter({
  name,
  busy,
  error,
  onKeep,
  onStop,
}: {
  name: string;
  busy: boolean;
  error: string | null;
  onKeep: () => void;
  onStop: () => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" style={{ fontSize: 13, color: palette.accent.danger }}>
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
        <button onClick={onKeep} disabled={busy} data-variant="quiet" style={styles.smallButton}>
          Keep it
        </button>
        <button
          onClick={onStop}
          disabled={busy}
          data-variant="danger"
          style={{ ...styles.smallButton, color: palette.accent.danger }}
        >
          {busy ? 'Stopping…' : `Stop using ${name}`}
        </button>
      </div>
    </>
  );
}

/** A host's name with a pill for how it stands, a line under it, and its actions to the right */
export function HostStatusRow({
  name,
  pill,
  line,
  size,
  children,
}: {
  name: ReactNode;
  pill: { tone: Tone; pill: string } | null;
  line: ReactNode;
  size: number;
  children: ReactNode;
}) {
  return (
    <>
      <FeatureIcon kind="online" glyph="cloud" size={size} />
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, color: palette.ink.strong }}>{name}</strong>
          {pill && <StatusPill tone={pill.tone}>{pill.pill}</StatusPill>}
        </div>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2, overflowWrap: 'anywhere' }}>
          {line}
        </p>
      </div>
      <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</span>
    </>
  );
}
