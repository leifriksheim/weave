/**
 * What a record forged by hand needs to be judged as a member's: the latest
 * access changes the member's node holds, named as `seen` — so the forgery
 * gets past "is this a member?" and reaches the rule a test means to test.
 *
 * Reading them opens the space, so it is closed again: a test forging a
 * record writes it into a closed store, then opens the space to send it.
 */
import type { P2PNode } from '../../src/node/types.js';

export async function seenBy(node: P2PNode, spaceId: string): Promise<ReadonlyArray<string>> {
  const { heads } = await node.spaces.access(spaceId);
  await node.spaces.close(spaceId);
  return heads;
}
