import type { CSSProperties } from 'react';
import { baseCss, hoverCss, palette, styles as shared } from '@weave/app-shared/styles';

export { palette };

/**
 * The rules inline styles cannot carry.
 *
 * Called once at startup. Everything here is either a base reset or an
 * interactive state, apart from the space layout's one breakpoint, so the
 * inline styles stay the single place to look for how something is arranged.
 * Hover applies everywhere, before the base rules so that focus wins over it.
 */
export function injectBaseStyles(): void {
  if (globalThis.document.getElementById('weave-base-styles')) return;

  const style = globalThis.document.createElement('style');
  style.id = 'weave-base-styles';
  style.textContent = `
    ${hoverCss}
    ${baseCss}

    /* A list row is a target, not a card: it earns a background on hover
       rather than carrying a border all the time. */
    [data-row-action] { opacity: 0; }
    /* Keyboard users never hover, so the action has to be reachable anyway. */
    [data-row-action]:focus-visible { opacity: 1; }

    .space-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; align-items: start; }
    @media (max-width: 760px) { .space-layout { grid-template-columns: 1fr; gap: 24px; } }

    @media (max-width: 520px) {
      [data-card] { padding: 28px 20px !important; }
    }
  `;
  globalThis.document.head.appendChild(style);
}

/** The shared vocabulary, plus the page the home's screens sit on. */
export const styles = {
  ...shared,
  container: {
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: '56px 20px 80px',
  },
  /** One part of the settings page, in a hairline box */
  settingsSection: {
    border: `1px solid ${palette.surface.line}`,
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  /** A line in a settings section: what it is on the left, what you can do about it on the right */
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    background: palette.surface.sunken,
    borderRadius: 8,
    fontSize: 14,
  },
} satisfies Record<string, CSSProperties>;
