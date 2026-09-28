import { useEffect, type RefObject } from 'react';

/**
 * Closes something that floats over the page on a click outside it or on
 * Escape. A panel that stays open after you have clicked past it feels stuck.
 */
export function useDismiss(open: boolean, root: RefObject<Element | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    globalThis.document.addEventListener('mousedown', dismiss);
    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('mousedown', dismiss);
      globalThis.document.removeEventListener('keydown', onKey);
    };
  }, [open, root, close]);
}
