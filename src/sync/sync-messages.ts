import { Expression } from '../types.js';
import { utf8Encode, utf8Decode } from '../utils/encoding.js';

export type SyncMessage =
  | { readonly type: 'sync-request'; readonly rootCid: string | null }
  | { readonly type: 'sync-response'; readonly rootCid: string | null; readonly hasChanges: boolean; readonly remoteKeys?: ReadonlyArray<string> }
  | { readonly type: 'diff-request'; readonly missingIds: ReadonlyArray<string> }
  | { readonly type: 'diff-response'; readonly expressions: ReadonlyArray<Expression> }
  | { readonly type: 'push-update'; readonly expression: Expression; readonly newRootCid: string };

/**
 * Encodes a sync message into a Uint8Array.
 * @param msg The message to encode.
 * @returns The JSON encoded message as bytes.
 */
export function encodeSyncMessage(msg: SyncMessage): Uint8Array {
  const json = JSON.stringify(msg);
  return utf8Encode(json);
}

/**
 * Decodes a sync message from a Uint8Array.
 * @param data The byte array to decode.
 * @returns The parsed SyncMessage object.
 */
export function decodeSyncMessage(data: Uint8Array): SyncMessage {
  const json = utf8Decode(data);
  return JSON.parse(json) as SyncMessage;
}
