import type { CSSProperties } from 'react';
import { baseCss, hoverCss, palette, styles } from '@weave/app-shared/styles';

export { palette, styles };

const { ink, surface, accent, radius } = palette;

/** How wide the column of spaces is, down the left edge while one is open. */
const RAIL_WIDTH = 68;

/**
 * The rules inline styles cannot carry.
 *
 * Called once at startup. Everything here is a base reset, an interactive
 * state, or layout that changes with the screen: inline styles cannot hold a
 * media query, so anything arranged differently on a phone takes a class here
 * instead of an inline style. The rest of the layout stays inline.
 */
export function injectBaseStyles(): void {
  if (globalThis.document.getElementById('weave-base-styles')) return;

  const style = globalThis.document.createElement('style');
  style.id = 'weave-base-styles';
  style.textContent = `
    ${baseCss}

    /* Hover only where there is a pointer that hovers. On a touchscreen a
       tap would otherwise leave the hover look stuck on whatever was tapped. */
    @media (hover: hover) {
      /* A list row is a target, not a card: it earns a background on hover
         rather than carrying a border all the time, and its small actions
         show up with it. Without hover (touch) they simply stay visible. */
      [data-row-action] { opacity: 0; }
      /* Keyboard users never hover, so the action has to be reachable anyway. */
      [data-row-action]:focus-visible { opacity: 1; }
      ${hoverCss}
    }

    /* ── Layout that follows the screen ──────────────────────────────────
       One breakpoint for "phone" (640px) and one for "too narrow for a side
       column" (760px). Touch is asked about separately, with pointer: coarse,
       since a small laptop window is not a phone and a tablet is not a mouse. */

    .page {
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 56px 20px 80px;
    }
    .page[data-rail] { padding-left: ${RAIL_WIDTH + 20}px; }

    /* Every space down the left edge; along the bottom on a phone. */
    .rail {
      position: fixed;
      z-index: 10;
      top: 0;
      bottom: 0;
      left: 0;
      width: ${RAIL_WIDTH}px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 16px 0;
      background: ${surface.sunken};
      border-right: 1px solid ${surface.line};
    }
    .rail-list { display: flex; flex-direction: column; align-items: center; gap: 8px; overflow-y: auto; flex: 0 1 auto; width: 100%; }
    .rail-divider { flex-shrink: 0; width: 28px; height: 1px; margin: 4px 0; background: ${surface.line}; }
    .rail-slot { position: relative; flex-shrink: 0; width: 100%; display: flex; justify-content: center; padding: 2px 0; border: none; background: none; }

    /* A row that scrolls sideways instead of wrapping, with no scrollbar in the way. */
    .scroll-x { overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
    .scroll-x::-webkit-scrollbar { display: none; }
    .scroll-x > * { flex-shrink: 0; white-space: nowrap; }

    /* A space: its collections down the side, the chosen one beside them. */
    .space-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 40px; align-items: start; }
    .space-side { display: flex; flex-direction: column; gap: 28px; }
    .collection-nav { display: flex; flex-direction: column; gap: 2px; }

    .graph-canvas { height: 600px; }
    .collection-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .collection-search { width: 180px; }
    .modal { max-height: calc(100dvh - 40px); overflow-y: auto; }

    /* Calls: over every page, never part of one (components/calls). */
    .call-panel {
      position: fixed; z-index: 30; right: 20px; bottom: 20px; width: 340px;
      display: flex; flex-direction: column; gap: 12px; padding: 14px;
      background: ${surface.card}; border: 1px solid ${surface.lineStrong}; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.12);
    }
    .call-stage {
      top: 20px; left: ${RAIL_WIDTH + 20}px; width: auto;
      background: #0a0a0a; border-color: #222; color: #eee;
    }
    .call-stage .call-tiles { flex: 1; }
    .call-tiles { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 0; }
    .call-tiles[data-count="1"] { grid-template-columns: minmax(0, 1fr); }
    .call-tiles[data-large][data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .call-tiles[data-large]:is([data-count="3"], [data-count="4"]) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .call-tiles[data-large]:is([data-count="5"], [data-count="6"]) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .call-tile {
      position: relative; margin: 0; aspect-ratio: 4 / 3; overflow: hidden; border-radius: 8px;
      display: flex; align-items: center; justify-content: center; background: #161616;
    }
    .call-stage .call-tile { aspect-ratio: auto; min-height: 120px; }
    .call-name {
      position: absolute; left: 6px; bottom: 6px; display: inline-flex; align-items: center; gap: 4px;
      max-width: calc(100% - 12px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #fff; background: rgba(0,0,0,.55);
    }
    .call-pip { display: flex; height: 100vh; padding: 6px; box-sizing: border-box; }
    .call-pip .call-tiles { flex: 1; }
    .call-pip .call-tile { aspect-ratio: auto; }
    .call-stack {
      position: fixed; z-index: 31; top: 16px; right: 20px; width: 320px;
      display: flex; flex-direction: column; gap: 10px; pointer-events: none;
    }
    .call-card {
      pointer-events: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px;
      background: ${surface.card}; border: 1px solid ${surface.lineStrong}; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.12); font-size: 14px;
    }
    .call-ringing { display: inline-flex; border-radius: 50%; animation: call-ring 1.2s ease-out infinite; }
    @keyframes call-ring { 0% { box-shadow: 0 0 0 0 rgba(26,127,55,.45); } 100% { box-shadow: 0 0 0 12px rgba(26,127,55,0); } }
    @media (prefers-reduced-motion: reduce) { .call-ringing { animation: none; } }

    @media (max-width: 760px) {
      .space-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
      /* The side column comes apart: its collections become a row of
         tabs above the list, and who is here and the invite go below it,
         so the thing you opened the space for is on the first screen. */
      .space-side { display: contents; }
      .space-side > section { order: 1; }
      .collection-nav { flex-direction: row; gap: 6px; margin: 0 -16px; padding: 0 16px; overflow-x: auto; scrollbar-width: none; }
      .collection-nav::-webkit-scrollbar { display: none; }
      .collection-nav > * { flex-shrink: 0; white-space: nowrap; }
      .collection-nav [data-nav] { border: 1px solid ${surface.line} !important; border-radius: ${radius.pill}px !important; padding: 0 12px !important; }
      .collection-nav [data-nav][aria-current] { border-color: ${ink.strong} !important; }
      .collection-nav-heading { display: none; }
    }

    @media (max-width: 640px) {
      .page {
        padding: 20px max(16px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      .page[data-rail] {
        padding-left: max(16px, env(safe-area-inset-left));
        padding-bottom: calc(${RAIL_WIDTH + 48}px + env(safe-area-inset-bottom));
      }

      .rail {
        top: auto;
        right: 0;
        width: auto;
        flex-direction: row;
        gap: 4px;
        padding: 8px max(8px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
        border-right: none;
        border-top: 1px solid ${surface.line};
      }
      .rail-list { flex-direction: row; flex: 1 1 auto; width: auto; overflow-x: auto; overflow-y: hidden; padding: 4px; scrollbar-width: none; }
      .rail-list::-webkit-scrollbar { display: none; }
      .rail-divider { width: 1px; height: 28px; margin: 0 4px; }
      .rail-slot { width: auto; padding: 0 2px; }
      .rail [data-rail-pill] { display: none; }

      .space-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .call-panel { left: 12px; right: 12px; width: auto; bottom: calc(${RAIL_WIDTH + 12}px + env(safe-area-inset-bottom)); }
      .call-stage { top: 12px; left: 12px; }
      .call-stack { left: 12px; right: 12px; width: auto; top: 12px; }
      .graph-canvas { height: min(600px, 65dvh); }
      .collection-tools { width: 100%; }
      .collection-search { flex: 1 1 100%; width: auto; }

      /* A dialog rises from the bottom edge, where a thumb can reach it. */
      .modal-backdrop { align-items: flex-end !important; padding: 0 !important; }
      .modal {
        max-width: none !important;
        max-height: 92dvh;
        border-radius: 14px 14px 0 0 !important;
        padding-bottom: calc(24px + env(safe-area-inset-bottom)) !important;
        animation: weave-sheet .2s ease !important;
      }

      /* Floating panels are anchored to what opened them, which on a phone
         can be near an edge; pinned to the bottom instead, they always fit. */
      .popover {
        position: fixed !important;
        top: auto !important;
        left: 16px !important;
        right: 16px;
        bottom: calc(16px + env(safe-area-inset-bottom));
        width: auto !important;
        font-size: 14px !important;
      }

      /* Two labels beside each other leave too little room for the value. */
      .property { grid-template-columns: minmax(0, 1fr) !important; gap: 2px !important; }
      .property > dt { padding-top: 0 !important; }
    }

    /* Fingers, not a mouse: bigger targets, and no text field under 16px,
       or iOS zooms the page every time one is tapped. Only the small ones are
       raised — a field drawn large, like a record's title, keeps its size. */
    @media (pointer: coarse) {
      :is(input:not([type="checkbox"]):not([type="radio"]), textarea, select):is(:not([style*="font-size"]), [style*="font-size: 11"], [style*="font-size: 12"], [style*="font-size: 13"], [style*="font-size: 14"], [style*="font-size: 15"]) { font-size: 16px !important; }
      input:not([type="checkbox"]):not([type="radio"]), select { min-height: 40px; }
      button[data-variant], [role="tab"], [data-nav], [data-menu-item] { min-height: 40px; }
      [data-row-action] { min-width: 36px; min-height: 36px; }
      /* The query editor is a see-through field over its highlighted copy; both change size together or the caret drifts off the text. */
      .code-layer { font-size: 16px !important; }
    }

    @keyframes weave-sheet { from { transform: translateY(100%) } to { transform: none } }
  `;
  globalThis.document.head.appendChild(style);
}

const quietButton: CSSProperties = {
  ...styles.button,
  backgroundColor: surface.card,
  borderColor: surface.lineStrong,
  color: ink.body,
};

/** Quieter alternatives, for actions that should not compete with the main one. */
export const variants = {
  quiet: quietButton,
  danger: { ...quietButton, color: accent.danger },
} satisfies Record<string, CSSProperties>;
