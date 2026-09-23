import { Expression } from '../types.js';
import { CryptoGate, GateResult } from './crypto-gate.js';
import { StructuralGate } from './structural-gate.js';
import { StatefulGate } from './stateful-gate.js';
import { CapabilityGate } from './capability-gate.js';
import { SpaceGate } from './space-gate.js';

export interface ValidationEngineConfig {
  readonly cryptoGate: CryptoGate;
  readonly structuralGate: StructuralGate;
  readonly statefulGate: StatefulGate;
  /** Optional authorization gate — checks the author's UCAN chain */
  readonly capabilityGate?: CapabilityGate;
  /** Optional membership gate — a shared space's write key must have countersigned */
  readonly spaceGate?: SpaceGate;
  readonly resolvePublicKey: (did: string) => Promise<CryptoKey>;
  readonly getExpression: (id: string) => Promise<Expression | null>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly gates: ReadonlyArray<GateResult>;
}

export interface ValidationEngine {
  validate(expression: Expression): Promise<ValidationResult>;
}

/**
 * Creates a three-gate validation engine pipeline.
 * @param config Configuration for the validation engine.
 * @returns A ValidationEngine instance.
 */
export function createValidationEngine(config: ValidationEngineConfig): ValidationEngine {
  const { cryptoGate, structuralGate, statefulGate, capabilityGate, spaceGate, resolvePublicKey, getExpression } = config;

  return {
    async validate(expression: Expression): Promise<ValidationResult> {
      const gates: GateResult[] = [];

      // 1. Structural Gate
      const structuralRes = await structuralGate.validate(expression);
      gates.push(structuralRes);
      if (!structuralRes.passed) return { valid: false, gates };

      // 2. Crypto Gate
      const cryptoRes = await cryptoGate.validate(expression, resolvePublicKey);
      gates.push(cryptoRes);
      if (!cryptoRes.passed) return { valid: false, gates };

      // Then: was it written by someone given this space's write key?
      if (spaceGate) {
        const spaceRes = await spaceGate.validate(expression);
        gates.push(spaceRes);
        if (!spaceRes.passed) return { valid: false, gates };
      }

      // 3. Capability Gate — who signed it is settled, now: were they allowed to?
      if (capabilityGate) {
        const capabilityRes = await capabilityGate.validate(expression);
        gates.push(capabilityRes);
        if (!capabilityRes.passed) return { valid: false, gates };
      }

      // 4. Stateful Gate
      const stateContext = { getExpression };
      const statefulRes = await statefulGate.validate(expression, stateContext);
      gates.push(statefulRes);
      if (!statefulRes.passed) return { valid: false, gates };

      return { valid: true, gates };
    }
  };
}
