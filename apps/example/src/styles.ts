import type { CSSProperties } from 'react';
import { baseCss, hoverCss, palette, styles } from '@weave/app-shared/styles';

export { palette, styles };

const { ink, surface, accent, radius } = palette;

/** How wide the column of spaces is, down the left edge while one is open. */
const RAIL_WIDTH = 68;
/** How wide a space's own sidebar is, beside the rail */
const SIDEBAR_WIDTH = 248;

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
      .you-button:hover, .you-button[aria-expanded="true"] { background: rgba(0, 0, 0, .05); }
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

    /* In a space: the rail, the space's sidebar, and whatever is open, each
       the height of the window and scrolling on its own, the way chat apps are. */
    .shell { padding-left: ${RAIL_WIDTH}px; }
    .space-shell { display: grid; grid-template-columns: ${SIDEBAR_WIDTH}px minmax(0, 1fr); height: 100vh; height: 100dvh; }
    .space-sidebar {
      display: flex; flex-direction: column; min-height: 0;
      background: ${surface.sunken}; border-right: 1px solid ${surface.line};
    }
    .space-sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 16px 10px 16px; }
    /* You, at the foot of the sidebar; its menus open upward from it. */
    .you-bar {
      position: relative; z-index: 15; flex-shrink: 0; display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; border-top: 1px solid ${surface.line}; background: ${surface.sunken};
    }
    .you-button {
      width: 100%; display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 6px;
      border: none; border-radius: 8px; background: none; text-align: left;
    }
    .side-item {
      display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px;
      border: none; border-radius: 7px; background: none; font-size: 14px; text-align: left;
    }
    .side-item[aria-current] { background: ${surface.card}; box-shadow: 0 0 0 1px ${surface.line}; }
    .space-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .space-bar {
      flex-shrink: 0; display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 24px;
      border-bottom: 1px solid ${surface.line}; background: ${surface.page};
    }
    .space-content { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 32px 64px; }
    .space-inner { max-width: 1040px; margin: 0 auto; }
    .space-inner[data-wide] { max-width: none; }
    /* An app that is a conversation, or a screen of its own, gets every pixel. */
    .space-content[data-fill] { display: flex; flex-direction: column; overflow: hidden; padding: 16px 24px 20px; }
    .space-content[data-fill] > .space-inner { flex: 1; min-height: 0; width: 100%; max-width: none; display: flex; flex-direction: column; }
    .phone-only { display: none !important; }

    /* Designing a collection: the form, and beside it a preview of what filling one in looks like. */
    .designer { grid-template-columns: minmax(0, 1fr); }
    .designer-preview { position: static !important; }
    @media (min-width: 1500px) {
      .designer { grid-template-columns: minmax(0, 1fr) 300px; }
      .designer-preview { position: sticky !important; }
    }

    /* How many new things there are: on an icon's corner, or at the end of a row. */
    .count {
      display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: ${accent.danger}; color: #fff; font-size: 11px; font-weight: 600; line-height: 1;
    }
    /* Only new, nothing for you: there, but not calling. */
    .count[data-quiet] { background: ${ink.muted}; }
    /* Nested data in a record: a caret that turns when it opens */
    .value-fold > summary::-webkit-details-marker { display: none; }
    .value-fold > summary::before { content: '▸'; display: inline-block; width: 12px; color: ${ink.faint}; transition: transform .1s ease; }
    .value-fold[open] > summary::before { transform: rotate(90deg); }
    .rail-count, .app-card-count, .tab-count { position: absolute; pointer-events: none; }
    .rail-count { top: -2px; right: 8px; }
    .rail-count .count { box-shadow: 0 0 0 2px ${surface.sunken}; }
    .app-card-count { top: -6px; right: -6px; }
    .app-card-count .count, .tab-count .count { box-shadow: 0 0 0 2px ${surface.card}; }
    .tab-count { top: -4px; right: -10px; }

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

    /* A space's apps, like a phone's home screen: cards on a wide screen,
       icons on a narrow one. */
    .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
    .app-list { display: flex; flex-direction: column; gap: 8px; }

    /* Views that sit side by side under one heading, like Under the hood's. */
    .segmented { display: flex; gap: 2px; align-self: flex-start; max-width: 100%; padding: 3px; border-radius: 10px; background: ${surface.sunken}; border: 1px solid ${surface.line}; }
    .segmented > button {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border: none; border-radius: 7px; background: none; color: ${ink.muted}; font-size: 13px; font-weight: 500;
    }
    .segmented > button[aria-selected="true"] { background: ${surface.card}; color: ${ink.strong}; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 0 0 1px ${surface.line}; }

    /* A space's sections along the bottom, and the button that makes an
       app: phones only. */
    .tabbar, .fab { display: none; }

    .graph-canvas { height: 600px; }
    .collection-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .collection-search { width: 180px; }

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
    .call-overlay {
      position: fixed; z-index: 40; inset: 0; padding: 16px;
      display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center;
      background: rgba(0,0,0,.35);
    }
    .call-incoming { width: min(340px, 100%); align-items: center; text-align: center; gap: 16px; padding: 24px; }
    .call-ringing { display: inline-flex; border-radius: 50%; animation: call-ring 1.2s ease-out infinite; }
    @keyframes call-ring { 0% { box-shadow: 0 0 0 0 rgba(26,127,55,.45); } 100% { box-shadow: 0 0 0 12px rgba(26,127,55,0); } }
    @media (prefers-reduced-motion: reduce) { .call-ringing { animation: none; } }

    /* Chat: its channels and conversations down the left, the one open beside them. */
    .chat-shell { display: grid; grid-template-columns: 208px minmax(0, 1fr); }
    .chat-places {
      display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
      padding: 4px 8px 12px; border-right: 1px solid ${surface.line}; background: ${surface.sunken};
    }
    .chat-places [data-nav]:not([aria-current]):hover { background: rgba(0,0,0,.04) !important; }

    @media (max-width: 900px) {
      .space-shell { grid-template-columns: 200px minmax(0, 1fr); }
      .space-content { padding: 20px 20px 48px; }
      .space-bar { padding: 0 20px; }
    }

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
      /* The chat's list becomes a row of tabs above it, as the side column's does. */
      .chat-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .chat-places {
        flex-direction: row; align-items: center; gap: 4px; overflow-x: auto; scrollbar-width: none;
        padding: 6px 8px; border-right: none; border-bottom: 1px solid ${surface.line};
      }
      .chat-places::-webkit-scrollbar { display: none; }
      .chat-places > * { flex-shrink: 0; width: auto !important; }
      .chat-places-heading { padding: 0 2px 0 6px !important; }
      .chat-places-heading > span, .chat-places-note { display: none; }
    }

    @media (max-width: 640px) {
      .page {
        padding: 20px max(16px, env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }

      /* A phone switches spaces from the list of them, one tap away in the
         tab bar, so the space's own sections get the bottom edge, and its
         apps are the grid on the first screen rather than a sidebar. */
      .rail, .space-sidebar, .hide-on-phone, .bar-label { display: none !important; }
      .phone-only { display: revert !important; }
      .segmented.phone-only { display: flex !important; }
      .shell { padding-left: 0; }
      .space-shell { display: block; height: auto; min-height: 100dvh; }
      .space-bar {
        position: sticky; top: 0; z-index: 8; height: auto; min-height: 56px; gap: 8px;
        padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
        background: rgba(255, 255, 255, .92);
        -webkit-backdrop-filter: saturate(180%) blur(12px);
        backdrop-filter: saturate(180%) blur(12px);
      }
      .space-content {
        overflow: visible;
        padding: 16px max(16px, env(safe-area-inset-right)) calc(${RAIL_WIDTH + 100}px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      /* An open app is the whole screen, with the way back at its top, as a conversation is on a phone. */
      .space-shell[data-app-open] .tabbar { display: none; }
      .space-shell[data-app-open] .space-content { overflow-y: auto; padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
      .space-shell[data-app-open] .space-main { display: flex; height: 100dvh; }
      .space-shell[data-app-open] .space-bar { position: static; }
      .space-content[data-fill] { padding: 8px 8px calc(8px + env(safe-area-inset-bottom)); }

      .tabbar {
        position: fixed;
        z-index: 10;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        padding: 6px max(4px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
        background: rgba(255, 255, 255, .92);
        -webkit-backdrop-filter: saturate(180%) blur(12px);
        backdrop-filter: saturate(180%) blur(12px);
        border-top: 1px solid ${surface.line};
      }
      .tabbar > button {
        flex: 1 1 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 6px 2px;
        border: none;
        background: none;
        color: ${ink.faint};
        font-size: 11px;
        font-weight: 500;
        white-space: nowrap;
      }
      .tabbar > button[aria-current] { color: ${ink.strong}; }

      .fab {
        position: fixed;
        z-index: 9;
        right: max(16px, env(safe-area-inset-right));
        bottom: calc(${RAIL_WIDTH + 12}px + env(safe-area-inset-bottom));
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 48px;
        padding: 0 18px;
        border: none;
        border-radius: ${radius.pill}px;
        background: ${ink.strong};
        color: #fff;
        font-size: 15px;
        font-weight: 600;
        box-shadow: 0 8px 24px -6px rgba(0, 0, 0, .35);
      }

      /* Three icons to a row, named underneath, the way a phone lays out apps. */
      .app-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 8px; }
      .app-card { flex-direction: column !important; align-items: center !important; gap: 8px !important; padding: 4px 0 !important; border: none !important; background: none !important; text-align: center !important; box-shadow: none !important; }
      .app-card .app-card-icon { width: 60px !important; height: 60px !important; border-radius: 16px !important; }
      .app-card .app-card-icon svg { width: 28px; height: 28px; }
      .app-card strong { font-size: 13px !important; font-weight: 500 !important; }
      .app-card-text { display: none; }

      /* The avatar and the phone say enough on their own. */
      .account-name, .call-label { display: none; }
      .account-button { padding: 0 3px !important; }

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
      /* The query editor and a box you can mention in are see-through fields over a highlighted copy; both change size together or the caret drifts off the text. */
      .code-layer, .mention-layer { font-size: 16px !important; }
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

const line = `1px solid ${surface.line}`;

/** Pieces many views share: a pill, a table's cells, a bordered card, a clipped line, a column. */
export const ui = {
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    padding: '0 10px',
    borderRadius: radius.pill,
    // Longhands, so a chip that is on can change the colour alone.
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: surface.line,
    background: surface.card,
    color: ink.body,
    fontSize: 12.5,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  chipOn: { background: ink.strong, color: '#fff', borderColor: ink.strong },
  th: {
    textAlign: 'left',
    padding: '10px 14px',
    borderBottom: line,
    color: ink.muted,
    fontWeight: 500,
    fontSize: 12,
    background: surface.sunken,
  },
  td: { padding: '10px 14px', borderBottom: line, color: ink.body },
  card: { border: line, borderRadius: 10, background: surface.card },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stack: { display: 'flex', flexDirection: 'column' },
} satisfies Record<string, CSSProperties>;
