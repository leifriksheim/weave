/**
 * @module session/credentials
 * Getting a password manager to actually keep something.
 *
 * Managers decide whether to offer saving by guessing, from the shape of a
 * form and from a navigation that usually follows submitting one. A page that
 * submits nothing and never navigates — which is every sign-in form here —
 * often gets no prompt at all, and a field hidden with `display: none` is
 * generally not counted as a username, so hiding one makes the guess worse
 * rather than better.
 *
 * So the forms stay honest — a real username field, visible or at least laid
 * out — and this asks outright as well, where the browser supports being asked.
 */

/** The Credential Management API, which only Chromium browsers implement. */
interface PasswordCredentialConstructor {
  new (data: { id: string; password: string; name?: string }): Credential;
}

function isPasswordCredentialConstructor(value: unknown): value is PasswordCredentialConstructor {
  return typeof value === 'function';
}

/**
 * Offers a credential to the browser's password manager.
 *
 * Best effort by design: Firefox and Safari have no such API, and a manager may
 * decline. The password works either way — this only decides whether the user
 * has to copy it somewhere themselves.
 *
 * @param id What to file it under, which is what the user will see in the vault
 * @param password The secret
 * @param name A longer label, where the manager shows one
 * @returns Whether the browser was asked at all
 */
export async function offerToSave(id: string, password: string, name?: string): Promise<boolean> {
  const Ctor: unknown = Reflect.get(globalThis, 'PasswordCredential');
  if (!isPasswordCredentialConstructor(Ctor)) return false;

  try {
    await globalThis.navigator.credentials.store(new Ctor({ id, password, ...(name ? { name } : {}) }));
    return true;
  } catch {
    // Declined, or blocked by policy. Not worth surfacing.
    return false;
  }
}

/**
 * What a password manager should file the account's password under.
 *
 * The account's own name, so the vault entry says which account it opens —
 * useful the moment there is more than one.
 */
export function accountCredentialName(name: string): string {
  return name;
}

/**
 * What a password manager filed a device password under, before an account
 * had one password rather than one per device. Kept different from what the
 * recovery code was filed under, so a manager would not fill one for the other.
 *
 * @deprecated New passwords are filed under {@link accountCredentialName}.
 */
export function deviceCredentialName(name: string): string {
  return `${name} (this device)`;
}

/**
 * The recovery code as a file to keep.
 *
 * Plain text, so it opens anywhere and prints as it is. It names the account
 * and its DID, so a drawer with two of these says which is which.
 *
 * @param account The code, and the account it opens
 * @returns A file name and its contents
 */
export function recoveryKit({ code, name, did }: { code: string; name: string; did: string }): {
  filename: string;
  text: string;
} {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'account';
  const text = [
    'Weave recovery code',
    '',
    `Account:       ${name}`,
    ...(did ? [`Account ID:    ${did}`] : []),
    `Recovery code: ${code}`,
    '',
    'This code is your Weave account. It restores the account on any device or',
    'Weave home, even one that has never seen it. Nobody can reissue it, and',
    'anyone who has it can open your account.',
    '',
    'Keep it somewhere safe: a secure note in your password manager, or printed',
    'and put away. Not as a saved login, where a new password could replace it.',
    '',
    `Made ${new Date().toISOString().slice(0, 10)}.`,
    '',
  ].join('\n');
  return { filename: `weave-recovery-${slug}.txt`, text };
}
