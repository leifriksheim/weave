import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { HostPlan, PayAnswer } from '@weaveprotocol/core';
import { styles, palette } from './styles';

type Request = Extract<PayAnswer, { request: unknown }>['request'];

/**
 * Paying a host, shown here rather than on the host's own site
 * (spec/06-nodes-and-sessions.md, Hosts): its plans as buttons, then what the
 * host answers. A checkout page, at the payment provider, opens in a new tab.
 * A payment request shows as a QR code and a link any wallet opens, and a
 * wallet in this browser can send it in one click. Nothing about paying
 * passes through this page but the host's answer.
 *
 * `paid` is asked every few seconds while a request is open: the host sees
 * the payment arrive by itself, and says so in its status.
 */
export function Payment({
  plans,
  start,
  paid,
}: {
  plans: ReadonlyArray<HostPlan>;
  start: (plan: string) => Promise<PayAnswer>;
  paid: () => Promise<boolean>;
}) {
  const [request, setRequest] = useState<Request | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = (plan: HostPlan) => {
    // Opened at once, inside the click, so no popup blocker stops it; the page follows.
    const tab = plan.method === 'checkout' ? window.open('about:blank', '_blank') : null;
    setBusy(plan.id);
    setProblem(null);
    void start(plan.id)
      .then((answer) => {
        if ('request' in answer) {
          tab?.close();
          return setRequest(answer.request);
        }
        if (!tab) return void window.open(answer.checkout, '_blank', 'noopener');
        // Cut the tab loose first: the provider's page can't reach back into this one.
        tab.opener = null;
        tab.location.href = answer.checkout;
      })
      .catch((error: unknown) => {
        tab?.close();
        setProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(null));
  };

  if (request) return <PaymentRequest request={request} paid={paid} onClose={() => setRequest(null)} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {plans.map((plan, i) => (
          <button
            key={plan.id}
            onClick={() => choose(plan)}
            disabled={busy !== null}
            data-variant={i === 0 ? undefined : 'quiet'}
            style={i === 0 ? styles.addButton : styles.smallButton}
          >
            {busy === plan.id ? 'Starting…' : plan.label}
          </button>
        ))}
      </div>
      {problem && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{problem}</p>}
    </div>
  );
}

/**
 * Asking the host to email a reminder before paid time runs out. The host
 * mails a link to confirm first, so the address is only used once its owner
 * says yes.
 */
export function RemindMe({ remind }: { remind: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'asked'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  if (state === 'asked')
    return <p style={{ ...styles.errorHint, marginTop: 0 }}>Check your inbox for a link to confirm.</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setState('busy');
        setProblem(null);
        remind(email.trim()).then(
          () => setState('asked'),
          (error: unknown) => {
            setState('idle');
            setProblem(error instanceof Error ? error.message : String(error));
          },
        );
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email me before it runs out"
          aria-label="Email for reminders"
          autoComplete="email"
          style={{ ...styles.input, flex: 1 }}
        />
        <button
          type="submit"
          disabled={state === 'busy' || !email.trim()}
          data-variant="quiet"
          style={styles.smallButton}
        >
          Remind me
        </button>
      </div>
      {problem && (
        <p style={{ ...styles.errorHint, marginTop: 0, color: palette.accent.danger }}>{problem}</p>
      )}
    </form>
  );
}

/** A payment to send from a wallet: a QR code, a link, and one click for a wallet in this browser */
function PaymentRequest({
  request,
  paid,
  onClose,
}: {
  request: Request;
  paid: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [done, setDone] = useState(false);
  const [wallet, setWallet] = useState<Eip1193 | null>(null);
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void browserWallet().then(setWallet);
  }, []);
  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => {
      void paid().then(
        (yes) => yes && setDone(true),
        () => {},
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [paid, done]);

  const send = async () => {
    if (!wallet || !request.evm) return;
    setSending('sending');
    setProblem(null);
    try {
      await sendTransfer(wallet, request.evm);
      setSending('sent');
    } catch (error) {
      setSending('idle');
      setProblem(walletError(error));
    }
  };

  if (done)
    return (
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <p style={{ ...styles.errorHint, marginTop: 0, color: palette.accent.good }}>Payment received.</p>
        <button onClick={onClose} data-variant="quiet" style={styles.smallButton}>
          Done
        </button>
      </div>
    );
  const expires = new Date(request.expires * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 10,
        padding: 14,
      }}
    >
      <QrCode text={request.uri} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 200 }}>
        <p style={{ fontSize: 14, color: palette.ink.strong }}>
          Send exactly <strong>{request.amount}</strong>
        </p>
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          The last digits mark the payment as yours, so send the amount as it is. Scan the code with a phone
          wallet, or open it in one here. It counts until {expires}.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {wallet && request.evm && (
            <button onClick={() => void send()} disabled={sending !== 'idle'} style={styles.addButton}>
              {sending === 'sending'
                ? 'Confirm in your wallet…'
                : sending === 'sent'
                  ? 'Sent'
                  : 'Pay with this browser’s wallet'}
            </button>
          )}
          <a
            href={request.uri}
            data-variant="quiet"
            style={{ ...styles.smallButton, textDecoration: 'none' }}
          >
            Open in a wallet
          </a>
          <button onClick={onClose} data-variant="quiet" style={styles.smallButton}>
            Cancel
          </button>
        </div>
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          {sending === 'sent' ? 'Sent. ' : ''}Waiting for it to arrive: it shows here within a minute of the
          network confirming it.
        </p>
        {problem && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{problem}</p>}
      </div>
    </div>
  );
}

/** A QR code, drawn as one SVG path, dark on light whatever the theme so every camera reads it */
function QrCode({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
  const side = count + 8;
  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={168}
      height={168}
      role="img"
      aria-label="QR code for the payment"
      style={{ borderRadius: 8, flexShrink: 0 }}
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={path} fill="#000" shapeRendering="crispEdges" />
    </svg>
  );
}

// ─── A wallet in this browser (EIP-1193, found through EIP-6963) ───

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const isEip1193 = (value: unknown): value is Eip1193 =>
  typeof value === 'object' && value !== null && 'request' in value && typeof value.request === 'function';

/** The first wallet this browser announces (EIP-6963), or the old `window.ethereum`; null when there is none */
function browserWallet(): Promise<Eip1193 | null> {
  return new Promise((resolve) => {
    let found: Eip1193 | null = null;
    const announced = (event: Event) => {
      const detail: unknown = 'detail' in event ? event.detail : null;
      const provider =
        typeof detail === 'object' && detail !== null && 'provider' in detail ? detail.provider : null;
      if (!found && isEip1193(provider)) found = provider;
    };
    window.addEventListener('eip6963:announceProvider', announced);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', announced);
      const legacy: unknown = Reflect.get(window, 'ethereum');
      resolve(found ?? (isEip1193(legacy) ? legacy : null));
    }, 300);
  });
}

/** Asks the wallet to send the token: `transfer(to, units)` on its contract, on its network */
async function sendTransfer(wallet: Eip1193, evm: NonNullable<Request['evm']>): Promise<void> {
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  const from: unknown = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof from !== 'string') throw new Error('The wallet shared no account');
  const chain = await wallet.request({ method: 'eth_chainId' });
  if (Number(chain) !== evm.chainId) {
    try {
      await wallet.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${evm.chainId.toString(16)}` }],
      });
    } catch {
      throw new Error(`Switch your wallet to ${evm.chainName} first, or scan the code with a phone wallet`);
    }
  }
  // ERC-20 transfer(to, amount): a 4-byte selector and two 32-byte words.
  const data =
    '0xa9059cbb' +
    evm.to.slice(2).toLowerCase().padStart(64, '0') +
    BigInt(evm.units).toString(16).padStart(64, '0');
  await wallet.request({ method: 'eth_sendTransaction', params: [{ from, to: evm.token, data }] });
}

function walletError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 4001) return 'Cancelled in the wallet';
  return error instanceof Error ? error.message : String(error);
}
