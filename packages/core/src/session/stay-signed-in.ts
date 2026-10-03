/**
 * @module session/stay-signed-in
 * Staying signed in on this device: the seed wrapped under a non-extractable
 * device key in this site's storage, so a copy of the stored data opens
 * nothing elsewhere, while anyone at this browser profile is signed in. It
 * expires after a chosen time unused, and never travels in a pod.
 */
import { createDeviceKey, deleteDeviceKey, getDeviceKey } from '../identity/device-key.js';
import {
  unwrapSeedWithDeviceKey,
  wrapSeedWithDeviceKey,
  type DeviceWrap,
} from '../identity/account-vault.js';

/** How long an unused device stays signed in */
export type StaySignedIn = 'never' | '1d' | '7d' | '30d';

export const STAY_SIGNED_IN_CHOICES: ReadonlyArray<{ value: StaySignedIn; label: string }> = [
  { value: 'never', label: 'Ask every time' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export const DEFAULT_STAY_SIGNED_IN: StaySignedIn = '7d';

const DAY = 24 * 60 * 60 * 1000;
const DURATION: Record<StaySignedIn, number> = { never: 0, '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

/** The little of `localStorage` this needs — swappable, for tests and for other hosts */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The given store, or this page's `localStorage` when none was given; null remembers nothing */
export function defaultStorage(storage?: KeyValueStore | null): KeyValueStore | null {
  return storage !== undefined ? storage : (globalThis.localStorage ?? null);
}

/**
 * A key-value store that never throws: one that refuses (private mode, a full
 * quota) only means forgetting, and remembering is never a requirement.
 */
export function guardedStorage(storage: KeyValueStore | null) {
  const get = (key: string): string | null => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const set = (key: string, value: string | null): void => {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch {
      // Forgotten instead.
    }
  };
  return {
    get,
    set,
    /** Parsed JSON, or null when missing or unreadable; the caller owns the key, and so its shape */
    read: <T>(key: string): T | null => {
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only the caller's own writes use its keys
        return JSON.parse(get(key) ?? 'null') as T | null;
      } catch {
        return null;
      }
    },
    /** Writes JSON; null removes the key */
    write: (key: string, value: unknown): void => set(key, value === null ? null : JSON.stringify(value)),
  };
}

interface Remembered {
  readonly accountId: string;
  /** Which kind of place the account was opened from — a pod account resumes only when the pod is open again */
  readonly place: 'browser' | 'folder';
  readonly wrap: DeviceWrap;
  /** Unix ms; pushed forward each time it is used */
  readonly expiresAt: number;
}

export interface StaySignedInStore {
  /** The chosen length */
  choice(): StaySignedIn;
  /** Changes it. "Ask every time" forgets the current one straight away; a new length applies from now. */
  setChoice(choice: StaySignedIn): Promise<void>;
  /** Keeps the seed on this device after an unlock, when the choice allows it */
  remember(accountId: string, place: 'browser' | 'folder', seed: Uint8Array): Promise<void>;
  /** The seed this device kept, if still in date and for the kind of place that is open. Using it pushes the expiry forward. */
  recall(place: 'browser' | 'folder'): Promise<{ accountId: string; seed: Uint8Array } | null>;
  /** When the kept sign-in runs out, or null when there is none */
  until(): Date | null;
  /** Deletes the kept key: the next visit asks to unlock */
  forget(): Promise<void>;
}

/** `prefix` namespaces the keys, so two apps on one origin do not share a sign-in */
export function createStaySignedIn(
  storage: KeyValueStore | null,
  rpId: string,
  prefix = 'weave',
): StaySignedInStore {
  const SETTING = `${prefix}.stay-signed-in`;
  const RECORD = `${prefix}.remembered-session`;

  const { read, write } = guardedStorage(storage);

  const choice = (): StaySignedIn => {
    const chosen = read<StaySignedIn>(SETTING);
    return chosen && chosen in DURATION ? chosen : DEFAULT_STAY_SIGNED_IN;
  };

  const forget = async (): Promise<void> => {
    const current = read<Remembered>(RECORD);
    write(RECORD, null);
    if (current) await deleteDeviceKey(current.wrap.deviceKeyId).catch(() => {});
  };

  return {
    choice,
    forget,

    async setChoice(next) {
      write(SETTING, next);
      const current = read<Remembered>(RECORD);
      if (!current) return;
      if (next === 'never') await forget();
      else write(RECORD, { ...current, expiresAt: Date.now() + DURATION[next] });
    },

    async remember(accountId, place, seed) {
      await forget();
      const chosen = choice();
      if (chosen === 'never') return;
      const deviceKey = await createDeviceKey();
      const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, { rpId, label: 'stay signed in' });
      write(RECORD, {
        accountId,
        place,
        wrap,
        expiresAt: Date.now() + DURATION[chosen],
      } satisfies Remembered);
    },

    async recall(place) {
      const current = read<Remembered>(RECORD);
      if (!current) return null;
      if (current.expiresAt < Date.now()) {
        await forget();
        return null;
      }
      if (current.place !== place) return null;
      const key = await getDeviceKey(current.wrap.deviceKeyId);
      if (!key) {
        write(RECORD, null);
        return null;
      }
      try {
        const seed = await unwrapSeedWithDeviceKey(current.wrap, key);
        write(RECORD, { ...current, expiresAt: Date.now() + DURATION[choice()] });
        return { accountId: current.accountId, seed };
      } catch {
        await forget();
        return null;
      }
    },

    until() {
      const current = read<Remembered>(RECORD);
      return current && current.expiresAt > Date.now() ? new Date(current.expiresAt) : null;
    },
  };
}
