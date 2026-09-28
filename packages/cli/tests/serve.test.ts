import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHello } from '../src/serve.js';
import { createClientAuth, createServerAuth } from '../../core/src/network/peer-auth.js';
import { createP256Provider } from '../../core/src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../../core/src/identity/did.js';
import { generateSpaceKey } from '../../core/src/privacy/space-encryption.js';
import { deriveReadKey } from '../../core/src/space/space-access.js';

const provider = createP256Provider();

async function identity() {
  const pair = await provider.generateKeyPair();
  return {
    did: publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC),
    privateKey: pair.privateKey,
  };
}

describe('a hello, as the node reads it', () => {
  test('a node behind on the space key admits a reader who proves the older key too', async () => {
    const [node, reader] = [await identity(), await identity()];
    const [older, newer] = [
      await deriveReadKey(await generateSpaceKey(), provider),
      await deriveReadKey(await generateSpaceKey(), provider),
    ];
    // The reader has moved on to the newer key; the node knows only the older one.
    const client = createClientAuth(
      'space-1',
      { did: reader.did, key: reader.privateKey },
      { key: async () => newer, current: () => newer.did, earlier: async () => [older] },
      provider,
    );
    const server = createServerAuth('space-1', older.did, node.privateKey, provider);
    const proof = await client.hello(reader.did, node.did, 'nonce');
    assert.ok(proof.earlier?.length, 'the reader proves its older key');

    const frame = Buffer.from(JSON.stringify({ type: 'hello', did: reader.did, nonce: 'n', ...proof }));
    const hello = parseHello(frame, false);
    assert.ok(hello);
    assert.equal(await server.checkHello(hello.did, node.did, 'nonce', hello.proof), true);
  });
});
