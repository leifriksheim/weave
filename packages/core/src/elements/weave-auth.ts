/**
 * @module elements/weave-auth
 * `<weave-auth>`: the whole sign-in flow as one element.
 *
 * ```html
 * <weave-auth app-name="Todo" relays="wss://relay.example"></weave-auth>
 * <script type="module">
 *   import '@weaveprotocol/core/elements';
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
 * a shadow root, and the everyday password living in a password manager is
 * much of the point. Its styles are scoped to the element instead.
 *
 * It fills whatever box it is put in — a page, a modal, a panel — and draws
 * nothing once signed in; the host decides what happens then.
 */
import { createWeaveAuth, MIN_PASSWORD_LENGTH, type AuthError, type AuthState, type WeaveAuth, type WeaveSession } from '../session/auth.js';
import { accountCredentialName, offerToSave, recoveryKit } from '../session/credentials.js';
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

/** Hands the page a text file to save. */
function download({ filename, text }: { filename: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = h('a', { href: url, download: filename, style: 'display:none' });
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  #filledAs = '';
  #copied = false;
  #stored = false;
  #choosingPassword = false;
  #showPairHelp = false;
  #mismatch = false;
  #lastSelected: string | null = null;
  #lastStage: string | null = null;

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
    if (state.selectedId !== this.#lastSelected || state.stage !== this.#lastStage) {
      this.#lastSelected = state.selectedId;
      this.#lastStage = state.stage;
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
    this.#filledAs = '';
    this.#copied = false;
    this.#stored = false;
    this.#choosingPassword = false;
    this.#showPairHelp = false;
    this.#mismatch = false;
  }

  #redraw(): void {
    this.#render(this.auth.getState());
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
    switch (state.stage) {
      case 'ready':
        return [];
      case 'starting':
        return [h('div', { class: 'wa-card' }, h('p', { class: 'wa-hint' }, 'Looking for your accounts…'))];
      case 'pair':
        return [this.#pair(state)];
      case 'create':
        return [this.#create(state)];
      case 'recovery':
        return [this.#recovery(state)];
      case 'unlock':
        return [this.#unlock(state)];
      case 'pod':
        return [this.#pod(state)];
      case 'welcome':
        return [this.#welcome(state)];
      case 'existing':
        return [this.#existing(state)];
      case 'restore':
        return [this.#restore(state)];
      case 'signIn':
        return [this.#signIn(state)];
    }
  }

  /** Where accounts are read from, shown only when it is a pod — a new person should not have to think about it. */
  #podLine(state: AuthState): HTMLElement | null {
    const place = state.place;
    if (place?.kind !== 'folder') return null;
    return h(
      'p',
      { class: 'wa-small', style: 'margin-top:24px' },
      `Pod: ${place.directory?.name ?? 'your folder'} · `,
      link('Use this browser instead', () => void this.auth.useBrowser(), state.busy),
    );
  }

  // ─── New here, or not ──────────────────────────────────────────────

  #welcome(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Welcome to Weave'),
      h('p', { class: 'wa-subtitle' }, 'One account for every Weave app. Your data stays with you, not on a server.'),
      h(
        'div',
        { class: 'wa-options' },
        option(
          'Create an account',
          "Takes a minute. You'll get a recovery code to keep safe, then sign in with a passkey or a password.",
          () => auth.startCreating(),
          state.busy,
        ),
        option('I already have one', 'Open your pod, use your recovery code, or add this device from another.', () => auth.showExisting(), state.busy),
      ),
      errorBox(state.error),
      this.#podLine(state),
    );
  }

  /**
   * "I already have an account", from a place that does not list it. Where the
   * data lives comes up here and only here: someone with a pod has something to
   * point at, and someone without one has other ways in.
   */
  #existing(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Find your account'),
      h('p', { class: 'wa-subtitle' }, 'Any of these gets you in.'),
      h(
        'div',
        { class: 'wa-options' },
        state.folderAvailable
          ? option(
              'Open your pod',
              'The folder your Weave data lives in. Its accounts are listed next, ready to unlock with your passkey or password.',
              () => void auth.choosePod(),
              state.busy,
            )
          : null,
        option(
          'Add this device from another',
          'From a device where you are signed in. Nothing to type — your spaces come across too.',
          () => {
            this.#showPairHelp = !this.#showPairHelp;
            this.#redraw();
          },
          state.busy,
        ),
        this.#showPairHelp
          ? h(
              'ol',
              { class: 'wa-steps' },
              h('li', null, 'On the signed-in device, open your account page.'),
              h('li', null, 'Choose ', h('strong', null, 'Add your phone'), ' and show the pairing code.'),
              h('li', null, "Scan it with this device's camera and open the link."),
            )
          : null,
        option(
          'Use your recovery code',
          'The 26-character code you kept when you made the account. Works on any device.',
          () => auth.showRestore(),
          state.busy,
        ),
      ),
      errorBox(state.error),
      h(
        'div',
        { class: 'wa-links' },
        link('Back', () => (state.accounts.length > 0 ? auth.showSignIn() : auth.showWelcome()), state.busy),
        link('Create a new account instead', () => auth.startCreating(), state.busy),
      ),
      this.#podLine(state),
    );
  }

  // ─── Choosing an account, and getting in ───────────────────────────

  /**
   * The recovery-code form.
   *
   * Kept a password form with an off-screen username, because before
   * passwords existed the recovery code *was* this site's login and many
   * people's password managers hold it that way. The username field is
   * off-screen, but deliberately not `display: none` — a field taken out of the
   * layout is not counted as a username, while one merely moved out of view is
   * filled normally. And writable: a manager fills the whole credential at
   * once, so a read-only username keeps showing the account that was clicked
   * while the code quietly belongs to another. Letting it be overwritten is
   * what makes the mismatch detectable.
   */
  #codeForm(state: AuthState, selected: AccountSummary | null): HTMLElement[] {
    const username = h('input', {
      type: 'text',
      name: 'username',
      autocomplete: 'username',
      value: accountCredentialName(selected?.name ?? 'My account'),
      class: 'wa-offscreen',
      tabindex: '-1',
      'aria-hidden': 'true',
    }) as HTMLInputElement;

    const code = this.#input('code', {
      type: 'password',
      name: 'password',
      placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX',
      autocomplete: 'current-password',
      spellcheck: 'false',
      autofocus: true,
      'aria-label': 'Recovery code',
      disabled: state.busy,
    });
    // Autofill sets the DOM value directly; read what it filled as well.
    code.addEventListener('input', () => {
      const filled = username.value.trim();
      if (filled !== this.#filledAs) {
        this.#filledAs = filled;
        this.#redraw();
      }
    });

    const wrong = selected !== null && this.#filledAs !== '' && this.#filledAs !== accountCredentialName(selected.name);
    return [
      h(
        'form',
        {
          class: 'wa-form',
          onsubmit: (event: Event) => {
            event.preventDefault();
            const value = code.value.trim();
            if (value) void this.auth.signInWithCode(value);
          },
        },
        username,
        code,
        h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, state.busy ? 'Opening…' : 'Continue'),
      ),
      wrong
        ? h(
            'p',
            { class: 'wa-error', style: 'margin-top:10px' },
            'Your password manager filled ',
            h('strong', null, this.#filledAs),
            ', not ',
            h('strong', null, selected.name),
            '. Pick the entry named ',
            h('strong', null, selected.name),
            ', or open that account instead.',
          )
        : null,
    ].filter((node): node is HTMLElement => node !== null);
  }

  /** The everyday password, filed under the account's name so a manager fills the right one. */
  #passwordForm(state: AuthState, account: AccountSummary): HTMLElement {
    const password = this.#input('password', {
      type: 'password',
      name: 'password',
      placeholder: 'Password',
      autocomplete: 'current-password',
      'aria-label': 'Password',
      disabled: state.busy,
    });
    return h(
      'form',
      {
        class: 'wa-form',
        onsubmit: (event: Event) => {
          event.preventDefault();
          if (password.value) void this.auth.signInWithPassword(password.value);
        },
      },
      h('input', {
        type: 'text',
        name: 'username',
        autocomplete: 'username',
        value: accountCredentialName(account.name),
        readonly: true,
        class: 'wa-offscreen',
        tabindex: '-1',
        'aria-hidden': 'true',
      }),
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
        // An account with wraps, none of them usable here, has been used on
        // another site — a passkey works on one web address only.
        const seenElsewhere = entry.vault.wraps.length > 0;

        if (hasShortcut) {
          body.push(
            h(
              'button',
              { type: 'button', class: 'wa-button', 'data-key': 'passkey', disabled: state.busy, onclick: () => void auth.signInWithPasskey() },
              state.busy ? 'Waiting…' : 'Sign in with passkey',
            ),
          );
        }
        if (entry.hasPassword) body.push(this.#passwordForm(state, account));

        if (hasShortcut || entry.hasPassword) {
          body.push(h('div', { class: 'wa-links' }, link('Use my recovery code', () => auth.showRestore(), state.busy)));
        } else {
          body.push(
            h(
              'p',
              { class: 'wa-small', style: 'margin:0 0 10px' },
              'No passkey or password here yet. Use your recovery code once, then choose one.',
              info(
                'Why it is asking for the recovery code',
                seenElsewhere
                  ? 'This account’s passkeys belong to the sites that made them — a passkey works on one web address only. The recovery code opens it anywhere.'
                  : 'The recovery code opens the account anywhere, with nothing stored. Next you set up a passkey or password so it stops asking.',
              ),
            ),
            ...this.#codeForm(state, selected),
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
      h('h1', { class: 'wa-title' }, 'Welcome back'),
      h('p', { class: 'wa-subtitle' }, accounts.length > 0 ? 'Choose your account.' : 'There are no accounts here yet.'),
      ...rows,
      errorBox(state.error),
      h(
        'div',
        { class: 'wa-links' },
        link('Another account', () => auth.showExisting(), state.busy),
        link('Create a new account', () => auth.startCreating(), state.busy),
      ),
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

  /** The recovery code, typed in: on a new device, or when no everyday way in is to hand. */
  #restore(state: AuthState): HTMLElement {
    const auth = this.auth;
    const selected = state.accounts.find((account) => account.id === state.selectedId) ?? null;
    // From the account list it restores that account; from "I already have one", any.
    const forSelected = selected !== null && state.accounts.length > 0 && state.entry !== null;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Use your recovery code'),
      h(
        'p',
        { class: 'wa-subtitle' },
        forSelected ? `For ${selected.name}. ` : '',
        'The 26-character code you kept when you made the account.',
      ),
      ...this.#codeForm(state, forSelected ? selected : null),
      errorBox(state.error),
      h(
        'div',
        { class: 'wa-links' },
        link('Back', () => (state.accounts.length > 0 ? auth.showSignIn() : auth.showExisting()), state.busy),
      ),
      h(
        'p',
        { class: 'wa-small', style: 'margin-top:16px' },
        "Lost it? If you're signed in on another device, add this one from there instead.",
      ),
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
      h('p', { class: 'wa-subtitle' }, 'What should apps call you? You can change it later.'),
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
        h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, state.busy ? 'Creating…' : 'Continue'),
      ),
      h('p', { class: 'wa-small' }, "Next: a recovery code to keep safe, then a passkey or password for signing in."),
      errorBox(state.error),
      h('div', { class: 'wa-links' }, link('I already have an account', () => auth.showExisting(), state.busy)),
      this.#podLine(state),
    );
  }

  /**
   * The recovery code, to keep.
   *
   * Deliberately not a password form: saved as this site's login, a manager
   * would later offer it in the everyday password field — and replace it with
   * that password when one is set, losing the only copy. So it is copied or
   * downloaded, and kept as a note or on paper.
   */
  #recovery(state: AuthState): HTMLElement {
    const auth = this.auth;
    const code = state.freshCode ?? '';
    const account = state.session?.account;
    const restored = state.setup === 'restored';
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, restored ? 'Keep your recovery code safe' : 'Your recovery code'),
      h(
        'p',
        { class: 'wa-hint' },
        restored
          ? 'You just used it. From now on a passkey or password signs you in here — keep this code for new devices and emergencies.'
          : 'This code is your account. With it you can restore your account on any device, even if you lose everything else.',
        info(
          'Why it matters',
          'Nobody can reissue it: there is no server that knows your account. Anyone who has it can open your account, so keep it private. ',
          'Save it as a secure note in your password manager, or print it and put it away — not as a login for this site, where a new password could replace it.',
        ),
      ),
      h('code', { class: 'wa-code wa-code-large' }, code),
      h(
        'div',
        { class: 'wa-row' },
        h(
          'button',
          {
            type: 'button',
            class: 'wa-secondary',
            onclick: () => {
              void globalThis.navigator.clipboard
                ?.writeText(code)
                .then(() => {
                  this.#copied = true;
                  this.#redraw();
                })
                .catch(() => {});
            },
          },
          this.#copied ? 'Copied' : 'Copy',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'wa-secondary',
            onclick: () => download(recoveryKit({ code, name: account?.name ?? 'My account', did: state.session?.did ?? '' })),
          },
          'Download',
        ),
      ),
      h(
        'label',
        { class: 'wa-check' },
        h('input', {
          type: 'checkbox',
          checked: this.#stored,
          onchange: (event: Event) => {
            this.#stored = (event.target as HTMLInputElement).checked;
            this.#redraw();
          },
        }),
        h('span', null, "I've stored my recovery code somewhere safe."),
      ),
      h('button', { type: 'button', class: 'wa-button', disabled: !this.#stored, onclick: () => auth.codeSaved() }, 'Continue'),
    );
  }

  /**
   * How this account is opened every day. Not skippable: without one, every
   * visit asks for the recovery code, and it ends up being used as a password
   * after all.
   */
  #unlock(state: AuthState): HTMLElement {
    const auth = this.auth;
    const account = state.session?.account;
    const passkeys = typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined';

    const choosing = this.#choosingPassword || !passkeys;
    const form = () => {
      const password = this.#input('new-password', {
        type: 'password',
        name: 'password',
        placeholder: 'Password',
        autocomplete: 'new-password',
        autofocus: true,
        minlength: String(MIN_PASSWORD_LENGTH),
        'aria-label': 'Password',
        disabled: state.busy,
      });
      const confirm = this.#input('confirm-password', {
        type: 'password',
        name: 'confirm-password',
        placeholder: 'The same again',
        autocomplete: 'new-password',
        'aria-label': 'Confirm password',
        disabled: state.busy,
      });
      return h(
        'form',
        {
          class: 'wa-form',
          style: passkeys ? 'margin-top:12px' : '',
          onsubmit: (event: Event) => {
            event.preventDefault();
            this.#mismatch = password.value !== confirm.value;
            if (this.#mismatch) {
              this.#redraw();
              return;
            }
            const chosen = password.value;
            const filedAs = accountCredentialName(account?.name ?? 'My account');
            void auth.setPassword(chosen).then((ok) => (ok ? offerToSave(filedAs, chosen, filedAs) : false));
          },
        },
        // A visible username is what makes a manager file the password under the account's name.
        h('input', {
          type: 'text',
          name: 'username',
          autocomplete: 'username',
          value: accountCredentialName(account?.name ?? 'My account'),
          readonly: true,
          'aria-label': 'Account',
        }),
        password,
        confirm,
        this.#mismatch ? h('p', { class: 'wa-error' }, 'Those two do not match.') : null,
        h('button', { type: 'submit', class: 'wa-button', disabled: state.busy }, state.busy ? 'Saving…' : 'Use this password'),
        h('p', { class: 'wa-small', style: 'margin-top:0' }, `At least ${MIN_PASSWORD_LENGTH} characters. Let your password manager make one.`),
      );
    };

    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'How do you want to sign in?'),
      h(
        'p',
        { class: 'wa-subtitle' },
        'This is what you will use every day.',
        info(
          'Where it works',
          'A passkey signs you in on this site, in this browser. A password works wherever your account is kept — this browser, or your pod in any app pointed at it. On a new device, add it from this one or use your recovery code.',
        ),
      ),
      h(
        'div',
        { class: 'wa-options' },
        passkeys
          ? option('Passkey', 'Touch ID, Windows Hello, or your password manager. Nothing to type.', () => void auth.addPasskey(), state.busy, true)
          : null,
        passkeys && !choosing
          ? option('Password', 'Saved in your password manager, like any other login.', () => {
              this.#choosingPassword = true;
              this.#redraw();
            }, state.busy)
          : null,
      ),
      choosing ? form() : null,
      state.setup === 'paired' && state.pairingStage
        ? h('p', { class: state.pairingStage.kind === 'failed' ? 'wa-error' : 'wa-small', style: 'margin-top:16px' }, describePairing(state.pairingStage))
        : null,
      errorBox(state.error),
    );
  }

  /** Offered once, at the end of making an account in a browser that can open a folder. */
  #pod(state: AuthState): HTMLElement {
    const auth = this.auth;
    return h(
      'div',
      { class: 'wa-card' },
      wordmark(),
      h('h1', { class: 'wa-title' }, 'Keep your data in a folder?'),
      h(
        'p',
        { class: 'wa-hint' },
        'A pod is a folder on your computer that holds your account and spaces. Back it up, or put it in iCloud or Dropbox. Any Weave app you point at it opens the same account.',
      ),
      h(
        'div',
        { class: 'wa-options' },
        option('Choose a folder', 'Your browser will ask to see it, then to save into it.', () => void auth.choosePod(), state.busy),
      ),
      errorBox(state.error),
      h('div', { class: 'wa-links' }, link('Not now — keep it in this browser', () => auth.finishSetup(), state.busy)),
      h('p', { class: 'wa-small' }, 'You can move it to a pod any time from your account page.'),
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
