import type { CryptoProvider, Expression } from '../types.js';
import type { GateResult } from './crypto-gate.js';
import { verifyCountersignature } from '../space/space-access.js';

export interface SpaceGateConfig {
  readonly provider: CryptoProvider;
  /**
   * The space's public write key, from its genesis — a shared space's. Null
   * for a personal space, where the capability gate's owner check is the rule.
   */
  readonly writeKey: string | null;
}

export interface SpaceGate {
  validate(expression: Expression): Promise<GateResult>;
}

/**
 * Creates a gate that checks a record in a shared space was written by
 * someone given the space's write key: it must carry that key's signature
 * over its id.
 *
 * Judged from the record and the space alone, which every peer holds the
 * same — so refusing on arrival never leaves two peers disagreeing, and a
 * node with no secret at all reaches the same verdict as a member.
 *
 * @param config The space's write key
 * @returns A SpaceGate instance
 */
export function createSpaceGate(config: SpaceGateConfig): SpaceGate {
  return {
    async validate(expression: Expression): Promise<GateResult> {
      if (config.writeKey === null) return { passed: true, gate: 'space' };
      if (typeof expression.spaceSignature !== 'string') {
        return { passed: false, gate: 'space', reason: 'Written without this space\'s write key' };
      }
      return (await verifyCountersignature(expression, config.writeKey, config.provider))
        ? { passed: true, gate: 'space' }
        : { passed: false, gate: 'space', reason: 'Its space signature is not by this space\'s write key' };
    },
  };
}
