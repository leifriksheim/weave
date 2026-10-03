import type { SortDirection } from '@weaveprotocol/core';

export interface Sort {
  readonly field: string;
  readonly direction: SortDirection;
}

export const NEWEST_FIRST: Sort = { field: '@createdAt', direction: 'desc' };

/** "app.todo.item" → "app.todo"; a name without a dot has no namespace */
export function namespaceOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(0, dot);
}
