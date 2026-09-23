import type { Expression, UnsignedExpression } from '../types.js';
import { utf8Encode } from '../utils/encoding.js';
import { cidFromBytes } from '../utils/hash.js';

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
}

/**
 * Deterministically serializes an object into a JSON string with sorted keys.
 * Recursively processes nested objects.
 * 
 * @param obj The object to canonicalize
 * @returns Deterministic JSON string representation
 */
export function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj) ?? 'null';
  }
  
  if (Array.isArray(obj)) {
    return `[${obj.map(item => canonicalize(item)).join(',')}]`;
  }
  
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(key => {
    const value = (obj as Record<string, unknown>)[key];
    // Remove undefined values to match standard JSON.stringify behavior
    if (value === undefined) return undefined;
    return `${JSON.stringify(key)}:${canonicalize(value)}`;
  }).filter((pair): pair is string => pair !== undefined);
  
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
  });
}

/**
 * Computes the CID for an unsigned expression by hashing its canonical serialization.
 * @param expr The unsigned expression
 * @returns Promise resolving to the CID string
 */
export async function getExpressionId(expr: UnsignedExpression): Promise<string> {
  const json = canonicalize(expr);
  const bytes = utf8Encode(json);
  return await cidFromBytes(bytes);
}

/**
 * Serializes an Expression to canonical JSON bytes.
 * @param expr The expression to serialize
 * @returns Uint8Array containing canonical JSON bytes
 */
export function serializeExpression(expr: Expression): Uint8Array {
  const json = canonicalize(expr);
  return utf8Encode(json);
}

/**
 * Parses an Expression from canonical JSON bytes.
 * Note: Does not verify signature or ID.
 * @param bytes The bytes to deserialize
 * @returns Parsed Expression
 */
export function deserializeExpression(bytes: Uint8Array): Expression {
  const decoder = new TextDecoder('utf-8');
  const json = decoder.decode(bytes);
  return Object.freeze(JSON.parse(json) as Expression);
}
