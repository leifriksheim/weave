/**
 * @module session/stay-signed-in
 * Staying signed in on this device, so a refresh does not ask to unlock again.
 *
 * The seed is encrypted under a device key: a random key the browser keeps in
 * this site's storage and will use for this page but never hand out as bytes
 * (it is created non-extractable). The same thing a passkey shortcut does,
 * minus the fingerprint — which is exactly the convenience asked for, and
 * exactly the cost:
 *
 * - Someone who copies this site's stored data somewhere else gets ciphertext
 *   and no key to open it.
 * - Someone at this computer, in this browser profile, is signed in. So is any
 *   script running in this page. That is what "stay signed in" means anywhere.
 *
 * So it expires: after a chosen time without being used, the key is deleted
 * and the next visit asks to unlock. Signing out deletes it at once.
 *
 * Kept in this browser only, never in a pod — a pod is meant to be copied and
 * synced, and "this device may skip the password" must not travel with it.
 */
import { createDeviceKey, deleteDeviceKey, getDeviceKey } from '../identity/device-key.js';
import { unwrapSeedWithDeviceKey, wrapSeedWithDeviceKey, type DeviceWrap } from '../identity/account-vault.js';

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

/**
 * @param storage Where the setting and the wrapped seed are kept
 * @param rpId The site the device key belongs to
 * @param prefix Namespaces the keys, so two apps on one origin do not share a sign-in
 */
export function createStaySignedIn(storage: KeyValueStore | null, rpId: string, prefix = 'weave'): StaySignedInStore {
  const SETTING = `${prefix}.stay-signed-in`;
  const RECORD = `${prefix}.remembered-session`;

  const read = <T>(key: string): T | null => {
    try {
      const raw = storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown): void => {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: it will ask again next time, which is safe */
    }
  };

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
      write(RECORD, { accountId, place, wrap, expiresAt: Date.now() + DURATION[chosen] } satisfies Remembered);
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
