import { useEffect, useRef, useState } from 'react';
import { styles, palette } from './styles';
import { message } from './action';

/**
 * A host's address as a person types it, as its origin. `host.example` is
 * read as https://, and a pasted address may carry a path. Plain http:// only
 * on this machine, as the node itself asks (`hosting.use`).
 * @throws With a sentence to show, when it isn't an address a host can have
 */
export function hostAddress(typed: string): string {
  const text = typed.trim();
  const here = /^(localhost|127\.0\.0\.1)([:/]|$)/i.test(text);
  const unreadable = new Error('That isn’t an address. A host’s looks like https://host.example');
  // The URL parser takes almost anything as a host name, spaces included.
  if (/\s/.test(text)) throw unreadable;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${here ? 'http' : 'https'}://${text}`);
  } catch {
    throw unreadable;
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('A host is reached over https://');
  return url.origin;
}

/**
 * Whether what is being waited for is still wanted. False once the person
 * cancelled or closed the dialog: whoever asked then writes nothing.
 */
export type Wanted = () => boolean;

/** A `Wanted` that holds until the component showing it goes away */
export function useWanted(): Wanted {
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  return () => shown.current;
}

/**
 * Another host, by its address: one field and one button. While the host is
 * asked the button says so and Cancel is beside it, so an address nothing
 * answers at never leaves the form stuck; what went wrong is said under it,
 * and the address stays to be corrected.
 */
export function HostAddressForm({
  onAddress,
  label = 'Use it',
}: {
  /** Uses the host at this origin. Check `wanted()` after asking it, before anything is written. */
  onAddress: (url: string, wanted: Wanted) => Promise<void>;
  label?: string;
}) {
  const [address, setAddress] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Each try has a number: a later try, Cancel, or the form going away makes an earlier one unwanted.
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const submit = async () => {
    attempt.current += 1;
    const mine = attempt.current;
    const wanted = () => attempt.current === mine;
    setProblem(null);
    let url: string;
    try {
      url = hostAddress(address);
    } catch (error) {
      return setProblem(message(error));
    }
    setAsking(new URL(url).host);
    try {
      await onAddress(url, wanted);
    } catch (error) {
      if (wanted()) setProblem(message(error));
    } finally {
      if (wanted()) setAsking(null);
    }
  };
  const cancel = () => {
    attempt.current += 1;
    setAsking(null);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setProblem(null);
          }}
          readOnly={asking !== null}
          placeholder="https://host.example"
          aria-label="A host's address"
          aria-invalid={problem !== null}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          style={{ ...styles.input, flex: 1, minWidth: 0 }}
        />
        <button
          type="submit"
          disabled={asking !== null || !address.trim()}
          data-variant="primary"
          style={styles.addButton}
        >
          {asking ? 'Asking…' : label}
        </button>
      </div>
      {asking && (
        <p role="status" style={{ fontSize: 13, color: palette.ink.muted }}>
          Asking {asking}…{' '}
          <button
            type="button"
            onClick={cancel}
            style={{ ...styles.linkButton, padding: 0, color: palette.ink.strong }}
          >
            Cancel
          </button>
        </p>
      )}
      {problem && (
        <p role="alert" style={{ fontSize: 13, color: palette.accent.danger }}>
          {problem}
        </p>
      )}
    </form>
  );
}
