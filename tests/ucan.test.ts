/**
 * UCAN delegation tests — issuing, verifying, attenuating and chain validation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import {
  issueUCAN,
  parseUCAN,
  verifyUCAN,
  isCapabilitySubset,
  validateDelegationChain,
  delegateCapabilities,
  type Capability,
} from '../src/identity/ucan.js';

const provider = createP256Provider();

/** A fresh keypair plus its did:key identifier. */
async function makeKey() {
  const pair = await provider.generateKeyPair();
  const did = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  return { did, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

const ALL: Capability = { with: 'space:todos', can: 'expression/*' };
const WRITE: Capability = { with: 'space:todos', can: 'expression/write' };
const READ: Capability = { with: 'space:todos', can: 'expression/read' };

describe('issueUCAN / verifyUCAN', () => {
  test('round-trips a signed token', async () => {
    const root = await makeKey();
    const session = await makeKey();

    const token = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [WRITE] },
      provider,
    );

    assert.equal(token.encoded.split('.').length, 3);
    assert.equal(token.header.alg, 'ES256');
    assert.equal(token.payload.iss, root.did);
    assert.equal(token.payload.aud, session.did);

    const result = await verifyUCAN(token.encoded, provider);
    assert.equal(result.valid, true, result.reason);
    assert.deepEqual(result.capabilities, [WRITE]);
  });

  test('parses without verifying', async () => {
    const root = await makeKey();
    const token = await issueUCAN(
      { issuer: root, audience: root.did, capabilities: [READ] },
      provider,
    );
    const { header, payload, signature } = parseUCAN(token.encoded);
    assert.equal(header.ucv, '0.10.0');
    assert.equal(payload.iss, root.did);
    assert.equal(signature, token.signature);
  });

  test('rejects an expired token', async () => {
    const root = await makeKey();
    const token = await issueUCAN(
      {
        issuer: root,
        audience: root.did,
        capabilities: [WRITE],
        expiration: Math.floor(Date.now() / 1000) - 10,
      },
      provider,
    );
    const result = await verifyUCAN(token.encoded, provider);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /expired/i);
  });

  test('rejects a token that is not yet valid', async () => {
    const root = await makeKey();
    const token = await issueUCAN(
      {
        issuer: root,
        audience: root.did,
        capabilities: [WRITE],
        notBefore: Math.floor(Date.now() / 1000) + 600,
      },
      provider,
    );
    const result = await verifyUCAN(token.encoded, provider);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /not yet valid/i);
  });

  test('rejects a tampered payload', async () => {
    const root = await makeKey();
    const victim = await makeKey();
    const token = await issueUCAN(
      { issuer: root, audience: victim.did, capabilities: [READ] },
      provider,
    );

    const [header, , signature] = token.encoded.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...token.payload, att: [{ with: '*', can: '*' }] }),
    ).toString('base64url');

    const result = await verifyUCAN(`${header}.${forgedPayload}.${signature}`, provider);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /signature/i);
  });

  test('rejects a malformed token', async () => {
    const result = await verifyUCAN('not-a-jwt', provider);
    assert.equal(result.valid, false);
  });
});

describe('isCapabilitySubset', () => {
  test('exact matches and wildcards grant', () => {
    assert.equal(isCapabilitySubset(WRITE, WRITE), true);
    assert.equal(isCapabilitySubset(ALL, WRITE), true);
    assert.equal(isCapabilitySubset({ with: '*', can: '*' }, WRITE), true);
  });

  test('narrower parents do not grant broader children', () => {
    assert.equal(isCapabilitySubset(READ, WRITE), false);
    assert.equal(isCapabilitySubset({ with: 'space:other', can: '*' }, WRITE), false);
  });
});

describe('delegateCapabilities', () => {
  test('attenuates and chains to the parent', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();

    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );
    const child = await delegateCapabilities(
      { parent, issuer: session, audience: guest.did, capabilities: [READ] },
      provider,
    );

    assert.deepEqual(child.payload.prf, [parent.cid]);
    assert.equal(child.payload.iss, session.did);
    assert.equal(child.payload.exp <= parent.payload.exp, true);

    const chain = await validateDelegationChain(child.encoded, [parent.encoded], provider);
    assert.equal(chain.valid, true, chain.reason);
  });

  test('refuses to escalate beyond the parent capabilities', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();

    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [READ] },
      provider,
    );

    await assert.rejects(
      delegateCapabilities(
        { parent, issuer: session, audience: guest.did, capabilities: [WRITE] },
        provider,
      ),
      /not a subset/i,
    );
  });

  test('refuses to outlive the parent', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();

    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );

    await assert.rejects(
      delegateCapabilities(
        {
          parent,
          issuer: session,
          audience: guest.did,
          capabilities: [READ],
          expiration: parent.payload.exp + 3600,
        },
        provider,
      ),
      /expiration/i,
    );
  });

  test('refuses a delegator that is not the parent audience', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const stranger = await makeKey();

    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );

    await assert.rejects(
      delegateCapabilities(
        { parent, issuer: stranger, audience: stranger.did, capabilities: [READ] },
        provider,
      ),
      /audience/i,
    );
  });
});

describe('validateDelegationChain', () => {
  test('accepts a root token with no proofs', async () => {
    const root = await makeKey();
    const token = await issueUCAN(
      { issuer: root, audience: root.did, capabilities: [ALL] },
      provider,
    );
    const chain = await validateDelegationChain(token.encoded, [], provider);
    assert.equal(chain.valid, true, chain.reason);
  });

  test('reports a missing proof', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const guest = await makeKey();

    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );
    const child = await delegateCapabilities(
      { parent, issuer: session, audience: guest.did, capabilities: [READ] },
      provider,
    );

    const chain = await validateDelegationChain(child.encoded, [], provider);
    assert.equal(chain.valid, false);
    assert.match(chain.reason ?? '', /missing proof/i);
  });

  test('detects a broken audience → issuer link', async () => {
    const root = await makeKey();
    const session = await makeKey();
    const stranger = await makeKey();
    const guest = await makeKey();

    // Root delegates to `session`, but `stranger` is the one who signs the child,
    // naming the root token as its proof anyway.
    const parent = await issueUCAN(
      { issuer: root, audience: session.did, capabilities: [ALL] },
      provider,
    );
    const forged = await issueUCAN(
      {
        issuer: stranger,
        audience: guest.did,
        capabilities: [READ],
        proofs: [parent.cid],
        expiration: parent.payload.exp,
      },
      provider,
    );

    const chain = await validateDelegationChain(forged.encoded, [parent.encoded], provider);
    assert.equal(chain.valid, false);
    assert.match(chain.reason ?? '', /chain broken/i);
  });
});
