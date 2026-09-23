/**
 * Runs the built Snap against a stubbed MetaMask.
 *
 * A checksum says the bundle is the one that was published. It says nothing
 * about whether the code inside works, and every failure so far has been of
 * that second kind — found only after publishing, installing, and reading an
 * error in a browser. This is the ten-second version of that loop.
 *
 * It cannot tell you whether the real sandbox provides WebCrypto, since Node
 * always does. It can tell you the logic is right, which is the other half.
 */
import { createHash } from 'node:crypto';

const calls = [];
let state = {};

// A stand-in for the wallet. The BIP-32 node is fixed, so the DID below is a
// golden value: if the derivation ever changes, everyone's identity changes,
// and that should be a deliberate migration rather than a surprise.
globalThis.snap = {
  async request({ method, params }) {
    calls.push(method);
    switch (method) {
      case 'snap_manageState':
        if (params.operation === 'get') return Object.keys(state).length ? state : null;
        state = params.newState;
        return null;
      case 'snap_getBip32Entropy':
        return {
          privateKey: '0x' + createHash('sha256').update('test-seed-phrase').digest('hex'),
          chainCode: '0x' + '11'.repeat(32),
        };
      case 'snap_dialog':
        return params.type === 'prompt' ? null : true;
      default:
        throw new Error(`stub has no ${method}`);
    }
  },
};

// A CommonJS bundle imported from ESM: esbuild defines its exports with
// `defineProperty`, which Node's named-export detection cannot see, so the
// handler is on `default`. MetaMask loads it as CommonJS and sees it directly.
const loaded = await import('./dist/bundle.js');
const onRpcRequest = loaded.default?.onRpcRequest ?? loaded.onRpcRequest;
const call = (method, params) =>
  onRpcRequest({ origin: 'https://todos.example', request: { method, ...(params ? { params } : {}) } });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// Who am I?
const account = await call('getAccount');
check('getAccount returns a did:key', /^did:key:z/.test(account.did ?? ''), account.did);
check('reports how the key was obtained', account.kind === 'derived', account.kind);

// Deterministic: the same wallet must give the same identity every time, or
// signing in twice means two different people.
const again = await call('getAccount');
check('derivation is deterministic', again.did === account.did);

// The one thing an app actually needs.
const delegation = await call('signDelegation', {
  audience: 'did:key:zSessionKeyPlaceholder',
  capabilities: [{ with: '*', can: 'expression/*' }],
  expiration: Math.floor(Date.now() / 1000) + 999999,
});
const [, payloadPart] = (delegation.token ?? '..').split('.');
const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));

check('signDelegation returns a token', typeof delegation.token === 'string');
check('issued by this identity', payload.iss === account.did);
check('addressed to the session key', payload.aud === 'did:key:zSessionKeyPlaceholder');
check(
  'expiry is capped at an hour whatever was asked for',
  payload.exp <= Math.floor(Date.now() / 1000) + 3601,
  `${payload.exp - Math.floor(Date.now() / 1000)}s`,
);
check('asked the user before the first delegation', calls.includes('snap_dialog'));

// The key that decrypts this account's data at rest.
const vault = await call('getVaultKey');
check('getVaultKey returns a key', typeof vault.key === 'string' && vault.key.length > 20);

// The escape hatch.
const exported = await call('exportCode');
check('exportCode returns a 26-character code', (exported.code ?? '').replace(/-/g, '').length === 26);

// A wallet holds several keys, and so should this.
const derived = account.did;
const listed = await call('listAccounts');
check('lists the derived account', listed.accounts.length === 1 && listed.accounts[0].did === derived);

// Import one that is not the derived account.
const other = 'K7M29QPX3J4H5RST6VWY7Z8ABC';
const imported = await call('importAccount', { code: other });
check('importAccount adds an account', imported.kind === 'imported', imported.kind);
check('and switches to it', imported.did !== derived);

const both = await call('listAccounts');
check('both accounts are held at once', both.accounts.length === 2, `${both.accounts.length}`);
check('the imported one is selected', both.selected === imported.did);

// Switching back is what the single-account version could not do at all.
const back = await call('selectAccount', { did: derived });
check('selectAccount switches to the derived one', back.did === derived, back.kind);
check('and getAccount agrees', (await call('getAccount')).did === derived);

const toImported = await call('selectAccount', { did: imported.did });
check('and back again', toImported.did === imported.did);

const unknown = await call('selectAccount', { did: 'did:key:zNope' }).then(() => 'accepted', () => 'refused');
check('an account it does not hold is refused', unknown === 'refused');

const bad = await call('importAccount', { code: 'not-a-code' }).then(() => 'accepted', () => 'refused');
check('a malformed code is refused', bad === 'refused');

await call('forgetAccount', { did: imported.did });
const after = await call('listAccounts');
check('forgetAccount drops it', after.accounts.length === 1);
check('and falls back to the derived account', (await call('getAccount')).kind === 'derived');

// Refusals should be refusals, not silent successes.
await call('nonsense').then(
  () => check('unknown methods are refused', false),
  () => check('unknown methods are refused', true),
);

console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
