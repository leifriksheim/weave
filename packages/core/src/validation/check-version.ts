import type { Expression } from '../types.js';
import { didToPublicKey } from '../identity/did.js';
import { checkVersionShape } from '../records/version.js';
import { createCryptoGate, type GateResult } from './crypto-gate.js';
import { createCapabilityGate, type CapabilityGateConfig } from './capability-gate.js';

/**
 * The checks a version passes before anyone asks whether it stands in a space:
 * its shape alone, its signature, then the note behind its key. Body shape is
 * not among them: whether a body fits can depend on which definition a node
 * has, and refusing on it would leave nodes that disagree forever.
 */
export function createVersionCheck(config: CapabilityGateConfig) {
  const { provider } = config;
  const crypto = createCryptoGate(provider);
  const capability = createCapabilityGate(config);
  const resolvePublicKey = async (did: string) =>
    provider.importPublicKey(didToPublicKey(did).publicKeyBytes);

  return async (expression: Expression): Promise<GateResult> => {
    const malformed = checkVersionShape(expression);
    if (malformed) return { passed: false, gate: 'structural', reason: malformed };
    const signed = await crypto.validate(expression, resolvePublicKey);
    return signed.passed ? capability.validate(expression) : signed;
  };
}
