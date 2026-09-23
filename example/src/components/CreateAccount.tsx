import { useState, type FormEvent } from 'react';
import type { AuthError } from '../hooks/useProtocol';
import { Info } from './Info';
import { accountCredentialName } from '../accounts';
import { offerToSave } from '../credentials';
import { styles, variants } from '../styles';

const quietButton = variants.quiet;

/**
 * Making an account.
 *
 * The code is generated, not chosen, and it is shown as a password because that
 * is what it is for: your password manager saves it here and fills it in on the
 * next app. Framing matters more than anything else on this screen — "we made
 * you a strong password, save it" is true and is what people already do, where
 * "here is your cryptographic seed" is true and frightening.
 */
export function CreateAccount({
  code,
  loading,
  error,
  onCreate,
  onSaved,
  walletHere,
  onWallet,
  onBack,
}: {
  /** Shown once the account exists, so the manager has something to save */
  code: string | null;
  loading: boolean;
  error: AuthError | null;
  onCreate: (name: string) => void;
  /** The code has been saved; move on to where the data should live */
  onSaved: () => void;
  /** Whether a wallet that might hold an identity is installed */
  walletHere: boolean;
  onWallet: () => void;
  /** Go to sign-in. Never absent: an account password needs nothing stored. */
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!code) return;
    try {
      await globalThis.navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (code) {
    return (
      <div style={styles.container}>
        <div data-card style={styles.card}>
          <h1 style={styles.title}>🔑 Save your password</h1>
          <p style={styles.hint}>
            Save this to your password manager now — it will fill itself in from then on.
            <Info label="About this password">
              It is generated rather than chosen, and it <em>is</em> your key rather than a backup
              of it. That is what lets it work on an app that has never seen you, with nothing
              stored anywhere. It is shown once and nobody can reissue it.
            </Info>
          </p>

          {/* A real form with both fields is what makes a manager offer to
              save. A lone password input usually does not trigger it. */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const filedAs = accountCredentialName(name || 'My account');
              void offerToSave(filedAs, code, filedAs).then(onSaved);
            }}
            style={styles.saveForm}
          >
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={accountCredentialName(name || 'My account')}
              readOnly
              style={styles.input}
              aria-label="Account name"
            />
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              value={code}
              readOnly
              style={styles.input}
              aria-label="Account password"
            />
            <button type="submit" data-variant="primary" style={styles.button}>
              I've saved it — continue
            </button>
          </form>

          <code style={styles.recoveryCode}>{code}</code>
          <div style={styles.linkRow}>
            <button onClick={() => void copy()} data-variant="ghost" style={styles.linkButton}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p style={styles.errorHint}>
            It is the only way into this account from an app that has never seen it. Nobody can
            reissue it, and it is stored nowhere but where you put it. On this device you can add a
            passkey or a shorter password afterwards, so you will rarely need it again.
          </p>
        </div>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onCreate(name.trim());
  };

  return (
    <div style={styles.container}>
      <div data-card style={styles.card}>
        <h1 style={styles.title}>Weave</h1>
        <p style={styles.subtitle}>Lists that live in your hands, not on a server.</p>

        <form onSubmit={submit} style={styles.form}>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="What should we call you?"
            disabled={loading}
            style={styles.input}
            autoFocus
            autoComplete="off"
          />
          <button type="submit" disabled={loading || !name.trim()} data-variant="primary" style={styles.button}>
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <div style={styles.linkRow}>
          <button onClick={onBack} disabled={loading} data-variant="ghost" style={styles.linkButton}>
            I already have an account
          </button>
        </div>

        <p style={styles.errorHint}>
          We'll generate a strong password and show it once.
          <Info label="What happens next">
            Then you choose where your lists live: in this browser, or in a folder on your computer
            that other apps can open too. A folder is what lets a second app read the same data;
            this browser keeps it to itself.
          </Info>
        </p>

        {walletHere && (
          <section style={{ ...styles.panelSection, marginTop: 20 }}>
            <p style={styles.sectionTitle}>Or keep your key in MetaMask</p>
            <p style={styles.errorHint}>
              An add-on holds your identity in the wallet, so no app needs your password.
              <Info label="How the wallet holds an account">
                MetaMask runs it inside the extension rather than inside a website, so it answers on
                any app — including ones that have never seen you — and follows your recovery phrase
                onto new devices. Your key never reaches this page: apps ask it to sign a note that
                expires in an hour.
              </Info>
            </p>
            <button onClick={onWallet} disabled={loading} data-variant="quiet" style={quietButton}>
              {loading ? 'Waiting for MetaMask…' : '🦊 Continue with MetaMask'}
            </button>

          </section>
        )}

        {error && (
          <div style={styles.errorBox}>
            <p style={styles.error}>{error.message}</p>
            {error.hint && <p style={styles.errorHint}>{error.hint}</p>}
          </div>
        )}

      </div>
    </div>
  );
}
