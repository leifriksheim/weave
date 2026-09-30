import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { HostPlan, PayAnswer } from '@weaveprotocol/core';
import { Glyph } from './Feature';
import { styles, palette } from './styles';

type Request = Extract<PayAnswer, { request: unknown }>['request'];

/**
 * Paying a host, shown here rather than on the host's own site
 * (spec/06-nodes-and-sessions.md, Hosts), in three steps: choose a plan, pay,
 * done. A plan is a card to pick, its price first and how it is paid under
 * it. A checkout page, at the payment provider, opens in a new tab; a payment
 * request shows here as an amount, a QR code and one click for a wallet in
 * this browser. Nothing about paying passes through this page but the host's
 * answer.
 *
 * `paid` is asked every few seconds once paying has started: the host sees
 * the payment arrive by itself, and says so in its status.
 */
export function PayFlow({
  plans,
  start,
  paid,
  onDone,
}: {
  plans: ReadonlyArray<HostPlan>;
  start: (plan: string) => Promise<PayAnswer>;
  paid: () => Promise<boolean>;
  onDone?: () => void;
}) {
  const [chosen, setChosen] = useState(plans[0]?.id ?? '');
  const [step, setStep] = useState<'choose' | 'checkout' | 'done' | Request>('choose');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Once paying has started, the host's word is what moves it on.
  useEffect(() => {
    if (step === 'choose' || step === 'done') return;
    const timer = setInterval(() => {
      void paid().then(
        (yes) => yes && setStep('done'),
        () => {},
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [paid, step]);

  const pay = () => {
    const plan = plans.find((known) => known.id === chosen);
    if (!plan) return;
    // Opened at once, inside the click, so no popup blocker stops it; the page follows.
    const tab = plan.method === 'checkout' ? window.open('about:blank', '_blank') : null;
    setBusy(true);
    setProblem(null);
    void start(plan.id)
      .then((answer) => {
        if ('request' in answer) {
          tab?.close();
          return setStep(answer.request);
        }
        setStep('checkout');
        if (!tab) return void window.open(answer.checkout, '_blank', 'noopener');
        // Cut the tab loose first: the provider's page can't reach back into this one.
        tab.opener = null;
        tab.location.href = answer.checkout;
      })
      .catch((error: unknown) => {
        tab?.close();
        setProblem(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  };

  if (step === 'done')
    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 0' }}
      >
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#eef8f0',
            color: palette.accent.good,
          }}
        >
          <Glyph name="check" size={22} style={{ strokeWidth: 2 }} />
        </span>
        <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>Payment received</p>
        <p style={{ fontSize: 13, color: palette.ink.muted }}>Thank you. It's already working.</p>
        {onDone && (
          <button onClick={onDone} data-variant="primary" style={{ ...styles.button, marginTop: 8 }}>
            Done
          </button>
        )}
      </div>
    );

  if (step === 'checkout')
    return (
      <Waiting
        title="Finish paying in the new tab"
        detail="This updates by itself once the payment goes through."
        onBack={() => setStep('choose')}
      />
    );

  if (step !== 'choose') return <PaymentRequest request={step} onBack={() => setStep('choose')} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        role="radiogroup"
        aria-label="How to pay"
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {plans.map((plan) => {
          const [price, how] = splitLabel(plan.label);
          const on = plan.id === chosen;
          return (
            <button
              key={plan.id}
              role="radio"
              aria-checked={on}
              onClick={() => setChosen(plan.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                textAlign: 'left',
                background: on ? palette.surface.sunken : palette.surface.card,
                border: `1px solid ${on ? palette.ink.strong : palette.surface.line}`,
                boxShadow: on ? `0 0 0 1px ${palette.ink.strong}` : 'none',
                color: palette.ink.body,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  flexShrink: 0,
                  border: `1.5px solid ${on ? palette.ink.strong : palette.surface.lineStrong}`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {on && (
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: palette.ink.strong }} />
                )}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>
                  {price}
                </span>
                {how && (
                  <span style={{ display: 'block', fontSize: 12.5, color: palette.ink.muted }}>{how}</span>
                )}
              </span>
              <Glyph
                name={plan.method === 'request' ? 'wallet' : 'card'}
                size={18}
                style={{ color: palette.ink.faint }}
              />
            </button>
          );
        })}
      </div>
      <button onClick={pay} disabled={busy || !chosen} data-variant="primary" style={styles.button}>
        {busy ? 'One moment…' : 'Continue to payment'}
      </button>
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </div>
  );
}

/** "$4 a month, by card" as its price and how it is paid */
function splitLabel(label: string): [string, string] {
  const comma = label.indexOf(', ');
  if (comma < 0) return [label, ''];
  const how = label.slice(comma + 2);
  return [label.slice(0, comma), how.charAt(0).toUpperCase() + how.slice(1)];
}

function Waiting({ title, detail, onBack }: { title: string; detail: string; onBack: () => void }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '16px 0' }}
    >
      <Pulse />
      <p style={{ fontSize: 15, fontWeight: 600, color: palette.ink.strong }}>{title}</p>
      <p style={{ fontSize: 13, color: palette.ink.muted, textAlign: 'center' }}>{detail}</p>
      <button onClick={onBack} style={{ ...styles.linkButton, marginTop: 4 }}>
        Choose another way to pay
      </button>
    </div>
  );
}

/** A dot that breathes while waiting for the host */
function Pulse() {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: 5,
        background: palette.accent.good,
        animation: 'weave-fade 0.9s ease-in-out infinite alternate',
      }}
    />
  );
}

/**
 * Asking the host to email a reminder before paid time runs out: a small
 * link that opens into one field. The host mails a link to confirm first,
 * so the address is only used once its owner says yes.
 */
export function RemindMe({ remind }: { remind: (email: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'asked'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  if (state === 'asked')
    return <p style={{ fontSize: 13, color: palette.ink.muted }}>Check your inbox for a link to confirm.</p>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} style={{ ...styles.linkButton, padding: 0 }}>
        Email me before it runs out
      </button>
    );
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
          placeholder="you@example.com"
          aria-label="Email for reminders"
          autoComplete="email"
          autoFocus
          style={{ ...styles.input, flex: 1, height: 36 }}
        />
        <button
          type="submit"
          disabled={state === 'busy' || !email.trim()}
          data-variant="quiet"
          style={{ ...styles.smallButton, height: 36 }}
        >
          Remind me
        </button>
      </div>
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </form>
  );
}

/** A payment to send from a wallet: the amount, a QR code, and one click for a wallet in this browser */
function PaymentRequest({ request, onBack }: { request: Request; onBack: () => void }) {
  const [wallet, setWallet] = useState<Eip1193 | null>(null);
  const [sending, setSending] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void browserWallet().then(setWallet);
  }, []);

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
  const [amount, network] = request.amount.split(' on ');
  const to = request.evm?.to;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div
          style={{
            padding: 8,
            borderRadius: 12,
            border: `1px solid ${palette.surface.line}`,
            background: '#fff',
            lineHeight: 0,
          }}
        >
          <QrCode text={request.uri} />
        </div>
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{ fontSize: 12, color: palette.ink.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}
          >
            Send exactly
          </span>
          <span
            style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: palette.ink.strong }}
          >
            {amount}
          </span>
          {network && <span style={{ fontSize: 13, color: palette.ink.muted }}>on {network}</span>}
          {to && (
            <button
              onClick={() =>
                void navigator.clipboard.writeText(to).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              style={{ ...styles.linkButton, padding: 0, marginTop: 6, textAlign: 'left', fontSize: 12 }}
            >
              To <code>{`${to.slice(0, 6)}…${to.slice(-4)}`}</code> · {copied ? 'Copied' : 'Copy address'}
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {wallet && request.evm && (
          <button
            onClick={() => void send()}
            disabled={sending !== 'idle'}
            data-variant="primary"
            style={styles.button}
          >
            {sending === 'sending'
              ? 'Confirm in your wallet…'
              : sending === 'sent'
                ? 'Sent'
                : 'Pay with your browser wallet'}
          </button>
        )}
        <a
          href={request.uri}
          data-variant="quiet"
          style={{
            ...styles.button,
            background: palette.surface.card,
            color: palette.ink.strong,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            textDecoration: 'none',
          }}
        >
          Open in a wallet app
        </a>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
        <Pulse />
        <span style={{ fontSize: 13, color: palette.ink.muted }}>
          {sending === 'sent' ? 'Sent. ' : ''}Waiting for it to arrive. The last digits mark it as yours.
        </span>
      </div>
      {problem && (
        <p style={{ fontSize: 13, color: palette.accent.danger, textAlign: 'center' }}>{problem}</p>
      )}
      <button onClick={onBack} style={{ ...styles.linkButton, alignSelf: 'center' }}>
        Choose another way to pay
      </button>
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
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 2} ${row + 2}h1v1h-1z`;
  const side = count + 4;
  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={148}
      height={148}
      role="img"
      aria-label="QR code for the payment"
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
