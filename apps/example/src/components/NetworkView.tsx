import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { CarrierSummary, MeshStatus, RelayStatus, SpaceStatus, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useAccount, useNetwork, useNode } from '@weaveprotocol/core/react';
import { Avatar } from '@weave/app-shared/Avatar';
import {
  duration,
  healthOf,
  nextRetry,
  peerKind,
  relayLine,
  relayName,
  type Health,
  type PeerKind,
} from '../derive/network';
import { styles, palette } from '../styles';
import { Person } from './Person';

/** The time now, a second at a time, for countdowns and "for 4 min" */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The colour of each health, and of each relay state, as a dot */
export const HEALTH_COLOR: Record<Health, string> = {
  syncing: palette.accent.good,
  alone: palette.ink.faint,
  connecting: '#d08700',
  elsewhere: '#d08700',
  offline: palette.accent.danger,
};

const RELAY_COLOR: Record<RelayStatus['state'], string> = {
  open: palette.accent.good,
  connecting: '#d08700',
  waiting: palette.accent.danger,
  stopped: palette.ink.faint,
};

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
      }}
    />
  );
}

/**
 * Everything about how this space reaches other devices: whether it is, who
 * it is syncing with, the relays that introduce peers, and the connections
 * this device is holding or trying to make. Made to answer "why isn't my
 * other device here?" without opening the console.
 */
export function NetworkView({ space, status }: { space: SpaceSummary; status: SpaceStatus | undefined }) {
  const node = useNode();
  const network = useNetwork();
  const access = useAccess(space.id);
  const now = useNow();
  const health = healthOf(status, network);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <Summary
        health={health}
        status={status}
        network={network}
        now={now}
        onRetry={() => node.network.reconnect()}
      />
      {status && <Peers status={status} />}
      <Relays
        network={network}
        own={access?.relays ?? []}
        now={now}
        onRetry={() => node.network.reconnect()}
      />
      <Connections network={network} status={status} now={now} />
      {status && <SyncFacts status={status} />}
      <HowItWorks />
    </div>
  );
}

// ─── The one sentence ───────────────────────────────────────────────

function Summary({
  health,
  status,
  network,
  now,
  onRetry,
}: {
  health: Health;
  status: SpaceStatus | undefined;
  network: MeshStatus;
  now: number;
  onRetry: () => void;
}) {
  const retry = nextRetry(network);
  const peers = status?.peers.length ?? 0;
  const copy: Record<Health, [string, ReactNode]> = {
    syncing: [
      `Syncing with ${peers} ${peers === 1 ? 'device' : 'devices'}`,
      'Changes here reach them within a moment, and theirs reach you.',
    ],
    alone: [
      'Online, waiting for others',
      'The relay is reachable, but none of your other devices or the people in this space have it open right now. They will connect as soon as one does.',
    ],
    connecting: [
      network.connecting.length > 0 ? `Connecting to ${network.connecting.length} …` : 'Connecting…',
      'Finding the relay and the devices in this space.',
    ],
    elsewhere: [
      'Open in another tab',
      `This app is connected in another tab or window, and only one of them can be at a time: they share one key, and the relay lets it in once. Close the other one and this one connects${retry?.retryAt ? ` — next try in ${duration(retry.retryAt - now)}` : ''}.`,
    ],
    offline: [
      "Can't reach the relay",
      network.relays.length === 0
        ? 'No relay is configured, so this device cannot find any other.'
        : retry?.retryAt
          ? `Nothing leaves this device until it can. Trying again in ${duration(retry.retryAt - now)}. Your changes are saved here and go out once it's back.`
          : 'Nothing leaves this device until it can. Your changes are saved here and go out once it is back.',
    ],
  };
  const [title, text] = copy[health];

  return (
    <section
      aria-label="Connection"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: 18,
        borderRadius: palette.radius.lg,
        border: `1px solid ${health === 'offline' ? palette.accent.danger : palette.surface.line}`,
        backgroundColor: health === 'offline' ? palette.accent.dangerSoft : palette.surface.sunken,
      }}
    >
      <span style={{ paddingTop: 7 }}>
        <Dot color={HEALTH_COLOR[health]} size={10} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 18 }}>{title}</h2>
        <p style={{ fontSize: 14, color: palette.ink.body, marginTop: 4, lineHeight: 1.6 }}>{text}</p>
      </div>
      {retry && (
        <button type="button" onClick={onRetry} style={styles.smallButton}>
          Try now
        </button>
      )}
    </section>
  );
}

// ─── Who is here ───────────────────────────────────────────────────

const KIND_LABEL: Record<PeerKind, string> = {
  mine: 'Your device',
  person: 'Member',
  carrier: 'Carrier · keeps the space online, cannot read it',
  server: "Server · didn't say whose it is",
};

function Peers({ status }: { status: SpaceStatus }) {
  const node = useNode();
  const { did: me } = useAccount();
  const [carriers, setCarriers] = useState<ReadonlyArray<CarrierSummary>>([]);
  const carrierKeys = status.carriers.join(',');
  useEffect(() => {
    if (!carrierKeys) return;
    void node.carriers
      .list()
      .then(setCarriers)
      .catch(() => {});
  }, [node, carrierKeys]);

  return (
    <Section title="In this space" hint="Devices syncing this space with you right now, and whose they are.">
      {status.peers.length === 0 ? (
        <p style={empty}>Nobody else right now.</p>
      ) : (
        <ul style={list}>
          {status.peers.map((peer) => {
            const kind = peerKind(peer, status, me);
            const account = status.accounts[peer];
            const carrier = carriers.find((c) => c.did === peer);
            return (
              <li key={peer} style={row}>
                <Avatar did={account ?? peer} size={24} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: palette.ink.strong }}>
                    {kind === 'mine' ? (
                      'You, on another device'
                    ) : kind === 'carrier' ? (
                      (carrier?.name ?? 'A carrier')
                    ) : account ? (
                      <Person did={account} />
                    ) : (
                      'A server'
                    )}
                  </div>
                  <div style={meta}>
                    {KIND_LABEL[kind]} · <Mono>{short(peer)}</Mono>
                  </div>
                </div>
                <Dot color={palette.accent.good} />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ─── Relays ────────────────────────────────────────────────────────

function Relays({
  network,
  own,
  now,
  onRetry,
}: {
  network: MeshStatus;
  own: ReadonlyArray<string>;
  now: number;
  onRetry: () => void;
}) {
  const waiting = network.relays.some((relay) => relay.state === 'waiting');
  return (
    <Section
      title="Relays"
      hint="A relay introduces devices to each other. It never sees your data, and once two devices are connected they talk directly."
      action={
        waiting ? (
          <button type="button" onClick={onRetry} style={styles.smallButton}>
            Reconnect now
          </button>
        ) : null
      }
    >
      {network.relays.length === 0 ? (
        <p style={empty}>No relay configured. This device can only reach nodes it is given directly.</p>
      ) : (
        <ul style={list}>
          {network.relays.map((relay) => (
            <li key={relay.url} style={{ ...row, alignItems: 'flex-start' }}>
              <span style={{ paddingTop: 6 }}>
                <Dot color={RELAY_COLOR[relay.state]} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: palette.ink.strong }}>
                  <Mono>{relayName(relay.url)}</Mono>
                </div>
                <div style={meta}>{relayLine(relay, now)}</div>
                {relay.problem && relay.state !== 'open' && (
                  <div style={{ ...meta, color: palette.accent.danger }}>{relay.problem}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {own.length > 0 && (
        <p style={{ ...meta, marginTop: 10 }}>
          This space names {own.map(relayName).join(', ')} as where its members meet, so they find each other
          there whichever relays their apps use.
        </p>
      )}
      <p style={{ ...meta, marginTop: own.length > 0 ? 0 : 10 }}>
        {network.turn
          ? 'A relay offered TURN, so devices on strict networks can still connect through it.'
          : 'No TURN offered: two devices behind strict firewalls may not be able to connect.'}
      </p>
    </Section>
  );
}

// ─── Connections ───────────────────────────────────────────────────

function Connections({
  network,
  status,
  now,
}: {
  network: MeshStatus;
  status: SpaceStatus | undefined;
  now: number;
}) {
  const here = new Set(status?.peers ?? []);
  const elsewhere = network.links.filter((link) => !here.has(link.peer));
  if (network.connecting.length === 0 && elsewhere.length === 0) return null;
  return (
    <Section
      title="On this device"
      hint="Connections this device holds for all your spaces, and the ones it is still trying to make. A connection that doesn't open within a while is given up and tried again."
    >
      <ul style={list}>
        {network.connecting.map((attempt) => (
          <li key={attempt.peer} style={row}>
            <Dot color={RELAY_COLOR.connecting} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: palette.ink.strong }}>
                Connecting to <Mono>{short(attempt.peer)}</Mono>
              </div>
              <div style={meta}>
                For {duration(now - attempt.since)}
                {attempt.tries > 0 && ` · try ${attempt.tries + 1}`}
              </div>
            </div>
          </li>
        ))}
        {elsewhere.map((link) => (
          <li key={link.peer} style={row}>
            <Dot color={palette.ink.faint} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, color: palette.ink.strong }}>
                <Mono>{short(link.peer)}</Mono>
              </div>
              <div style={meta}>
                {link.rooms === 0
                  ? 'Connected, proving itself'
                  : `Connected in ${link.rooms} other ${link.rooms === 1 ? 'space' : 'spaces'}`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Sync ──────────────────────────────────────────────────────────

function SyncFacts({ status }: { status: SpaceStatus }) {
  const facts: Array<[string, ReactNode, string?]> = [
    [
      'Fingerprint',
      <Mono key="f">{status.fingerprint.slice(0, 12)}</Mono>,
      'A summary of every record here. Two devices with the same fingerprint hold the same space.',
    ],
    ['Waiting to send', String(status.pending), 'Changes made here that no peer has taken yet'],
    [
      'Rejected',
      <span key="r" style={status.rejected > 0 ? { color: palette.accent.danger } : undefined}>
        {status.rejected}
      </span>,
      'Records peers sent that failed validation, and were not kept',
    ],
    [
      'Holds',
      status.holds === 'all'
        ? 'Everything'
        : status.holds.length === 1
          ? '1 collection'
          : `${status.holds.length} collections`,
      'What this device keeps a copy of',
    ],
  ];
  return (
    <Section title="Sync">
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
          margin: 0,
        }}
      >
        {facts.map(([label, value, why]) => (
          <div
            key={label}
            title={why}
            style={{
              padding: 12,
              borderRadius: palette.radius.md,
              border: `1px solid ${palette.surface.line}`,
            }}
          >
            <dt style={styles.factLabel}>{label}</dt>
            <dd style={{ ...styles.factValue, margin: '4px 0 0', fontSize: 15 }}>{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function HowItWorks() {
  return (
    <details style={{ ...styles.panel, marginTop: 0 }}>
      <summary style={{ ...styles.panelSummary, fontSize: 13 }}>How devices find each other</summary>
      <div style={{ ...styles.panelBody, fontSize: 13, lineHeight: 1.6 }}>
        <p>
          Every device holding this space opens a socket to the relays, and joins the space's room there. The
          relay tells the ones already in the room that a new one arrived, and they offer it a direct
          connection.
        </p>
        <p>
          Once connected, each side proves it belongs in the space before anything is shared, and the relay is
          no longer needed: devices already connected introduce the rest.
        </p>
        <p>
          If a relay drops — a laptop sleeps, Wi-Fi changes, the relay restarts — the socket comes back by
          itself, sooner when the network does. A connection that never opens is given up and offered again.
        </p>
      </div>
    </details>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <h2 style={{ ...styles.appTitle, fontSize: 20 }}>{title}</h2>
        {action}
      </div>
      {hint && <p style={{ fontSize: 13, color: palette.ink.muted, margin: 0, lineHeight: 1.6 }}>{hint}</p>}
      {children}
    </section>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: palette.mono, fontSize: 12 }}>{children}</span>;
}

/** The end of an identifier: enough to tell two apart */
const short = (did: string) => `…${did.slice(-8)}`;

// Each row draws the line under it, so the list draws no bottom edge of its own.
const list: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  border: `1px solid ${palette.surface.line}`,
  borderBottom: 'none',
  borderRadius: palette.radius.md,
  overflow: 'hidden',
};
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderBottom: `1px solid ${palette.surface.line}`,
};
const meta: CSSProperties = { fontSize: 12, color: palette.ink.muted, marginTop: 2 };
const empty: CSSProperties = { fontSize: 13, color: palette.ink.faint, margin: 0 };
