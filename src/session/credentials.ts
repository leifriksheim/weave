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
  const Ctor = (globalThis as { PasswordCredential?: PasswordCredentialConstructor }).PasswordCredential;
  if (!Ctor) return false;

  try {
    await globalThis.navigator.credentials.store(new Ctor({ id, password, ...(name ? { name } : {}) }));
    return true;
  } catch {
    // Declined, or blocked by policy. Not worth surfacing.
    return false;
  }
}

/**
 * What a password manager should file the account password under.
 *
 * The account's own name, so the vault entry says which account it opens —
 * useful the moment there is more than one.
 */
export function accountCredentialName(name: string): string {
  return name;
}

/**
 * What a password manager should file a device password under.
 *
 * Deliberately different from {@link accountCredentialName}. They are two
 * different secrets on the same origin: one opens the account anywhere, the
 * other only here. Filed under the same name, a manager would offer whichever
 * it saw last and quietly fill the wrong one.
 */
export function deviceCredentialName(name: string): string {
  return `${name} (this device)`;
}
