/**
 * Direct messages (`docs/direct-messages.md`): text only some members of a space
 * can read. A fresh message key seals the text once; that key is sealed to
 * each reader's member key, so one record serves every reader and every one
 * of their devices.
 */
import { openSealed, sealFor } from '../identity/contact-key.js';
import { isRecord } from '../utils/guards.js';
import { base64UrlDecode, base64UrlEncode } from '../utils/encoding.js';
import { generateSpaceKey, openWith, sealWith, spaceKeyBytes, spaceKeyFromRaw } from './space-encryption.js';

/** How many people one direct message can be for, besides whoever wrote it */
export const MAX_DIRECT_TO = 16;

/** What a direct message's body carries: who it is for, the sealed text, and a box per reader */
export interface DirectBody {
  readonly to: ReadonlyArray<string>;
  readonly data: string;
  readonly boxes: ReadonlyArray<{ readonly to: string; readonly sealed: string }>;
}

/** What is sealed inside a direct message */
export interface DirectContent {
  readonly text: string;
}

/**
 * Everyone a direct message is for, as the context names them: sorted, once
 * each, without whoever wrote it.
 */
export function directRecipients(from: string, to: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(to)].filter((did) => did !== from).sort();
}

/** What the text is bound to: the space, who wrote it, and who it is for */
export function directContext(spaceId: string, from: string, to: ReadonlyArray<string>): string {
  return `weave/direct/v1|${spaceId}|${from}|${directRecipients(from, to).join(',')}`;
}

/** What one reader's box is bound to: the message's context and that reader */
const boxContext = (context: string, reader: string) => `${context}|${reader}`;

/**
 * Seals text for some members of a space and for its writer.
 * @param memberKeys Each reader's member key (`sys.memberkey`), by account — the writer's too
 * @throws When someone it is for has no member key here yet
 */
export async function sealDirect(
  spaceId: string,
  from: string,
  to: ReadonlyArray<string>,
  content: DirectContent,
  memberKeys: ReadonlyMap<string, string>,
): Promise<DirectBody> {
  const recipients = directRecipients(from, to);
  if (recipients.length === 0) throw new Error('A direct message needs someone to send it to');
  if (recipients.length > MAX_DIRECT_TO)
    throw new Error(`A direct message can be for ${MAX_DIRECT_TO} people at most`);
  const context = directContext(spaceId, from, recipients);
  const key = await generateSpaceKey();
  const raw = base64UrlEncode(await spaceKeyBytes(key));
  const boxes = [];
  for (const reader of [...recipients, from]) {
    const publicKey = memberKeys.get(reader);
    if (!publicKey)
      throw new Error(`${reader} can't be written to here yet: they have no member key in this space`);
    boxes.push({ to: reader, sealed: await sealFor(publicKey, { key: raw }, boxContext(context, reader)) });
  }
  return { to: recipients, data: await sealWith(key, { text: content.text }, context), boxes };
}

/**
 * Opens a direct message for one of its readers.
 * @param from The root of the record's first version: who wrote it
 * @param reader The account opening it
 * @param privateKey The reader's member key in this space
 * @returns The content, or null when it isn't for this reader, or anything in it doesn't open
 */
export async function openDirect(
  spaceId: string,
  from: string,
  body: unknown,
  reader: string,
  privateKey: CryptoKey,
): Promise<DirectContent | null> {
  if (
    !isRecord(body) ||
    typeof body.data !== 'string' ||
    !Array.isArray(body.to) ||
    !Array.isArray(body.boxes)
  )
    return null;
  const to = body.to.filter((did): did is string => typeof did === 'string');
  if (to.length !== body.to.length) return null;
  if (reader !== from && !to.includes(reader)) return null;
  const box: unknown = body.boxes.find(
    (candidate: unknown) => isRecord(candidate) && candidate.to === reader,
  );
  if (!isRecord(box) || typeof box.sealed !== 'string') return null;
  const context = directContext(spaceId, from, to);
  const opened = await openSealed(privateKey, box.sealed, boxContext(context, reader));
  if (!isRecord(opened) || typeof opened.key !== 'string') return null;
  let key;
  try {
    key = await spaceKeyFromRaw(base64UrlDecode(opened.key));
  } catch {
    return null;
  }
  const content = await openWith(key, body.data, context);
  if (!isRecord(content) || typeof content.text !== 'string') return null;
  return { text: content.text };
}
