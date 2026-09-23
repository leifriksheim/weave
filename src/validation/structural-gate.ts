import { Expression } from '../types.js';
import { SchemaEngine } from '../schema/schema-engine.js';
import { GateResult } from './crypto-gate.js';

export interface StructuralGate {
  validate(expression: Expression): Promise<GateResult>;
}

/**
 * Creates a structural validation gate.
 * @param schemaEngine The engine containing registered schemas.
 * @returns A StructuralGate instance.
 */
/**
 * Recognizes a body that has been encrypted for a private space.
 * @param body The expression body
 * @returns Whether it is an encryption envelope rather than plain content
 */
function isEncryptedBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const envelope = body as Record<string, unknown>;
  return (
    typeof envelope.ciphertext === 'string' &&
    typeof envelope.iv === 'string' &&
    typeof envelope.keyId === 'string'
  );
}

export interface StructuralGateOptions {
  /**
   * Let through collections no schema is registered for. A node that stores
   * data for apps it has never heard of — an always-on node, or a space an
   * agent is extending — cannot know every shape, and rejecting what it does not
   * recognise would make it refuse to keep other people's data. Signatures and
   * capabilities are still checked. Default false.
   */
  readonly allowUnknownCollections?: boolean;
}

export function createStructuralGate(schemaEngine: SchemaEngine, options: StructuralGateOptions = {}): StructuralGate {
  return {
    async validate(expression: Expression): Promise<GateResult> {
      try {
        // Private-space bodies are encrypted before signing, so their shape can
        // only be checked by a member after decryption. Non-members still relay
        // them, and their signatures and capabilities are checked as usual.
        if (isEncryptedBody(expression.body)) {
          return { passed: true, gate: 'structural' };
        }

        if (options.allowUnknownCollections && !schemaEngine.getCollection(expression.collection)) {
          return { passed: true, gate: 'structural' };
        }

        const result = await schemaEngine.validate(expression.collection, expression.body);
        if (result.issues) {
          return { 
            passed: false, 
            gate: 'structural', 
            reason: `Validation failed: ${result.issues.map(i => i.message).join(', ')}` 
          };
        }
        return { passed: true, gate: 'structural' };
      } catch (err: any) {
        return { passed: false, gate: 'structural', reason: err.message || 'Validation error' };
      }
    }
  };
}
