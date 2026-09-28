import type { Envelope, Expression, Link, UnsignedExpression } from '../types.js';
import { utf8Encode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';
import { isRecord } from '../utils/guards.js';
import { newRecordKey } from '../records/version.js';

/**
 * Parameters for creating a new expression.
 */
export interface CreateExpressionParams<T> {
  readonly author: string;
  readonly collection: string;
  readonly body: T;
  readonly createdAt?: string;
  /** Space this expression belongs to */
  readonly space?: string;
  /** Encoded UCAN authorizing this author, when signing with a delegated key */
  readonly proof?: string;
  /** The record this is a version of. Default: a new record, with a fresh key, at seq 0. */
  readonly version?: {
    readonly key: string;
    readonly seq: number;
    readonly prev?: string;
    readonly genesis?: string;
  };
  readonly retain?: boolean;
  readonly deleted?: boolean;
  /** The latest access changes the writer knew of */
  readonly seen?: ReadonlyArray<string>;
  /** Links in the clear — public spaces only; a private space seals them in the body */
  readonly links?: ReadonlyArray<Link>;
  /** Topic tags, worked out from the body (`records/topics.ts`) */
  readonly tags?: ReadonlyArray<string>;
}

/**
 * Deterministically serializes an object into a JSON string with sorted keys.
 * Recursively processes nested objects.
 *
 * @param obj The object to canonicalize
 * @returns Deterministic JSON string representation
 */
export function canonicalize(obj: unknown): string {
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (!isRecord(obj)) {
    return JSON.stringify(obj) ?? 'null';
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys
    .map((key) => {
      const value = obj[key];
      // Remove undefined values to match standard JSON.stringify behavior
      if (value === undefined) return undefined;
      return `${JSON.stringify(key)}:${canonicalize(value)}`;
    })
    .filter((pair): pair is string => pair !== undefined);

  return `{${pairs.join(',')}}`;
}

/**
 * Creates an unsigned expression with a generated timestamp (if not provided).
 * @param params Parameters to create the expression
 * @returns Unsigned expression object
 */
export function createExpression<T>(params: CreateExpressionParams<T>): UnsignedExpression<T> {
  return Object.freeze({
    author: params.author,
    collection: params.collection,
    body: params.body,
    createdAt: params.createdAt ?? new Date().toISOString(),
    ...(params.space ? { space: params.space } : {}),
    ...(params.proof ? { proof: params.proof } : {}),
    key: params.version?.key ?? newRecordKey(),
    seq: params.version?.seq ?? 0,
    ...(params.version?.prev ? { prev: params.version.prev } : {}),
    ...(params.version?.genesis ? { genesis: params.version.genesis } : {}),
    ...(params.retain ? { retain: true as const } : {}),
    ...(params.seen ? { seen: params.seen } : {}),
    ...(params.deleted ? { deleted: true as const } : {}),
    ...(params.links?.length ? { links: params.links } : {}),
    ...(params.tags?.length ? { tags: params.tags } : {}),
  });
}

/**
 * The content id of a body: what a version signs in its place, so that its
 * envelope checks without it.
 */
export function bodyHashOf(body: unknown): Promise<string> {
  return cidFromBytes(utf8Encode(canonicalize(body)));
}

/**
 * What the author signs and the id hashes: an unsigned version with its body
 * swapped for the body's hash. A delete has no body, so no hash.
 */
export async function envelopeOf(expression: UnsignedExpression): Promise<Envelope> {
  const { body, ...envelope } = expression;
  return expression.deleted ? envelope : { ...envelope, bodyHash: await bodyHashOf(body) };
}

/**
 * What the author signed and the id hashes: everything but the id, the
 * signature and the body. Both checks — id and signature — must drop exactly
 * these, or a field added later is hashed on one side and not the other.
 * @param expression A signed expression, whole or a stub
 * @returns Its envelope
 */
export function signedPart(expression: Expression): Envelope {
  const { id: _id, signature: _signature, body: _body, ...envelope } = expression;
  return envelope;
}

/** A version kept without its body: superseded, its content forgotten. A delete is never one. */
export const isStub = (expression: Expression): boolean => !expression.deleted && !('body' in expression);

/** A version's stub: what is kept of it once it is superseded. */
export function stubOf(expression: Expression): Expression {
  if (expression.deleted || !('body' in expression)) return expression;
  const { body: _body, ...stub } = expression;
  return Object.freeze(stub);
}

/**
 * Why a version's body is not the one it signed, or null when it is — or
 * when it is a stub, with no body to check.
 */
export async function bodyProblem(expression: Expression): Promise<string | null> {
  if (expression.deleted)
    return expression.body === undefined || expression.body === null ? null : 'A delete carries no body';
  if (!('body' in expression)) return null;
  if (typeof expression.bodyHash !== 'string') return 'It has no body hash';
  return (await bodyHashOf(expression.body)) === expression.bodyHash
    ? null
    : 'Its body is not the one it signed';
}

/**
 * Computes the id of an envelope by hashing its canonical serialization.
 * @param envelope What is signed: a version without its id, signature and body
 * @returns Promise resolving to the CID string
 */
export async function getExpressionId(envelope: Envelope): Promise<string> {
  return cidFromBytes(utf8Encode(canonicalize(envelope)));
}
