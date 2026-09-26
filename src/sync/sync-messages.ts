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

export const SYNC_PROTOCOL_VERSION = 4;

type V = { readonly v: typeof SYNC_PROTOCOL_VERSION };

export type SyncMessage = V &
  (
    /**
     * "Here is what I hold, and a fingerprint of each collection I keep."
     * `holds` is `all`, or the collections held besides the space's own
     * (`sys.*`), which every node holds. Two peers reconcile only what both
     * hold. Equal fingerprints mean the same versions. `reply` marks the
     * answer to one, so two peers don't answer each other forever.
     */
    | {
        readonly type: 'hello';
        readonly holds?: 'all' | ReadonlyArray<string>;
        readonly sums: Readonly<Record<string, string>>;
        readonly reply?: boolean;
      }
    /**
     * One round of reconciling one collection: a Negentropy message, base64url.
     * `id` names the session; the answer comes back as `reconciled`.
     */
    | { readonly type: 'reconcile'; readonly id: number; readonly collection: string; readonly message: string }
    /** The answer to a round; `held: false` when the collection isn't held here, which ends the session */
    | { readonly type: 'reconciled'; readonly id: number; readonly message: string; readonly held?: false }
    /** "Send me these versions." `id` is echoed in the reply. */
    | { readonly type: 'want'; readonly id: number; readonly ids: ReadonlyArray<string> }
    /**
     * Versions: the answer to a `want` (with its `id`), or versions the sender
     * found the other side lacks while reconciling (without one).
     */
    | { readonly type: 'versions'; readonly id?: number; readonly versions: ReadonlyArray<Expression> }
    /** A record written just now, pushed without waiting for the next round. */
    | { readonly type: 'push-update'; readonly expression: Expression }
    /**
     * "I have these now": versions the sender took in from the receiver, or
     * already had. A node holding only part of a space lets go of its own
     * writes once enough keepers have said so.
     */
    | { readonly type: 'stored'; readonly ids: ReadonlyArray<string> }
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
