/** What this app's notifications matched lately, for the bell and the dot on the tab's icon; kept in this browser only. */
import { useEffect, useSyncExternalStore } from 'react';

export interface Alert {
  /** The record it is about */
  readonly record: string;
  readonly space: string;
  /** What the notification says */
  readonly label: string;
  readonly at: string;
}

interface Kept {
  readonly items: ReadonlyArray<Alert>;
  /** Everything up to this was looked at */
  readonly readAt: string;
}

/** How many are kept, newest first */
const KEEP = 50;
const EMPTY: Kept = { items: [], readAt: '' };

const keyOf = (did: string) => `weave.alerts:${did}`;
const cache = new Map<string, Kept>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

function isAlert(value: unknown): value is Alert {
  return (
    typeof value === 'object' &&
    value !== null &&
    'record' in value &&
    typeof value.record === 'string' &&
    'space' in value &&
    typeof value.space === 'string' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'at' in value &&
    typeof value.at === 'string'
  );
}

function read(did: string): Kept {
  const held = cache.get(did);
  if (held) return held;
  let kept = EMPTY;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage.getItem(keyOf(did)) ?? 'null');
    if (typeof parsed === 'object' && parsed !== null && 'items' in parsed && Array.isArray(parsed.items))
      kept = {
        items: parsed.items.filter(isAlert),
        readAt: 'readAt' in parsed && typeof parsed.readAt === 'string' ? parsed.readAt : '',
      };
  } catch {
    // Storage blocked or spoiled: start empty.
  }
  cache.set(did, kept);
  return kept;
}

function write(did: string, kept: Kept) {
  cache.set(did, kept);
  try {
    globalThis.localStorage.setItem(keyOf(did), JSON.stringify(kept));
  } catch {
    // Kept for this page only.
  }
  changed();
}

/** Something a notification matched; one record is one alert */
export function addAlert(did: string, alert: Alert) {
  const kept = read(did);
  if (kept.items.some((item) => item.record === alert.record)) return;
  write(did, { ...kept, items: [alert, ...kept.items].slice(0, KEEP) });
}

/** Everything so far was looked at */
export function markRead(did: string) {
  const kept = read(did);
  const newest = kept.items[0]?.at ?? '';
  if (newest && newest > kept.readAt) write(did, { ...kept, readAt: newest });
}

// Another tab of this app adds or reads them too.
globalThis.addEventListener?.('storage', (event) => {
  if (!event.key?.startsWith('weave.alerts:')) return;
  cache.delete(event.key.slice('weave.alerts:'.length));
  changed();
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The latest alerts, and how many came since they were last looked at */
export function useAlerts(did: string): { items: ReadonlyArray<Alert>; unread: number } {
  const kept = useSyncExternalStore(subscribe, () => read(did));
  return { items: kept.items, unread: kept.items.filter((item) => item.at > kept.readAt).length };
}

/** The Weave mark, as the tab's icon */
const MARK =
  '<rect width="32" height="32" rx="8" fill="#000"/><path d="M5 10 L12 23 L16 14 L20 23 L27 10" fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>';
const DOT = '<circle cx="26" cy="6" r="6" fill="#e5484d" stroke="#fff" stroke-width="2"/>';
const icon = (dot: boolean) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${MARK}${dot ? DOT : ''}</svg>`)}`;

/** The tab's icon, with a red dot while something matched hasn't been looked at */
export function useTabDot(dot: boolean) {
  useEffect(() => {
    let link = globalThis.document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = globalThis.document.createElement('link');
      link.rel = 'icon';
      globalThis.document.head.append(link);
    }
    link.type = 'image/svg+xml';
    link.href = icon(dot);
  }, [dot]);
}
