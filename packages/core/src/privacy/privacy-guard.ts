import type { Expression, Space } from '../types.js';
import { 
  type SpaceKey, 
  type EncryptedExpression, 
  generateSpaceKey, 
  encryptExpression, 
  decryptExpression 
} from './space-encryption.js';
import { 
  type WrappedKey, 
  wrapSpaceKey, 
  unwrapSpaceKey 
} from './key-distribution.js';
import { base64UrlEncode } from '../utils/encoding.js';
import { sha256 } from '../utils/hash.js';

/**
 * Orchestrator for transparent encryption and decryption of expressions within spaces.
 */
export interface PrivacyGuard {
  addSpace(space: Space, spaceKey?: SpaceKey): void;
  isPrivateSpace(spaceId: string): boolean;
  encryptForSpace(spaceId: string, expression: Expression): Promise<EncryptedExpression | Expression>;
  decryptFromSpace(spaceId: string, encrypted: EncryptedExpression | Expression): Promise<Expression>;
  setSpaceKey(spaceId: string, key: SpaceKey): void;
  rotateSpaceKey(spaceId: string): Promise<SpaceKey>;
  getSpaceKey(spaceId: string): SpaceKey | undefined;
  wrapKeyForMember(spaceId: string, memberPublicKey: CryptoKey, memberDid: string): Promise<WrappedKey>;
  unwrapKeyFromMember(wrapped: WrappedKey, privateKey: CryptoKey): Promise<SpaceKey>;
}

interface SpaceEntry {
  readonly space: Space;
  spaceKey?: SpaceKey;
}

/**
 * Creates a new PrivacyGuard orchestrator.
 *
 * @returns {PrivacyGuard} A new PrivacyGuard instance.
 */
export function createPrivacyGuard(): PrivacyGuard {
  const spaces = new Map<string, SpaceEntry>();

  return {
    addSpace(space: Space, spaceKey?: SpaceKey): void {
      spaces.set(space.id, { space, spaceKey });
    },

    isPrivateSpace(spaceId: string): boolean {
      const entry = spaces.get(spaceId);
      return entry !== undefined && entry.space.encryptionKeyId !== undefined;
    },

    async encryptForSpace(spaceId: string, expression: Expression): Promise<EncryptedExpression | Expression> {
      const entry = spaces.get(spaceId);
      if (!entry) throw new Error(`Space ${spaceId} not found`);
      
      if (!this.isPrivateSpace(spaceId)) {
        return expression;
      }

      if (!entry.spaceKey) {
        throw new Error(`Space key not available for space ${spaceId}`);
      }

      return encryptExpression(expression, entry.spaceKey);
    },

    async decryptFromSpace(spaceId: string, encrypted: EncryptedExpression | Expression): Promise<Expression> {
      const entry = spaces.get(spaceId);
      if (!entry) throw new Error(`Space ${spaceId} not found`);

      if (!this.isPrivateSpace(spaceId) || !('ciphertext' in (encrypted.body as any))) {
        return encrypted as Expression;
      }

      if (!entry.spaceKey) {
        throw new Error(`Space key not available for space ${spaceId}`);
      }

      return decryptExpression(encrypted as EncryptedExpression, entry.spaceKey);
    },

    setSpaceKey(spaceId: string, key: SpaceKey): void {
      const entry = spaces.get(spaceId);
      if (!entry) throw new Error(`Space ${spaceId} not found`);
      entry.spaceKey = key;
    },

    async rotateSpaceKey(spaceId: string): Promise<SpaceKey> {
      const entry = spaces.get(spaceId);
      if (!entry) throw new Error(`Space ${spaceId} not found`);
      
      const newKey = await generateSpaceKey();
      const version = (entry.spaceKey?.version ?? 0) + 1;
      const rotatedKey = Object.freeze({
        ...newKey,
        version
      });
      entry.spaceKey = rotatedKey;
      return rotatedKey;
    },

    getSpaceKey(spaceId: string): SpaceKey | undefined {
      return spaces.get(spaceId)?.spaceKey;
    },

    async wrapKeyForMember(spaceId: string, memberPublicKey: CryptoKey, memberDid: string): Promise<WrappedKey> {
      const spaceKey = this.getSpaceKey(spaceId);
      if (!spaceKey) {
        throw new Error(`Space key not found for space ${spaceId}`);
      }
      return wrapSpaceKey(spaceKey.key, memberPublicKey, memberDid);
    },

    async unwrapKeyFromMember(wrapped: WrappedKey, privateKey: CryptoKey): Promise<SpaceKey> {
      const unwrappedCryptoKey = await unwrapSpaceKey(wrapped, privateKey);
      
      // Derive a consistent ID based on the raw key data
      const raw = await globalThis.crypto.subtle.exportKey('raw', unwrappedCryptoKey);
      const id = base64UrlEncode(new Uint8Array(await sha256(new Uint8Array(raw))));
      
      return Object.freeze({
        id,
        key: unwrappedCryptoKey,
        createdAt: new Date().toISOString(),
        version: 1 // Defaulting to 1 as versioning would normally be distributed alongside the wrapped key
      });
    }
  };
}
