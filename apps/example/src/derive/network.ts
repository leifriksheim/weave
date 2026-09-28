/**
 * The network in words. A space's status and the node's relays, turned into
 * what a person needs to know: is this reaching my other devices, and if not,
 * whose fault is it — the relay, the network, or simply nobody else being here.
 */
import type { MeshStatus, RelayStatus, SpaceStatus } from '@weaveprotocol/core';

/** How a space is doing, from best to worst */
export type Health =
  /** Connected to someone */
  | 'syncing'
  /** Reachable, but nobody else is here right now */
  | 'alone'
  /** Coming up, or coming back */
  | 'connecting'
  /** Refused by the relay because this app's key is connected already: another tab or window */
  | 'elsewhere'
  /** No relay reachable and no peer: nothing leaves this device */
  | 'offline';

export function healthOf(status: SpaceStatus | undefined, network: MeshStatus): Health {
  if (!status || status.connection === 'offline') return 'offline';
  if (status.peers.length > 0) return 'syncing';
  if (network.relays.some((relay) => relay.state === 'open')) return 'alone';
  // The relay says this key is connected already: this app in another tab; the one that got there first wins.
  if (status.connection === 'refused') return 'elsewhere';
  if (status.connection === 'error') return 'offline';
  // Every relay waiting and none open: a retry is coming, but right now nothing gets through.
  if (network.relays.length > 0 && network.relays.every((relay) => relay.state === 'waiting'))
    return 'offline';
  return 'connecting';
}

/** Who a connected peer is, as far as its proof says */
export type PeerKind = 'mine' | 'person' | 'carrier' | 'server';

export function peerKind(peer: string, status: SpaceStatus, me: string): PeerKind {
  if (status.carriers.includes(peer)) return 'carrier';
  if (status.own.includes(peer) || status.accounts[peer] === me) return 'mine';
  return status.accounts[peer] ? 'person' : 'server';
}

/** "wss://relay.example" → "relay.example" */
export function relayName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

/** "12 s", "4 min", "2 h" — for how long, or how soon */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** One line on where a relay stands: "Connected for 4 min", "Trying again in 8 s" */
export function relayLine(relay: RelayStatus, now: number): string {
  switch (relay.state) {
    case 'open':
      return `Connected for ${duration(now - relay.since)}`;
    case 'connecting':
      return relay.failures > 0 ? `Trying again (attempt ${relay.failures + 1})` : 'Connecting…';
    case 'waiting': {
      const tries = relay.failures > 1 ? ` · ${relay.failures} failed tries` : '';
      const due = relay.retryAt ?? now;
      return due - now < 1000 ? `Trying again now${tries}` : `Trying again in ${duration(due - now)}${tries}`;
    }
    case 'stopped':
      return 'Not in use';
  }
}

/** The relay that will be tried soonest, when none is open */
export function nextRetry(network: MeshStatus): RelayStatus | null {
  if (network.relays.some((relay) => relay.state === 'open' || relay.state === 'connecting')) return null;
  const waiting = network.relays.filter((relay) => relay.retryAt !== null);
  return waiting.sort((a, b) => (a.retryAt ?? 0) - (b.retryAt ?? 0))[0] ?? null;
}
