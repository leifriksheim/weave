import { Expression } from '../types.js';
import { GateResult } from './crypto-gate.js';
import { utf8Encode } from '../utils/encoding.js';

export interface StateContext {
  readonly getExpression: (id: string) => Promise<Expression | null>;
}

export interface StatefulGate {
  registerRule(collection: string, wasmBytes: Uint8Array): Promise<void>;
  validate(expression: Expression, context: StateContext): Promise<GateResult>;
}

/**
 * Creates a WebAssembly-based stateful validation gate.
 * @returns A StatefulGate instance.
 */
export function createStatefulGate(): StatefulGate {
  const rules = new Map<string, WebAssembly.Instance>();

  return {
    async registerRule(collection: string, wasmBytes: Uint8Array): Promise<void> {
      const module = await WebAssembly.compile(wasmBytes as BufferSource);
      const instance = await WebAssembly.instantiate(module, {
        env: {
          abort: () => { throw new Error('Wasm aborted'); }
        }
      });
      rules.set(collection, instance);
    },

    async validate(expression: Expression, _context: StateContext): Promise<GateResult> {
      const instance = rules.get(expression.collection);
      if (!instance) {
        return { passed: true, gate: 'stateful' };
      }

      try {
        const { validate: wasmValidate, memory } = instance.exports as unknown as {
          validate: (ptr: number, len: number) => number;
          memory: WebAssembly.Memory;
          alloc?: (size: number) => number;
        };

        if (typeof wasmValidate !== 'function' || !memory) {
          return { passed: false, gate: 'stateful', reason: 'Invalid WASM exports' };
        }

        const json = JSON.stringify(expression);
        const bytes = utf8Encode(json);
        
        let ptr = 0;
        if ((instance.exports as any).alloc) {
          ptr = (instance.exports as any).alloc(bytes.length);
        }
        
        const memView = new Uint8Array(memory.buffer);
        memView.set(bytes, ptr);

        const result = wasmValidate(ptr, bytes.length);

        if (result === 0) {
          return { passed: true, gate: 'stateful' };
        } else {
          return { passed: false, gate: 'stateful', reason: `WASM validation failed with code ${result}` };
        }
      } catch (err: any) {
        return { passed: false, gate: 'stateful', reason: err.message || 'WASM execution error' };
      }
    }
  };
}
