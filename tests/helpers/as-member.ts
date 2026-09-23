/**
 * Countersigns a hand-made record with the space's write key, as held by the
 * given node's registry — so a test forging a record *as a member* gets past
 * the space gate and reaches the rule it means to test.
 */
import type { CryptoProvider, Expression } from '../../src/types.js';
import type { StoreFactory } from '../../src/node/stores.js';
import { createSpaceManager } from '../../src/space/space-manager.js';
import { countersign, deriveWriteKey } from '../../src/space/space-access.js';

export async function asMember(stores: StoreFactory, spaceId: string, expression: Expression, provider: CryptoProvider): Promise<Expression> {
  const record = await createSpaceManager(await stores('registry'), provider).get(spaceId);
  if (!record?.writeSecret) return expression;
  const writeKey = await deriveWriteKey(record.writeSecret, provider);
  return Object.freeze({ ...expression, spaceSignature: await countersign(expression.id, writeKey, provider) });
}
