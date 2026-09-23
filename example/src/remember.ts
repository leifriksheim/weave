/**
 * Staying signed in on this device, so a refresh does not ask to unlock again.
 *
 * The account key is encrypted under a device key: a random key the browser
 * keeps in this site's storage and will use for this page but never hand out
 * as bytes (it is created non-extractable). The same thing a passkey shortcut
 * does, minus the fingerprint — which is exactly the convenience asked for, and
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
import { createDeviceKey, deleteDeviceKey, getDeviceKey, unwrapSeedWithDeviceKey, wrapSeedWithDeviceKey, type DeviceWrap } from 'weave-protocol';

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

const SETTING = 'weave.stay-signed-in';
const RECORD = 'weave.remembered-session';

interface Remembered {
  readonly accountId: string;
  /** Which kind of home the account was opened from — a pod account resumes only when the pod is open again */
  readonly home: 'browser' | 'folder';
  readonly wrap: DeviceWrap;
  /** Unix ms; pushed forward each time it is used */
  readonly expiresAt: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: it will ask again next time, which is safe */
  }
}

export function staySignedIn(): StaySignedIn {
  const chosen = read<StaySignedIn>(SETTING);
  return chosen && chosen in DURATION ? chosen : DEFAULT_STAY_SIGNED_IN;
}

/**
 * Changes how long this device stays signed in. "Ask every time" forgets the
 * current one straight away; a new length applies from now.
 */
export async function setStaySignedIn(choice: StaySignedIn): Promise<void> {
  write(SETTING, choice);
  const current = read<Remembered>(RECORD);
  if (!current) return;
  if (choice === 'never') await forgetRemembered();
  else write(RECORD, { ...current, expiresAt: Date.now() + DURATION[choice] });
}

/** Keeps the account key on this device after an unlock, when the setting allows it. */
export async function rememberSeed(accountId: string, home: 'browser' | 'folder', seed: Uint8Array): Promise<void> {
  await forgetRemembered();
  const choice = staySignedIn();
  if (choice === 'never') return;
  const deviceKey = await createDeviceKey();
  const wrap = await wrapSeedWithDeviceKey(seed, deviceKey, { rpId: globalThis.location.hostname, label: 'stay signed in' });
  write(RECORD, { accountId, home, wrap, expiresAt: Date.now() + DURATION[choice] } satisfies Remembered);
}

/**
 * The account key this device kept, if it is still in date and for an account
 * in the home that is open. Using it pushes the expiry forward.
 */
export async function recallSeed(home: 'browser' | 'folder'): Promise<{ accountId: string; seed: Uint8Array } | null> {
  const current = read<Remembered>(RECORD);
  if (!current) return null;
  if (current.expiresAt < Date.now()) {
    await forgetRemembered();
    return null;
  }
  if (current.home !== home) return null;
  const key = await getDeviceKey(current.wrap.deviceKeyId);
  if (!key) {
    write(RECORD, null);
    return null;
  }
  try {
    const seed = await unwrapSeedWithDeviceKey(current.wrap, key);
    write(RECORD, { ...current, expiresAt: Date.now() + DURATION[staySignedIn()] });
    return { accountId: current.accountId, seed };
  } catch {
    await forgetRemembered();
    return null;
  }
}

/** When the remembered sign-in runs out, or null when there is none */
export function rememberedUntil(): Date | null {
  const current = read<Remembered>(RECORD);
  return current && current.expiresAt > Date.now() ? new Date(current.expiresAt) : null;
}

/** Deletes the kept key: the next visit asks to unlock. */
export async function forgetRemembered(): Promise<void> {
  const current = read<Remembered>(RECORD);
  write(RECORD, null);
  if (current) await deleteDeviceKey(current.wrap.deviceKeyId).catch(() => {});
}
