/**
 * @module records/topics
 * Topic tags: letting a node that can't read a record still match what it's about.
 *
 * A collection names a few fields as its topics — `channel`, `mentions`. When a
 * record is written, each value of each topic field becomes a tag on the
 * outside of the record: a keyed hash of the collection, the field and the
 * value. Someone who wants "messages in #design" or "messages that mention
 * me" works out the same tag and hands it to a keeper, which compares tags
 * without learning what any of them stand for.
 *
 * The key comes from the space's key in a private space, so a keeper can't
 * guess tags by hashing likely values; it learns only which records share a
 * topic, and how often. In a public space it comes from the space id: anyone
 * can work the tags out, as anyone can read the records. The precedent is a
 * blind index (CipherSweet): equality only, never ranges or substrings.
 *
 * Tags are signed with the rest of the record. Any node that can read the body
 * works them out again and refuses a record whose tags don't match it.
 */
import { canonicalize } from '../schema/expression.js';
import { base64UrlEncode, utf8Encode } from '../utils/encoding.js';

/** Topic fields one collection may name */
export const MAX_TOPICS = 8;
/** Tags one record may carry — a list field of mentions is the usual reason for more than one per field */
export const MAX_TAGS = 64;
/** Bytes of HMAC kept per tag: 128 bits, as a truncated MAC */
const TAG_BYTES = 16;

/** A field of the body, or a dotted path into it: `channel`, `address.city` */
const FIELD = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,3}$/;

/** Why a list of topic fields can't be a collection's, or null */
export function checkTopics(topics: unknown, at = 'topics'): string | null {
  if (topics === undefined) return null;
  if (!Array.isArray(topics) || topics.length > MAX_TOPICS) return `${at} must be a list of at most ${MAX_TOPICS} field names`;
  for (const field of topics) {
    if (typeof field !== 'string' || !FIELD.test(field)) return `${at}: "${String(field)}" is not a field name, like "channel" or "author.name"`;
  }
  return new Set(topics).size === topics.length ? null : `${at} names a field twice`;
}

/** The values of a topic field in a body: a text, number or yes/no, or each of those in a list. Anything else has none. */
export function topicValues(body: unknown, field: string): Array<string | number | boolean> {
  let value: unknown = body;
  for (const part of field.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    value = (value as Record<string, unknown>)[part];
  }
  const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  if (Array.isArray(value)) return value.filter(scalar);
  return scalar(value) ? [value] : [];
}

/** What a space's tags are keyed with: from its key in a private space, from its id in a public one */
export async function topicKey(material: { readonly spaceKey: CryptoKey } | { readonly spaceId: string }): Promise<CryptoKey> {
  const secret =
    'spaceKey' in material
      ? new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', material.spaceKey))
      : utf8Encode(`weave/public-topics/v1|${material.spaceId}`);
  const base = await globalThis.crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8Encode('weave/topic-tags/v1') as BufferSource },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** The tag for one value of one topic field of a collection */
export async function topicTag(key: CryptoKey, collection: string, field: string, value: string | number | boolean): Promise<string> {
  // Collection and field go in too, so one value in two places is two tags.
  const input = utf8Encode(`${collection}\u0000${field}\u0000${canonicalize(value)}`);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, input as BufferSource));
  return base64UrlEncode(mac.subarray(0, TAG_BYTES));
}

/** Every tag a body carries under a collection's topics: sorted, each once, at most `MAX_TAGS` */
export async function tagsFor(key: CryptoKey, collection: string, topics: ReadonlyArray<string>, body: unknown): Promise<string[]> {
  const tags = new Set<string>();
  for (const field of topics) {
    for (const value of topicValues(body, field)) tags.add(await topicTag(key, collection, field, value));
  }
  return [...tags].sort().slice(0, MAX_TAGS);
}

/** Whether two tag lists say the same, whatever their order */
export function sameTags(a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string>): boolean {
  const left = [...new Set(a ?? [])].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((tag, i) => tag === right[i]);
}
