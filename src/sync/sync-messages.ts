/**
 * @module sync-messages
 * What peers say to each other to reconcile a space.
 *
 * Every message carries `v`. A peer drops a message whose version it does not
 * speak rather than half-processing it: two versions that cannot reconcile
 * should fail loudly, not leave a quiet partial sync.
 */
import type { Expression } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';

export const SYNC_PROTOCOL_VERSION = 2;

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
    /** Tree nodes, as stored. Unknown CIDs are left out, never an error. */
    | { readonly type: 'node-response'; readonly id: number; readonly nodes: ReadonlyArray<{ readonly cid: string; readonly bytes: string }> }
    /** "Send me these records." */
    | { readonly type: 'diff-request'; readonly id: number; readonly missingIds: ReadonlyArray<string> }
    | { readonly type: 'diff-response'; readonly id: number; readonly expressions: ReadonlyArray<Expression> }
    /** A record written just now, pushed without waiting for the next round. */
    | { readonly type: 'push-update'; readonly expression: Expression; readonly newRootCid: string }
  );

/** A message before the version is stamped on — what callers construct. */
export type SyncMessageBody = SyncMessage extends infer M ? (M extends V ? Omit<M, 'v'> : never) : never;

/**
 * Encodes a sync message, stamping the protocol version.
 * @param msg The message to encode.
 * @returns The JSON encoded message as bytes.
 */
export function encodeSyncMessage(msg: SyncMessageBody): Uint8Array {
  return utf8Encode(JSON.stringify({ v: SYNC_PROTOCOL_VERSION, ...msg }));
}

/**
 * Decodes a sync message.
 * @param data The byte array to decode.
 * @returns The message, or null when it is malformed or from another protocol version.
 */
export function decodeSyncMessage(data: Uint8Array): SyncMessage | null {
  try {
    const parsed = JSON.parse(utf8Decode(data)) as Partial<SyncMessage> | null;
    if (!parsed || parsed.v !== SYNC_PROTOCOL_VERSION || typeof parsed.type !== 'string') return null;
    return parsed as SyncMessage;
  } catch {
    return null;
  }
}
