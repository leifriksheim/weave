/**
 * @module sync-messages
 * What peers say to each other to reconcile a space.
 *
 * Messages are plain objects: they travel inside the network's own envelope,
 * which is encoded once, rather than being encoded here and again there.
 *
 * Every message carries `v`. A peer drops a message whose version it does not
 * speak rather than half-processing it: two versions that cannot reconcile
 * should fail loudly, not leave a quiet partial sync.
 */
import type { Expression } from '../types.js';

export const SYNC_PROTOCOL_VERSION = 3;

type V = { readonly v: typeof SYNC_PROTOCOL_VERSION };

export type SyncMessage = V &
  (
    /** "My tree's root is this." Equal roots mean identical data. */
    | { readonly type: 'sync-request'; readonly rootCid: string | null }
    /** The answer: my root, and whether it differs from yours. */
    | { readonly type: 'sync-response'; readonly rootCid: string | null; readonly hasChanges: boolean }
    /**
     * "Send me these tree nodes." `id` is echoed in the reply: requests are
     * served concurrently, so replies can arrive in any order.
     */
    | { readonly type: 'node-request'; readonly id: number; readonly cids: ReadonlyArray<string> }
    /**
     * Tree nodes, as objects. Unknown CIDs are left out, never an error. The
     * receiver checks each against its CID by serializing it the one canonical
     * way (`anti-entropy.ts`).
     */
    | { readonly type: 'node-response'; readonly id: number; readonly nodes: ReadonlyArray<{ readonly cid: string; readonly node: unknown }> }
    /** "Send me these records." */
    | { readonly type: 'diff-request'; readonly id: number; readonly missingIds: ReadonlyArray<string> }
    | { readonly type: 'diff-response'; readonly id: number; readonly expressions: ReadonlyArray<Expression> }
    /** A record written just now, pushed without waiting for the next round. */
    | { readonly type: 'push-update'; readonly expression: Expression; readonly newRootCid: string }
  );

/** A message before the version is stamped on — what callers construct. */
export type SyncMessageBody = SyncMessage extends infer M ? (M extends V ? Omit<M, 'v'> : never) : never;

/**
 * Checks that something a peer sent is a sync message this peer speaks.
 * @returns The message, or null when it is malformed or from another protocol version.
 */
export function parseSyncMessage(value: unknown): SyncMessage | null {
  const message = value as Partial<SyncMessage> | null;
  if (!message || typeof message !== 'object' || message.v !== SYNC_PROTOCOL_VERSION || typeof message.type !== 'string') return null;
  return message as SyncMessage;
}
