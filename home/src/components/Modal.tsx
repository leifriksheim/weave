import { useEffect, useRef, type ReactNode } from 'react';
import { styles } from '../styles';

/**
 * A dialog over the page.
 *
 * Used where a choice has enough parts that inlining it would crowd the thing
 * it is about — creating a list needs a name and two decisions, which is more
 * than belongs permanently under a list of lists.
 *
 * Closes on Escape and on a click outside, moves focus in on open and back out
 * on close, and holds focus inside while open, so it behaves the way a dialog
 * is expected to whether or not someone is using a mouse.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = globalThis.document.activeElement;

    // The first field, or the dialog itself when it has none.
    const focusable = card.current?.querySelectorAll<HTMLElement>(
      'input, button, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable?.[0] ?? card.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      // Without this, tabbing walks out of the dialog and into the page behind,
      // which is still there and still clickable-looking.
      if (event.key !== 'Tab' || !focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = globalThis.document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    globalThis.document.addEventListener('keydown', onKey);
    return () => {
      globalThis.document.removeEventListener('keydown', onKey);
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      style={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal
        aria-label={title}
        tabIndex={-1}
        style={styles.modal}
      >
        <h2 style={styles.modalTitle}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** One question with two answers, which is every choice a list has. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p style={styles.fieldLabel}>{label}</p>
      <div style={styles.segmented} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={option.value === value}
            style={option.value === value ? styles.segmentActive : styles.segment}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
