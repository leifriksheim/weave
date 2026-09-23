/**
 * Pairing tests — the parts both devices have to agree on without talking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  pairingRoomId,
  derivePairingKey,
  encodePairingTicket,
  decodePairingTicket,
  sealPairingPayload,
  openPairingPayload,
} from '../src/identity/pairing.js';
import { generateSeed, seedToRecoveryCode, recoveryCodeToSeed } from '../src/identity/recovery-code.js';
import { utf8Encode, utf8Decode } from '../src/utils/encoding.js';
import { isProtocolError } from '../src/utils/errors.js';

describe('the meeting room', () => {
  test('both devices derive the same room from the same seed', async () => {
    const seed = generateSeed();

    // The phone only ever receives the code, so this is the round trip that
    // actually happens: seed → code → camera → code → seed.
    const viaCode = recoveryCodeToSeed(seedToRecoveryCode(seed));

    assert.equal(await pairingRoomId(viaCode), await pairingRoomId(seed));
  });

  test('a different account gets a different room', async () => {
    assert.notEqual(await pairingRoomId(generateSeed()), await pairingRoomId(generateSeed()));
  });

  test('the room is not derivable from anything public', async () => {
    // Named after the seed rather than the DID on purpose: a DID appears in
    // every expression the account has signed, so a room named after one could
    // be found by anyone who had ever seen its data.
    const seed = generateSeed();
    const room = await pairingRoomId(seed);
    assert.ok(!room.includes(seedToRecoveryCode(seed).replace(/-/g, '').toLowerCase()));
  });
});

describe('the handover', () => {
  test('round-trips through the pairing key', async () => {
    const seed = generateSeed();
    const payload = utf8Encode(JSON.stringify({ spaces: ['invite-one', 'invite-two'] }));

    const sealed = await sealPairingPayload(payload, await derivePairingKey(seed));
    const opened = await openPairingPayload(sealed, await derivePairingKey(seed));

    assert.deepEqual(JSON.parse(utf8Decode(opened)), { spaces: ['invite-one', 'invite-two'] });
  });

  test('someone else in the room learns nothing', async () => {
    const sealed = await sealPairingPayload(
      utf8Encode('the lists'),
      await derivePairingKey(generateSeed()),
    );

    const strangersKey = await derivePairingKey(generateSeed());
    await assert.rejects(
      () => openPairingPayload(sealed, strangersKey),
      (error: unknown) => isProtocolError(error, 'PAIRING_TICKET_UNREADABLE'),
    );
  });

  test('a truncated payload is refused rather than misread', async () => {
    const key = await derivePairingKey(generateSeed());
    await assert.rejects(
      () => openPairingPayload(new Uint8Array(4), key),
      (error: unknown) => isProtocolError(error, 'PAIRING_TICKET_UNREADABLE'),
    );
  });
});

describe('the ticket in the QR code', () => {
  test('round-trips, and stays small enough for a camera', async () => {
    const ticket = {
      v: 1,
      code: seedToRecoveryCode(generateSeed()),
      relay: 'ws://192.168.1.42:8787',
    } as const;

    const encoded = encodePairingTicket(ticket);
    assert.deepEqual(decodePairingTicket(encoded), ticket);

    // A QR holding a whole URL has to stay readable across a desk. The list of
    // lists is deliberately not in here — it comes over the connection instead.
    const url = `https://todos.example/#pair=${encoded}`;
    assert.ok(url.length < 200, `pairing URL was ${url.length} characters`);
  });

  test('a mangled ticket is rejected with something a UI can say', () => {
    for (const bad of ['', 'not-base64!!', encodePairingTicket({ v: 2 } as never)]) {
      assert.throws(
        () => decodePairingTicket(bad),
        (error: unknown) => isProtocolError(error, 'PAIRING_TICKET_UNREADABLE'),
      );
    }
  });
});
