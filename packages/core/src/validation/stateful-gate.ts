import { Expression } from '../types.js';
import { GateResult } from './crypto-gate.js';
import { utf8Encode } from '../utils/encoding.js';
import { messageOf } from '../utils/errors.js';
import { bufferSource } from '../utils/guards.js';

export interface StateContext {
  readonly getExpression: (id: string) => Promise<Expression | null>;
}

export interface StatefulGate {
  registerRule(collection: string, wasmBytes: Uint8Array): Promise<void>;
  validate(expression: Expression, context: StateContext): Promise<GateResult>;
}

/** A rule's exports are functions over i32s: pointers, lengths and result codes */
function isWasmFunction(value: unknown): value is (...args: number[]) => number {
  return typeof value === 'function';
}

/**
 * Creates a WebAssembly-based stateful validation gate.
 * @returns A StatefulGate instance.
 */
export function createStatefulGate(): StatefulGate {
  const rules = new Map<string, WebAssembly.Instance>();

  return {
    async registerRule(collection: string, wasmBytes: Uint8Array): Promise<void> {
      const module = await WebAssembly.compile(bufferSource(wasmBytes));
      const instance = await WebAssembly.instantiate(module, {
        env: {
          abort: () => {
            throw new Error('Wasm aborted');
          },
        },
      });
      rules.set(collection, instance);
    },

    async validate(expression: Expression, _context: StateContext): Promise<GateResult> {
      const instance = rules.get(expression.collection);
      if (!instance) {
        return { passed: true, gate: 'stateful' };
      }

      try {
        const { validate: wasmValidate, memory, alloc } = instance.exports;

        if (!isWasmFunction(wasmValidate) || !(memory instanceof WebAssembly.Memory)) {
          return { passed: false, gate: 'stateful', reason: 'Invalid WASM exports' };
        }

        const json = JSON.stringify(expression);
        const bytes = utf8Encode(json);

        const ptr = isWasmFunction(alloc) ? alloc(bytes.length) : 0;

        const memView = new Uint8Array(memory.buffer);
        memView.set(bytes, ptr);

        const result = wasmValidate(ptr, bytes.length);

        if (result === 0) {
          return { passed: true, gate: 'stateful' };
        } else {
          return { passed: false, gate: 'stateful', reason: `WASM validation failed with code ${result}` };
        }
      } catch (err) {
        return { passed: false, gate: 'stateful', reason: messageOf(err, 'WASM execution error') };
      }
    },
  };
}
