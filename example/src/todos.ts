/**
 * The one collection this app writes, and the shape it expects.
 *
 * The node checks it on write and on arrival. Anything else in a space — a
 * collection another app or an agent added — is still kept and synced; this
 * app just does not draw it.
 */
import type { CollectionDef, StandardSchemaV1 } from '@p2p-web/protocol';

export const COLLECTION = 'app.p2p-todo.item';

export interface Todo {
  readonly text: string;
  readonly completed: boolean;
  readonly order: number;
}

const todoSchema: StandardSchemaV1<Todo> = {
  '~standard': {
    version: 1,
    vendor: 'p2p-todo-example',
    validate(value: unknown) {
      if (typeof value !== 'object' || value === null) {
        return { issues: [{ message: 'Expected an object' }] };
      }
      const v = value as Record<string, unknown>;
      if (typeof v.text !== 'string' || v.text.length === 0) {
        return { issues: [{ message: 'text must be a non-empty string' }] };
      }
      if (typeof v.completed !== 'boolean') {
        return { issues: [{ message: 'completed must be a boolean' }] };
      }
      if (typeof v.order !== 'number') {
        return { issues: [{ message: 'order must be a number' }] };
      }
      return { value: value as Todo };
    },
  },
};

export const TODO_COLLECTION: CollectionDef = { name: COLLECTION, schema: todoSchema as StandardSchemaV1 };
