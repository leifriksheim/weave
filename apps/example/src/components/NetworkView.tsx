import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { checkRelays, MAX_RELAYS, roleHolds } from '@weaveprotocol/core';
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
import { styles, palette, variants } from '../styles';
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
      <Relays network={network} now={now} onRetry={() => node.network.reconnect()} />
      {access && (
        <SpaceRelays
          space={space}
          named={access.relays}
          manages={roleHolds(access.role, 'manage')}
          network={network}
          now={now}
        />
      )}
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

function Relays({ network, now, onRetry }: { network: MeshStatus; now: number; onRetry: () => void }) {
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
      <p style={{ ...meta, marginTop: 10 }}>
        {network.turn
          ? 'A relay offered TURN, so devices on strict networks can still connect through it.'
          : 'No TURN offered: two devices behind strict firewalls may not be able to connect.'}
      </p>
    </Section>
  );
}

// ─── Where the space meets ─────────────────────────────────────────

/**
 * The relays the space names for its members, which every member joins on
 * top of their app's own. Someone who manages the space can add and remove
 * them; everyone else sees where they meet.
 */
function SpaceRelays({
  space,
  named,
  manages,
  network,
  now,
}: {
  space: SpaceSummary;
  named: ReadonlyArray<string>;
  manages: boolean;
  network: MeshStatus;
  now: number;
}) {
  const node = useNode();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidate = relayUrl(draft);
  const problem = candidate ? checkRelays([...named, candidate]) : null;
  const full = named.length >= MAX_RELAYS;

  const save = async (relays: ReadonlyArray<string>) => {
    setBusy(true);
    setError(null);
    try {
      await node.spaces.setRelays(space.id, relays);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!candidate || problem) return;
    if (await save([...named, candidate])) setDraft('');
  };

  const remove = (url: string) => {
    if (
      !globalThis.confirm(
        `Stop meeting on ${relayName(url)}? Members still on only that relay lose touch until their apps pick up the change from someone else.`,
      )
    )
      return;
    void save(named.filter((u) => u !== url));
  };

  return (
    <Section
      title="Where this space meets"
      hint={`Every member joins the space on these relays as well as their own app's, so they find each other whichever relays their apps use. Naming more than one keeps the space reachable when one goes down. ${manages ? 'Only people who run the space can change them.' : 'Someone who runs the space can change them.'}`}
    >
      {named.length === 0 ? (
        <p style={empty}>This space names no relays yet, so members meet on their apps' own.</p>
      ) : (
        <ul style={list}>
          {named.map((url) => {
            const relay = network.relays.find((r) => r.url === url);
            return (
              <li key={url} style={{ ...row, alignItems: 'flex-start' }}>
                <span style={{ paddingTop: 6 }}>
                  <Dot color={relay ? RELAY_COLOR[relay.state] : palette.ink.faint} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: palette.ink.strong, overflowWrap: 'anywhere' }}>
                    <Mono>{url}</Mono>
                  </div>
                  <div style={meta}>
                    {relay ? relayLine(relay, now) : 'This device is not connected to it'}
                  </div>
                </div>
                {manages && (
                  <button
                    type="button"
                    onClick={() => remove(url)}
                    disabled={busy || named.length === 1}
                    title={named.length === 1 ? 'Add another relay before removing the last one' : undefined}
                    style={{ ...styles.smallButton, ...variants.danger }}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manages && (
        <form onSubmit={(event) => void add(event)} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="space-relay" style={visuallyHidden}>
            Relay address
          </label>
          <input
            id="space-relay"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="wss://relay.example.com"
            disabled={busy || full}
            autoComplete="off"
            spellCheck={false}
            style={{ ...styles.input, flex: '1 1 240px', minWidth: 0 }}
          />
          <button
            type="submit"
            disabled={busy || full || !candidate || problem !== null}
            style={styles.smallButton}
          >
            Add relay
          </button>
        </form>
      )}
      {manages && (full || problem || error) && (
        <p
          role="alert"
          style={{ ...meta, color: full && !error ? palette.ink.muted : palette.accent.danger }}
        >
          {error ?? problem ?? `A space names at most ${MAX_RELAYS} relays.`}
        </p>
      )}
    </Section>
  );
}

/** What someone typed as a relay, as a URL: "relay.example" means wss://relay.example */
function relayUrl(typed: string): string | null {
  const text = typed.trim().replace(/\/+$/, '');
  if (!text) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `wss://${text}`;
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
const visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};
