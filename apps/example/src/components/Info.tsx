import { useEffect, useRef, useState, type ReactNode } from 'react';
import { styles } from '../styles';

/**
 * An explanation, folded away until asked for.
 *
 * This app has a lot to explain — where a key lives, what a folder buys, why a
 * passkey cannot cross domains — and explaining all of it on screen at once
 * leaves nothing to look at but prose. So the screen says the short true thing
 * and this holds the rest.
 *
 * What stays on screen: anything needed to make the choice in front of you, and
 * anything that has gone wrong. What goes in here: why, and what it means
 * later.
 */
export function Info({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    globalThis.document.addEventListener('mousedown', dismiss);
    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('mousedown', dismiss);
      globalThis.document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={root} style={{ position: 'relative', display: 'inline' }}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-label={open ? `Hide: ${label}` : label}
        data-variant="quiet"
        style={styles.infoButton}
      >
        i
      </button>
      {open && (
        <span role="note" className="popover" style={styles.popover}>
          {children}
        </span>
      )}
    </span>
  );
}
