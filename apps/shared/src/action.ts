import { useCallback, useEffect, useRef, useState } from 'react';

/** What went wrong, as a sentence to show */
export const message = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

/** Runs one piece of work at a time, keeping whether it is busy and what went wrong */
export function useAction(): {
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  clear: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError, clear: useCallback(() => setError(null), []) };
}

/** Copies text, and says so for a moment afterwards */
export function useCopy(ms = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    (text: string) => {
      void globalThis.navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), ms);
      });
    },
    [ms],
  );
  return { copied, copy };
}
