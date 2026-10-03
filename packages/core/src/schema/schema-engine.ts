import type { CollectionDef, StandardSchemaIssue } from '../types.js';

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues?: ReadonlyArray<StandardSchemaIssue>;
}

/** The collections a node was given in code, each with its Standard Schema validator. */
export interface SchemaEngine {
  registerCollection(def: CollectionDef): void;
  getCollection(name: string): CollectionDef | undefined;
  validate(collection: string, data: unknown): Promise<ValidationResult>;
}

export function createSchemaEngine(): SchemaEngine {
  const collections = new Map<string, CollectionDef>();
  return Object.freeze({
    registerCollection: (def: CollectionDef) => void collections.set(def.name, Object.freeze({ ...def })),
    getCollection: (name: string) => collections.get(name),
    async validate(name: string, data: unknown): Promise<ValidationResult> {
      const def = collections.get(name);
      if (!def) return { valid: false, issues: [{ message: `Collection not found: ${name}` }] };
      const result = await def.schema['~standard'].validate(data);
      return result.issues ? { valid: false, issues: [...result.issues] } : { valid: true };
    },
  });
}
