/**
 * The host's pay page (BLOCK-23): where a subscription is paid, on the host's
 * own address, so no payment code ever runs next to an account's seed.
 *
 * The home opens it with a link signed by the subscription key, in the
 * fragment (`#s=…&at=…&sig=…`). The page keeps that in this tab's session
 * storage — it survives a trip to Stripe and back — and sends it with every
 * call to `/pay/api`. It offers what the host was set up with: card plans
 * through Stripe, browser wallets (EIP-6963, no library), and every other
 * wallet through WalletConnect (`pay/walletconnect.ts`) when the host has a
 * project id.
 *
 * Plain HTML and a script with no build step, so `weave host` serves it from
 * any way it's run.
 */

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page's own policy: its own script, the host's API, and what WalletConnect needs to reach wallets */
export const PAY_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https: data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  'frame-src https:',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function payPageHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pay ${escape(name)}</title>
<style>
  :root { --ink: #0a0a0a; --muted: #666; --line: #eaeaea; --sunken: #fafafa; --bg: #fff; --danger: #e00; --ok: #0a7d32; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ededed; --muted: #a1a1a1; --line: #2e2e2e; --sunken: #111; --bg: #000; --danger: #ff6166; --ok: #3dd68c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 48px 16px; display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  p { margin: 0; }
  .muted { color: var(--muted); font-size: 14px; }
  .box { border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .label { color: var(--muted); font-size: 13px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; font-size: 14px; border-radius: 8px; padding: 8px 14px; cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--ink); display: inline-flex; align-items: center; gap: 6px; }
  button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
  button:disabled { opacity: 0.5; cursor: default; }
  button img { width: 16px; height: 16px; }
  .error { color: var(--danger); font-size: 14px; }
  .ok { color: var(--ok); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div>
    <h1>${escape(name)}</h1>
    <p class="muted" id="status">Asking the host…</p>
  </div>
  <p id="note" class="ok" hidden></p>
  <div id="card" class="box" hidden><span class="label">Card, Apple Pay or Google Pay</span><div class="row" id="card-plans"></div></div>
  <div id="wallet" class="box" hidden>
    <span class="label" id="wallet-label"></span>
    <div class="row" id="wallet-plans"></div>
    <div class="row" id="wallet-picker" hidden></div>
    <span class="muted" id="wallet-fee"></span>
  </div>
  <div id="manage" hidden><button id="manage-button">Change card or cancel</button></div>
  <p id="error" class="error" hidden></p>
  <p class="muted">You can close this tab when you're done. Your home shows the new date when you go back to it.</p>
</main>
<script type="module" src="/pay/pay.js"></script>
</body>
</html>`;
}

/** The page's script. Plain JS, served as `/pay/pay.js`. */
export const PAY_SCRIPT = String.raw`
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };

// The pay link: in the fragment on arrival, kept for this tab after that (a trip to Stripe drops the fragment).
const fresh = new URLSearchParams(location.hash.slice(1));
if (fresh.get('s')) {
  try { sessionStorage.setItem('weave-pay', location.hash.slice(1)); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}
let kept = '';
try { kept = sessionStorage.getItem('weave-pay') || ''; } catch {}
const link = new URLSearchParams(fresh.get('s') ? fresh : kept);
const auth = link.get('s') ? 'WeavePay s=' + link.get('s') + ', at=' + link.get('at') + ', sig=' + link.get('sig') : null;

async function api(method, path, body) {
  const response = await fetch('/pay/api' + path, {
    method,
    headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(answer.error || 'The host answered ' + response.status), { status: response.status });
  return { status: response.status, answer };
}

function fail(error) {
  $('error').textContent = error && error.message ? error.message : String(error);
  show('error');
}
let busy = false;
async function act(work) {
  if (busy) return;
  busy = true;
  show('error', false);
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try { await work(); } catch (error) { fail(error); } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}
const button = (text, onClick, primary) => {
  const b = document.createElement('button');
  b.textContent = text;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
};

function describe(status) {
  const until = new Date(status.paidUntil * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  if (status.state === 'active' && status.paidUntil > 0) return (status.renews ? 'Renews on ' : 'Paid until ') + until + '.';
  if (status.state === 'active') return 'Free on this host.';
  if (status.state === 'grace') return 'The payment ran out on ' + until + '. Your spaces stay online for a while longer.';
  return 'Not paid for yet.';
}

let state = null;
async function load() {
  if (!auth) {
    $('status').textContent = 'Open this page from your Weave home: Settings, Keep my spaces online, Payment.';
    return;
  }
  try {
    state = (await api('GET', '')).answer;
  } catch (error) {
    $('status').textContent = error.status === 401 ? 'This link has run out. Open the page again from your Weave home.' : 'The host could not be reached.';
    if (error.status !== 401) fail(error);
    return;
  }
  $('status').textContent = describe(state.status);
  if (new URLSearchParams(location.search).get('paid')) {
    $('note').textContent = 'Payment received. It can take a moment to show here.';
    show('note');
  }
  // Paying again while a card renews by itself would pay twice: change the card instead.
  const payable = !state.status.renews;
  const plans = $('card-plans');
  plans.replaceChildren(...(state.card || []).map((plan, i) => button('Pay ' + plan.label.toLowerCase(), () => act(() => payByCard(plan.id)), i === 0)));
  show('card', payable && (state.card || []).length > 0);
  show('manage', state.status.renews);
  if (state.wallet && payable) {
    const w = state.wallet;
    const more = state.status.state === 'active' && state.status.paidUntil > 0 ? 'Add more time · ' : '';
    $('wallet-label').textContent = more + 'Crypto wallet · ' + w.symbol + ' on ' + w.chainName + ', straight to the host';
    $('wallet-plans').replaceChildren(...w.plans.map((plan, i) => button(plan.label + ' · ' + plan.price + ' ' + w.symbol, () => act(() => payByWallet(plan.id)), !(state.card || []).length && i === 0)));
    $('wallet-fee').textContent = 'Paid up front. The network fee, about a cent, is paid in ETH on ' + w.chainName + '.';
    show('wallet');
  } else show('wallet', false);
}

async function payByCard(plan) {
  location.assign((await api('POST', '/card', { plan })).answer.url);
}
$('manage-button').addEventListener('click', () => act(async () => location.assign((await api('POST', '/manage')).answer.url)));

// ─── Wallets ───

// Every wallet in this browser announces itself (EIP-6963); the old window.ethereum when none does.
function browserWallets() {
  return new Promise((resolve) => {
    const found = new Map();
    const announced = (event) => {
      const d = event.detail;
      if (d && d.info && d.info.uuid && d.provider) found.set(d.info.uuid, { name: d.info.name, icon: d.info.icon, provider: d.provider });
    };
    window.addEventListener('eip6963:announceProvider', announced);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', announced);
      if (found.size === 0 && window.ethereum) found.set('legacy', { name: 'Browser wallet', provider: window.ethereum });
      resolve([...found.values()]);
    }, 300);
  });
}

async function walletConnect() {
  const module = await import('/pay/walletconnect.js');
  return module.connect({ projectId: state.walletConnect, chainId: state.wallet.chainId, name: state.name });
}

async function payByWallet(plan) {
  const choices = (await browserWallets()).map((w) => ({ name: w.name, icon: w.icon, open: async () => w.provider }));
  if (state.walletConnect) choices.push({ name: choices.length ? 'Another wallet (QR code)' : 'Connect a wallet', open: walletConnect });
  if (choices.length === 0) throw new Error('There is no crypto wallet in this browser. Add one, like MetaMask or Coinbase Wallet, and open this page again.');
  if (choices.length === 1) return payWith(await choices[0].open(), plan);
  const picker = $('wallet-picker');
  picker.replaceChildren(...choices.map((choice) => {
    const b = button(choice.name, () => act(async () => { show('wallet-picker', false); await payWith(await choice.open(), plan); }));
    if (choice.icon) { const img = document.createElement('img'); img.src = choice.icon; img.alt = ''; b.prepend(img); }
    return b;
  }));
  show('wallet-picker');
}

const hex = (n) => '0x' + n.toString(16);
// ERC-20 transfer(to, amount): a 4-byte selector and two 32-byte words.
const transferData = (to, amount) => '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + BigInt(amount).toString(16).padStart(64, '0');

async function payWith(provider, plan) {
  const w = state.wallet;
  const payment = (await api('POST', '/wallet', { plan })).answer;
  try {
    let [from] = await provider.request({ method: 'eth_accounts' });
    if (!from) [from] = await provider.request({ method: 'eth_requestAccounts' });
    if (!from) throw new Error('The wallet shared no account');
    if (Number(await provider.request({ method: 'eth_chainId' })) !== payment.chainId) {
      const chainId = hex(payment.chainId);
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      } catch (error) {
        if (!error || error.code !== 4902) throw error; // 4902: a network the wallet doesn't know yet
        await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: w.chainName, rpcUrls: [w.rpcUrl], blockExplorerUrls: [w.explorerUrl], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }] });
      }
    }
    await checkBalances(provider, from, payment);
    const tx = await provider.request({ method: 'eth_sendTransaction', params: [{ from, to: payment.token, data: transferData(payment.to, payment.amount) }] });
    try { sessionStorage.setItem('weave-pay-tx', tx); } catch {}
    await claim(tx);
  } catch (error) {
    if (error && error.code === 4001) throw new Error('Cancelled in the wallet');
    throw error;
  }
}

// Where test money comes from, on a test network.
const FAUCETS = {
  84532: { usdc: 'faucet.circle.com (choose Base Sepolia)', eth: 'a Base Sepolia faucet (Coinbase\'s or Alchemy\'s)' },
};
const amountText = (units, decimals) => {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (units / scale).toString() + (fraction ? '.' + fraction : '');
};

// Said here, before the wallet opens: a transfer the wallet can't cover only shows there as "likely to fail".
async function checkBalances(provider, from, payment) {
  const w = state.wallet;
  const faucet = FAUCETS[payment.chainId];
  const usdc = BigInt(await provider.request({ method: 'eth_call', params: [{ to: payment.token, data: '0x70a08231' + from.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }));
  if (usdc < BigInt(payment.amount)) {
    throw new Error('This wallet has ' + amountText(usdc, payment.decimals) + ' ' + w.symbol + ' on ' + w.chainName + ', and this payment is ' + amountText(BigInt(payment.amount), payment.decimals) + '.' + (faucet ? ' Get test ' + w.symbol + ' at ' + faucet.usdc + '.' : ''));
  }
  const eth = BigInt(await provider.request({ method: 'eth_getBalance', params: [from, 'latest'] }));
  if (eth === 0n) {
    throw new Error('This wallet has no ETH on ' + w.chainName + ' for the network fee (about a cent).' + (faucet ? ' Get test ETH from ' + faucet.eth + '.' : ''));
  }
}

// Asks the host every few seconds until the network has confirmed the transfer.
async function claim(tx) {
  $('status').textContent = 'Payment sent. Waiting for the network to confirm it…';
  for (let tries = 0; tries < 60; tries++) {
    try {
      const { status } = await api('POST', '/wallet/claim', { tx });
      if (status === 200) {
        try { sessionStorage.removeItem('weave-pay-tx'); } catch {}
        $('note').textContent = 'Payment received.';
        show('note');
        return load();
      }
    } catch (error) {
      if (error.status === 400 || error.status === 409) { try { sessionStorage.removeItem('weave-pay-tx'); } catch {} }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("The network hasn't confirmed the payment yet. It counts once it has: open this page again in a while.");
}

await load();
// A payment sent before a reload is claimed when the page comes back.
let pending = null;
try { pending = sessionStorage.getItem('weave-pay-tx'); } catch {}
if (pending && state) act(() => claim(pending));
`;
