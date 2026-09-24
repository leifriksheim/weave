/**
 * @module elements/weave-auth
 * `<weave-auth>`: the whole sign-in flow as one element.
 *
 * ```html
 * <weave-auth app-name="Todo" relays="wss://relay.example"></weave-auth>
 * <script type="module">
 *   import 'weave-protocol/elements';
 *   document.querySelector('weave-auth').addEventListener('weave-session', (event) => {
 *     const session = event.detail.session;   // null when signed out
 *     if (session) start(session.node);
 *   });
 * </script>
 * ```
 *
 * Or hand it a flow you made yourself, to share it with the rest of the page:
 * `element.auth = createWeaveAuth({ … })`.
 *
 * It draws into its own light DOM, not a shadow root, on purpose: password
 * managers find and fill forms in the page far more reliably than forms inside
 * a shadow root, and the account password living in a password manager is the
 * point of the whole design. Its styles are scoped to the element instead.
 *
 * It fills whatever box it is put in — a page, a modal, a panel — and draws
 * nothing once signed in; the host decides what happens then.
 */
import { createWeaveAuth, type AuthError, type AuthState, type WeaveAuth, type WeaveSession } from '../session/auth.js';
import { accountCredentialName, deviceCredentialName, offerToSave } from '../session/credentials.js';
import type { PairingStage } from '../session/pairing.js';
import type { AccountSummary } from '../identity/account-store.js';
import { adoptStyles, h, svg, type Child } from './dom.js';
import { AUTH_CSS } from './auth-styles.js';

/** What `weave-session` carries */
export interface WeaveSessionEventDetail {
  readonly session: WeaveSession | null;
}

const Base = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/** The mark and the name, above every step */
function wordmark(): HTMLElement {
  return h(
    'div',
    { class: 'wa-wordmark' },
    svg(
      '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    ),
    'Weave',
  );
}

/** A small deterministic hash, enough to seed a 5×5 pattern and a hue. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/**
 * A visual fingerprint for an account, derived from its DID — the same
 * everywhere it appears, so a wrong account is obvious before its name is read.
 */
function avatar(did: string, size = 32): Element {
  const seed = hash(did);
  const hue = seed % 360;
  const cells: string[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (((seed >> (x * 5 + y)) & 1) === 0) continue;
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      if (x < 2) cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1"/>`);
    }
  }
  return svg(
    `<svg class="wa-avatar" width="${size}" height="${size}" viewBox="0 0 5 5" role="img" aria-label="Account avatar" style="background:hsl(${hue} 46% 92%)"><g fill="hsl(${hue} 62% 48%)">${cells.join('')}</g></svg>`,
  );
}

/** An explanation, folded away until asked for. */
function info(label: string, ...text: Child[]): HTMLElement {
  const popover = h('span', { class: 'wa-popover', role: 'note', hidden: true }, ...text);
  const button = h(
    'button',
    {
      type: 'button',
      class: 'wa-info-button',
      'aria-label': label,
      'aria-expanded': 'false',
      onclick: () => {
        popover.hidden = !popover.hidden;
        button.setAttribute('aria-expanded', String(!popover.hidden));
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Escape') popover.hidden = true;
      },
    },
    'i',
  );
  return h('span', { class: 'wa-info' }, button, popover);
}

function errorBox(error: AuthError | null): HTMLElement | null {
  if (!error) return null;
  return h(
    'div',
    { class: 'wa-error-box', role: 'alert' },
    h('p', { class: 'wa-error' }, error.message),
    error.hint ? h('p', { class: 'wa-small' }, error.hint) : null,
  );
}

function option(title: string, text: string, onclick: () => void, disabled: boolean, recommended = false): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'wa-option', onclick, disabled },
    h('span', { class: 'wa-option-title' }, title, recommended ? h('span', { class: 'wa-badge' }, 'Recommended') : null),
    h('span', { class: 'wa-option-text' }, text),
  );
}

function link(text: string, onclick: () => void, disabled = false): HTMLElement {
  return h('button', { type: 'button', class: 'wa-link', onclick, disabled }, text);
}

function describePairing(stage: PairingStage): string {
  switch (stage.kind) {
    case 'waiting':
      return 'Looking for your computer…';
    case 'connected':
      return 'Found it. Collecting your spaces…';
    case 'received':
      return stage.spaces === 1 ? 'Got 1 space.' : `Got ${stage.spaces} spaces.`;
    case 'sent':
      return 'Done.';
    case 'failed':
      return stage.reason;
  }
}

export class WeaveAuthElement extends Base {
  #auth: WeaveAuth | null = null;
  #unsubscribe: (() => void) | null = null;
  #announced: WeaveSession | null | undefined = undefined;

  // What only this element cares about: which fold is open, what is typed.
  #drafts = new Map<string, string>();
  #showCode = false;
  #filledAs = '';
  #copied = false;
  #lastSelected: string | null = null;

  /** The flow this element draws. Set it to share one with the rest of the page; otherwise one is made from the attributes. */
  get auth(): WeaveAuth {
    this.#auth ??= createWeaveAuth({
      ...(this.getAttribute('app-name') ? { appName: this.getAttribute('app-name')! } : {}),
      network: {
        relays: (this.getAttribute('relays') ?? '').split(',').map((url) => url.trim()).filter(Boolean),
        nodes: (this.getAttribute('nodes') ?? '').split(',').map((url) => url.trim()).filter(Boolean),
      },
    });
    return this.#auth;
  }

  set auth(auth: WeaveAuth) {
    if (auth === this.#auth) return;
    this.#auth = auth;
    if (this.isConnected) this.#follow();
  }

  connectedCallback(): void {
    adoptStyles('weave-auth', AUTH_CSS);
    if (this.#auth) {
      this.#follow();
      return;
    }
    // A framework may set `auth` just after inserting the element; wait a
    // moment before making one from the attributes instead.
    queueMicrotask(() => {
      if (this.isConnected && !this.#unsubscribe) this.#follow();
    });
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #follow(): void {
    this.#unsubscribe?.();
    const auth = this.auth;
    this.#unsubscribe = auth.subscribe((state) => this.#changed(state));
    this.#changed(auth.getState());
    void auth.start();
  }

  #changed(state: AuthState): void {
    // A new account row, or a new screen, starts with empty fields.
    if (state.selectedId !== this.#lastSelected) {
      this.#lastSelected = state.selectedId;
      this.#reset();
    }
    this.#render(state);

    const session = state.stage === 'ready' ? state.session : null;
    if (session !== this.#announced) {
      this.#announced = session;
      this.dispatchEvent(
        new CustomEvent<WeaveSessionEventDetail>('weave-session', { detail: { session }, bubbles: true, composed: true }),
      );
    }
  }

  #reset(): void {
    this.#drafts.clear();
    this.#showCode = false;
    this.#filledAs = '';
  }

  /** Redraws, keeping focus and what was typed. */
  #render(state: AuthState): void {
    const focused = this.contains(globalThis.document.activeElement)
      ? (globalThis.document.activeElement as HTMLElement).dataset.key
      : undefined;

    this.replaceChildren(...this.#screen(state));

    const again = focused
      ? this.querySelector<HTMLInputElement>(`[data-key="${focused}"]`)
      : this.querySelector<HTMLInputElement>('[autofocus]');
    again?.focus();
  }

  /** An input that survives a redraw */
  #input(key: string, props: Record<string, unknown>): HTMLInputElement {
    return h('input', {
      ...props,
      'data-key': key,
      value: this.#drafts.get(key) ?? props.value ?? '',
      oninput: (event: Event) => this.#drafts.set(key, (event.target as HTMLInputElement).value),
    }) as HTMLInputElement;
  }

  #screen(state: AuthState): HTMLElement[] {
    if (state.stage === 'ready') return [];
    if (state.stage === 'starting') return [h('div', { class: 'wa-card' }, h('p', { class: 'wa-hint' }, 'Looking for your accounts…'))];
    if (state.stage === 'pair') return [this.#pair(state)];
    if (state.stage === 'create') return [state.freshCode ? this.#saveCode(state, state.freshCode) : this.#create(state)];
    if (state.stage === 'where') return [this.#where(state)];
    if (state.stage === 'welcome') return [this.#welcome(state)];
    return [this.#signIn(state)];
  }

  // ─── Where should your data live ───────────────────────────────────

  #where(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Where should your data live?'),
      h('p', { class: 'wa-subtitle' }, 'You can change this later.'),
      h(
        'div',
        { class: 'wa-options' },
        option(
          'Choose a pod',
          'A folder on your computer that holds your Weave data. Every app you open it in sees the same account and the same spaces.',
          () => void auth.choosePod(),
          state.busy,
          true,
        ),
        option(
          'Continue in this browser',
          "Nothing to set up. Your data syncs with your other devices, but other apps on other addresses can't open it.",
          () => void auth.useBrowser(),
          state.busy,
        ),
      ),
      h(
        'p',
        { class: 'wa-small', style: 'margin-top:16px' },
        'Your browser will ask to see the folder, then to save into it.',
        info(
          'Why a pod',
          'Your data becomes yours the way any other file is: copy it, back it up, or put the folder in iCloud or Dropbox and your devices stay in step with no server involved. It is also the only storage a second app on a different address can read.',
        ),
      ),
      errorBox(state.error),
    );
  }

  #placeLine(state: AuthState): HTMLElement | null {
    const place = state.place;
    if (!place) return null;
    return h(
      'p',
      { class: 'wa-small', style: 'margin-top:24px' },
      place.kind === 'folder' ? `Pod: ${place.directory?.name ?? 'your folder'}` : 'Stored in this browser',
      state.folderAvailable ? [' · ', link('Change', () => this.auth.changeStorage(), state.busy)] : null,
    );
  }

  // ─── New here, or not ──────────────────────────────────────────────

  #welcome(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Do you have a Weave account?'),
      h('p', { class: 'wa-subtitle' }, 'One account works in every Weave app.'),
      h(
        'div',
        { class: 'wa-options' },
        option('Create a new account', "We'll make you a strong password to save in your password manager.", () => auth.startCreating(), state.busy),
        option('I already have one', 'Sign in with the account password you saved when you made it.', () => auth.showSignIn(), state.busy),
      ),
      errorBox(state.error),
      this.#placeLine(state),
    );
  }

  // ─── Choosing an account, and getting in ───────────────────────────

  /**
   * The account-password form.
   *
   * The username field is off-screen, but deliberately not `display: none` —
   * a field taken out of the layout is not counted as a username, while one
   * merely moved out of view is filled normally. And writable: a manager fills
   * the whole credential at once, so a read-only username keeps showing the
   * account that was clicked while the password quietly belongs to another.
   * Letting it be overwritten is what makes the mismatch detectable.
   */
  #codeForm(state: AuthState, selected: AccountSummary | null): HTMLElement {
    const username = h('input', {
      type: 'text',
      name: 'username',
      autocomplete: 'username',
      value: accountCredentialName(selected?.name ?? 'My account'),
      class: 'wa-offscreen',
      tabindex: '-1',
      'aria-hidden': 'true',
    }) as HTMLInputElement;

    const password = this.#input('code', {
      type: 'password',
      name: 'password',
      placeholder: 'Your account password',
      autocomplete: 'current-password',
      spellcheck: 'false',
      'aria-label': 'Account password',
      disabled: state.busy,
    });
    // Autofill sets the DOM value directly; read what it filled as well.
    password.addEventListener('input', () => {
      const filled = username.value.trim();
      if (filled !== this.#filledAs) {
        this.#filledAs = filled;
        this.#render(this.auth.getState());
      }
    });

    return h(
      'form',
      {
        class: 'wa-form',
        onsubmit: (event: Event) => {
          event.preventDefault();
          const code = password.value.trim();
          if (code) void this.auth.signInWithCode(code);
        },
      },
      username,
      password,
      h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, state.busy ? 'Signing in…' : 'Sign in'),
    );
  }

  #signIn(state: AuthState): HTMLElement {
    const auth = this.auth;
    const { accounts, entry, place } = state;
    const selected = accounts.find((account) => account.id === state.selectedId) ?? null;

    const rows = accounts.map((account) => {
      const isSelected = account.id === state.selectedId;
      const body: Child[] = [];

      if (isSelected && entry) {
        const hasShortcut = entry.shortcuts.length > 0;
        const needsCode = this.#showCode || (!hasShortcut && !entry.hasPassword);
        // An account with wraps, none of them usable here, has been used on
        // another site — a passkey works on one web address only.
        const seenElsewhere = entry.vault.wraps.length > 0;

        if (hasShortcut && !this.#showCode) {
          body.push(
            h(
              'button',
              { type: 'button', class: 'wa-button', 'data-key': 'passkey', disabled: state.busy, onclick: () => void auth.signInWithPasskey() },
              state.busy ? 'Waiting…' : 'Unlock with passkey',
            ),
          );
        }

        if (entry.hasPassword && !this.#showCode) {
          const devicePassword = this.#input('device-password', {
            type: 'password',
            name: 'password',
            placeholder: 'Password on this device',
            autocomplete: 'current-password',
            'aria-label': 'Device password',
            disabled: state.busy,
          });
          body.push(
            h(
              'form',
              {
                class: 'wa-form',
                style: hasShortcut ? 'margin-top:10px' : '',
                onsubmit: (event: Event) => {
                  event.preventDefault();
                  if (devicePassword.value) void auth.signInWithPassword(devicePassword.value);
                },
              },
              h('input', {
                type: 'text',
                name: 'username',
                autocomplete: 'username',
                value: deviceCredentialName(account.name),
                readonly: true,
                class: 'wa-offscreen',
                tabindex: '-1',
                'aria-hidden': 'true',
              }),
              devicePassword,
              h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, 'Unlock'),
            ),
          );
        }

        if (needsCode) {
          if (!hasShortcut && !entry.hasPassword) {
            body.push(
              h(
                'p',
                { class: 'wa-small', style: 'margin:0 0 10px' },
                seenElsewhere ? 'New to this app.' : 'No passkey set up here yet.',
                info(
                  'Why it is asking for the password',
                  seenElsewhere
                    ? 'This account’s passkeys belong to the apps that made them — a passkey works on one web address only. Sign in once with your account password and this app can add its own.'
                    : 'Once you are in, you can add a passkey so this app stops asking.',
                ),
              ),
            );
          }
          body.push(this.#codeForm(state, selected));
        } else {
          body.push(
            h(
              'div',
              { class: 'wa-links' },
              link(
                'Use my account password instead',
                () => {
                  this.#showCode = true;
                  this.#filledAs = '';
                  this.#render(auth.getState());
                },
                state.busy,
              ),
            ),
          );
        }

        if (this.#showCode && this.#filledAs !== '' && this.#filledAs !== accountCredentialName(account.name)) {
          body.push(
            h(
              'p',
              { class: 'wa-error', style: 'margin-top:10px' },
              'Your password manager filled ',
              h('strong', null, this.#filledAs),
              ', not ',
              h('strong', null, account.name),
              '. Pick the entry named ',
              h('strong', null, account.name),
              ', or open that account instead.',
            ),
          );
        }
      }

      return h(
        'div',
        { class: 'wa-account' },
        h(
          'button',
          {
            type: 'button',
            class: 'wa-account-row',
            'aria-expanded': String(isSelected),
            disabled: state.busy,
            // Clicking the open row must not wipe what a manager just filled.
            onclick: () => (isSelected ? undefined : void auth.select(account.id)),
          },
          avatar(account.did),
          h(
            'span',
            { style: 'flex:1;min-width:0' },
            h('span', { class: 'wa-account-name' }, account.name),
            h('span', { class: 'wa-account-did' }, `${account.did.slice(0, 18)}…${account.did.slice(-4)}`),
          ),
        ),
        body.length > 0 ? h('div', { class: 'wa-account-body' }, ...body) : null,
      );
    });

    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, accounts.length > 0 ? 'Welcome back' : 'Sign in'),
      h(
        'p',
        { class: 'wa-subtitle' },
        accounts.length > 0 ? 'Choose your account.' : 'Paste the account password you saved when you made it.',
      ),
      ...rows,
      accounts.length === 0
        ? [
            h(
              'p',
              { class: 'wa-hint' },
              place?.kind === 'folder' ? 'This pod has no accounts yet.' : 'No accounts in this browser yet.',
              info(
                'Why this works with nothing stored',
                'The password is your key written out, not a hint to look something up with — so it opens the account in an app that has never seen you. If your account is in a pod, opening the pod below brings it back without the password.',
              ),
            ),
            this.#codeForm(state, null),
          ]
        : null,
      errorBox(state.error),
      h('div', { class: 'wa-links' }, link('Create a new account', () => auth.startCreating(), state.busy)),
      place
        ? h('p', { class: 'wa-small', style: 'margin-top:16px' }, place.kind === 'folder' ? `Pod: ${place.directory?.name ?? 'your folder'}` : 'Accounts kept in this browser')
        : null,
      state.folderAvailable
        ? h(
            'div',
            { class: 'wa-links' },
            link(place?.kind === 'folder' ? 'Open a different pod' : 'Open a pod', () => void auth.choosePod(), state.busy),
            place?.kind === 'folder' ? link('Use this browser instead', () => void auth.useBrowser(), state.busy) : null,
          )
        : null,
    );
  }

  // ─── Making an account ─────────────────────────────────────────────

  #create(state: AuthState): HTMLElement {
    const auth = this.auth;
    const name = this.#input('name', {
      type: 'text',
      placeholder: 'Your name',
      autocomplete: 'off',
      autofocus: true,
      disabled: state.busy,
    });
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Create your account'),
      h('p', { class: 'wa-subtitle' }, 'Your data stays with you, not on a server.'),
      h(
        'form',
        {
          class: 'wa-form',
          onsubmit: (event: Event) => {
            event.preventDefault();
            if (name.value.trim()) void auth.createAccount(name.value.trim());
          },
        },
        name,
        h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, state.busy ? 'Creating…' : 'Create account'),
      ),
      h('div', { class: 'wa-links' }, link('I already have an account', () => auth.showSignIn(), state.busy)),
      h(
        'p',
        { class: 'wa-small' },
        "We'll generate a strong password and show it once.",
        info(
          'What happens next',
          'Save it in your password manager. It opens your account in any Weave app, even one that has never seen you — and nobody can reissue it.',
        ),
      ),
      errorBox(state.error),
    );
  }

  /**
   * The new account's password, shown once.
   *
   * Framed as a password because that is what it is for: your password
   * manager saves it here and fills it in on the next app. A real form with
   * both fields is what makes a manager offer to save.
   */
  #saveCode(state: AuthState, code: string): HTMLElement {
    const auth = this.auth;
    const filedAs = accountCredentialName(state.session?.account.name ?? 'My account');
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Save your password'),
      h(
        'p',
        { class: 'wa-hint' },
        'Save this to your password manager now — it will fill itself in from then on.',
        info(
          'About this password',
          'It is generated rather than chosen, and it ',
          h('em', null, 'is'),
          ' your key rather than a backup of it. That is what lets it work on an app that has never seen you, with nothing stored anywhere. It is shown once and nobody can reissue it.',
        ),
      ),
      h(
        'form',
        {
          class: 'wa-form',
          onsubmit: (event: Event) => {
            event.preventDefault();
            void offerToSave(filedAs, code, filedAs).then(() => auth.codeSaved());
          },
        },
        h('input', { type: 'text', name: 'username', autocomplete: 'username', value: filedAs, readonly: true, 'aria-label': 'Account name' }),
        h('input', { type: 'password', name: 'password', autocomplete: 'new-password', value: code, readonly: true, 'aria-label': 'Account password' }),
        h('button', { type: 'submit', class: 'wa-button' }, "I've saved it — continue"),
      ),
      h('code', { class: 'wa-code' }, code),
      h(
        'div',
        { class: 'wa-links' },
        link(this.#copied ? 'Copied' : 'Copy', () => {
          void globalThis.navigator.clipboard
            ?.writeText(code)
            .then(() => {
              this.#copied = true;
              this.#render(auth.getState());
            })
            .catch(() => {});
        }),
      ),
      h(
        'p',
        { class: 'wa-small' },
        'It is the only way into this account from an app that has never seen it. Nobody can reissue it, and it is stored nowhere but where you put it. On this device you can add a passkey afterwards, so you will rarely need it again.',
      ),
    );
  }

  // ─── Arriving from a phone-pairing QR code ─────────────────────────

  /**
   * One button. Everything needed is already in the address bar, but signing
   * in still takes a tap: the code in the link is a secret, and a page that
   * used it the instant it loaded would sign someone in from a link they had
   * merely opened by accident.
   */
  #pair(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Add this phone'),
      h('p', { class: 'wa-subtitle' }, 'You scanned a code from your computer.'),
      h(
        'p',
        { class: 'wa-hint' },
        'This phone becomes the same account, with its own copy of your spaces.',
        info(
          'What happens next',
          'It syncs with your computer when both are around, and keeps working when they are not. Your spaces come over the network directly between the two devices — the relay only introduces them.',
        ),
      ),
      h(
        'button',
        { type: 'button', class: 'wa-button', disabled: state.busy, onclick: () => void auth.acceptPairing() },
        state.busy ? 'Setting up…' : 'Set up this phone',
      ),
      state.pairingStage
        ? h('p', { class: state.pairingStage.kind === 'failed' ? 'wa-error' : 'wa-hint', style: 'margin-top:12px' }, describePairing(state.pairingStage))
        : null,
      errorBox(state.error),
      h('p', { class: 'wa-small' }, 'Keep the code showing until this finishes.'),
      h('div', { class: 'wa-links' }, link('Not now', () => auth.dismissPairing(), state.busy)),
    );
  }
}

/** Registers `<weave-auth>`, once. Importing this module does it for you. */
export function defineWeaveAuth(tag = 'weave-auth'): void {
  const registry = globalThis.customElements;
  if (registry && !registry.get(tag)) registry.define(tag, WeaveAuthElement);
}

defineWeaveAuth();

declare global {
  interface HTMLElementTagNameMap {
    'weave-auth': WeaveAuthElement;
  }
  interface HTMLElementEventMap {
    'weave-session': CustomEvent<WeaveSessionEventDetail>;
  }
}
