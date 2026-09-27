import type { CollectionDef, StandardSchemaIssue } from '../types.js';

/**
 * Result of validating an object against a schema.
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly issues?: ReadonlyArray<StandardSchemaIssue>;
}

/**
 * Registry and validation engine for collection schemas.
 */
export interface SchemaEngine {
  /**
   * Registers a collection with its Standard Schema validator.
   * @param def The collection definition to register
   */
  registerCollection(def: CollectionDef): void;
  
  /**
   * Gets a registered collection by name.
   * @param name The name of the collection
   * @returns The collection definition or undefined if not found
   */
  getCollection(name: string): CollectionDef | undefined;
  
  /**
   * Lists all registered collection names.
   * @returns Array of registered collection names
   */
  listCollections(): ReadonlyArray<string>;
  
  /**
   * Validates data against the schema of the specified collection.
   * @param collection The name of the collection
   * @param data The data to validate
   * @returns Promise resolving to a ValidationResult
   */
  validate(collection: string, data: unknown): Promise<ValidationResult>;
}

/**
 * Creates a new SchemaEngine instance.
 * @returns A new SchemaEngine
 */
export function createSchemaEngine(): SchemaEngine {
  const collections = new Map<string, CollectionDef>();

  return Object.freeze({
    registerCollection(def: CollectionDef): void {
      collections.set(def.name, Object.freeze({ ...def }));
    },
    
    getCollection(name: string): CollectionDef | undefined {
      return collections.get(name);
    },
    
    listCollections(): ReadonlyArray<string> {
      return Object.freeze(Array.from(collections.keys()));
    },
    
    async validate(collectionName: string, data: unknown): Promise<ValidationResult> {
      const def = collections.get(collectionName);
      if (!def) {
        return Object.freeze({
          valid: false,
          issues: Object.freeze([{ message: `Collection not found: ${collectionName}` }]),
        });
      }
      
      const result = await def.schema['~standard'].validate(data);
      if (result.issues) {
        return Object.freeze({
          valid: false,
          issues: Object.freeze([...result.issues]),
        });
      }
      
      return Object.freeze({ valid: true });
    }
  });
}
