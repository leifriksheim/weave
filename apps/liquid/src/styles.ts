import { baseCss, hoverCss, palette } from '@weave/app-shared/styles';

export { palette };

const { ink, surface, accent } = palette;

/** The three answers, in the colours every bar and button uses */
export const tone = {
  for: accent.good,
  against: accent.danger,
  abstain: '#a1a1a1',
  track: '#f0f0f0',
} as const;

/** A topic's or party's colour, from its hue: strong for a dot, soft for a background */
export const hue = (h: number) => ({
  strong: `hsl(${h} 62% 44%)`,
  soft: `hsl(${h} 70% 96%)`,
  line: `hsl(${h} 50% 86%)`,
});

/**
 * Weave's vocabulary (white page, near-black ink, hairlines, Geist), and
 * what inline styles cannot say: hover, focus, motion and the phone layout.
 */
export function injectStyles(): void {
  if (globalThis.document.getElementById('liquid-styles')) return;
  const style = globalThis.document.createElement('style');
  style.id = 'liquid-styles';
  style.textContent = `
    ${baseCss}
    @media (hover: hover) {
      ${hoverCss}
      .lq-card[data-interactive]:hover { border-color: ${surface.lineStrong}; box-shadow: 0 8px 24px -16px rgba(15, 17, 21, .22); }
      .lq-upvote:not([aria-pressed="true"]):not(:disabled):hover { border-color: ${ink.muted}; color: ${ink.strong}; }
      .lq-vote:not([aria-pressed="true"]):not(:disabled):hover { border-color: ${ink.muted}; }
      .lq-tab:not([aria-selected="true"]):hover { color: ${ink.strong}; }
      .lq-pick:hover { background: ${surface.sunken}; }
      .lq-chip[data-filter]:not([aria-pressed="true"]):hover { border-color: ${surface.lineStrong}; color: ${ink.strong}; }
      .lq-link:hover { color: ${ink.strong}; text-decoration-color: ${ink.muted}; }
    }

    body { background: ${surface.page}; }
    .modal { max-height: calc(100dvh - 40px); overflow-y: auto; }
    .modal > * { flex-shrink: 0; }

    .lq-shell { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
    .lq-header {
      position: sticky; top: 0; z-index: 20;
      background: rgba(255, 255, 255, .86); backdrop-filter: saturate(180%) blur(12px);
      -webkit-backdrop-filter: saturate(180%) blur(12px);
      border-bottom: 1px solid ${surface.line};
    }
    .lq-header-inner { max-width: 820px; margin: 0 auto; padding: 0 24px; }
    .lq-bar { display: flex; align-items: center; gap: 12px; height: 60px; }
    .lq-main { width: 100%; max-width: 820px; margin: 0 auto; padding: 28px 24px 96px; flex: 1; }

    .lq-tabs { display: flex; gap: 22px; margin-bottom: -1px; }
    .lq-tab {
      position: relative; display: inline-flex; align-items: center; gap: 6px;
      height: 42px; padding: 0; border: none; background: none;
      font-size: 14px; font-weight: 500; color: ${ink.muted};
      border-bottom: 2px solid transparent;
    }
    .lq-tab[aria-selected="true"] { color: ${ink.strong}; border-bottom-color: ${ink.strong}; }
    .lq-tab-count {
      min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      display: inline-flex; align-items: center; justify-content: center;
      background: ${surface.sunken}; border: 1px solid ${surface.line};
      font-size: 11px; font-weight: 600; color: ${ink.muted}; font-variant-numeric: tabular-nums;
    }

    .lq-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent;
      font-size: 14px; font-weight: 500; white-space: nowrap;
      background: ${accent.base}; color: #fff;
    }
    .lq-btn[data-variant="quiet"] { background: ${surface.card}; color: ${ink.body}; }
    .lq-btn[data-variant="ghost"] { background: none; color: ${ink.muted}; padding: 0 8px; }
    .lq-btn[data-variant="danger"] { background: ${surface.card}; color: ${accent.danger}; border-color: ${surface.line}; }
    .lq-btn[data-size="sm"] { height: 30px; padding: 0 10px; font-size: 13px; border-radius: 7px; }
    .lq-btn[data-size="lg"] { height: 44px; padding: 0 20px; font-size: 15px; }
    .lq-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: 8px; border: 1px solid ${surface.line};
      background: ${surface.card}; color: ${ink.muted}; font-size: 15px; font-weight: 600;
    }

    .lq-input, .lq-textarea {
      width: 100%; padding: 0 12px; border-radius: 8px; border: 1px solid ${surface.lineStrong};
      background: ${surface.card}; color: ${ink.strong}; font-size: 14px; outline: none;
    }
    .lq-input { height: 40px; }
    .lq-textarea { padding: 10px 12px; min-height: 120px; resize: vertical; line-height: 1.55; }
    .lq-label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: ${ink.muted}; }

    .lq-card {
      border: 1px solid ${surface.line}; border-radius: 12px; background: ${surface.card};
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .lq-card[data-interactive] { cursor: pointer; }

    .lq-proposal { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 14px; padding: 16px 18px 16px 14px; }
    .lq-upvote {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      width: 48px; height: 56px; border-radius: 10px; border: 1px solid ${surface.line};
      background: ${surface.card}; color: ${ink.muted}; font-size: 13px; font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .lq-upvote svg { transition: transform .15s ease; }
    .lq-upvote[aria-pressed="true"] { background: ${ink.strong}; border-color: ${ink.strong}; color: #fff; }
    .lq-upvote[aria-pressed="true"] svg { transform: translateY(-1px); }

    .lq-chip {
      display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px;
      border-radius: 999px; border: 1px solid ${surface.line}; background: ${surface.card};
      font-size: 12px; font-weight: 500; color: ${ink.body}; white-space: nowrap;
    }
    .lq-chip[data-filter] { height: 30px; padding: 0 12px; font-size: 13px; color: ${ink.muted}; }
    .lq-chip[data-filter][aria-pressed="true"] { background: ${ink.strong}; border-color: ${ink.strong}; color: #fff; }
    .lq-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

    .lq-meter { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: ${tone.track}; }
    .lq-meter > span { height: 100%; transition: width .4s cubic-bezier(.2, .8, .2, 1); }
    .lq-meter[data-size="lg"] { height: 10px; border-radius: 5px; }

    .lq-votes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .lq-vote {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
      height: 76px; border-radius: 12px; border: 1px solid ${surface.line}; background: ${surface.card};
      font-size: 14px; font-weight: 600; color: ${ink.body};
      transition: border-color .15s ease, background-color .15s ease, transform .1s ease;
    }
    .lq-vote:active:not(:disabled) { transform: scale(.98); }
    .lq-vote[aria-pressed="true"] { color: #fff; }
    .lq-vote[data-choice="for"][aria-pressed="true"] { background: ${tone.for}; border-color: ${tone.for}; }
    .lq-vote[data-choice="against"][aria-pressed="true"] { background: ${tone.against}; border-color: ${tone.against}; }
    .lq-vote[data-choice="abstain"][aria-pressed="true"] { background: ${ink.body}; border-color: ${ink.body}; }
    .lq-vote small { font-size: 11px; font-weight: 500; opacity: .75; }

    .lq-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; }
    .lq-row + .lq-row { border-top: 1px solid ${surface.line}; }
    .lq-pick {
      display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 10px;
      border: none; border-radius: 8px; background: none; text-align: left; font-size: 14px; color: ${ink.body};
    }
    .lq-pick[aria-pressed="true"] { background: ${surface.sunken}; box-shadow: inset 0 0 0 1px ${surface.lineStrong}; }

    .lq-stack { display: flex; }
    .lq-stack > * { box-shadow: 0 0 0 2px ${surface.card}; border-radius: 6px; }
    .lq-stack > * + * { margin-left: -6px; }

    .lq-section-title { font-size: 13px; font-weight: 600; color: ${ink.strong}; letter-spacing: -0.01em; }
    .lq-muted { color: ${ink.muted}; }
    .lq-faint { color: ${ink.faint}; }
    .lq-num { font-variant-numeric: tabular-nums; }
    .lq-link { background: none; border: none; padding: 0; font: inherit; color: ${ink.body}; text-decoration: underline; text-decoration-color: ${surface.lineStrong}; text-underline-offset: 3px; }

    .lq-empty {
      display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center;
      padding: 48px 24px; border: 1px dashed ${surface.lineStrong}; border-radius: 12px; color: ${ink.muted};
    }
    .lq-note {
      display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 10px;
      background: ${surface.sunken}; border: 1px solid ${surface.line}; font-size: 13px; line-height: 1.55; color: ${ink.body};
    }
    .lq-note[data-tone="warn"] { background: #fff8eb; border-color: #f5e3bd; }
    .lq-note[data-tone="bad"] { background: ${accent.dangerSoft}; border-color: #f5d9d7; }
    .lq-note[data-tone="good"] { background: #effaf2; border-color: #cfe9d6; }

    .lq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
    .lq-tile { display: flex; flex-direction: column; gap: 14px; padding: 18px; min-height: 148px; text-align: left; font: inherit; color: inherit; }
    .lq-tile-new {
      align-items: center; justify-content: center; gap: 8px; border-style: dashed;
      color: ${ink.muted}; background: none;
    }
    .lq-tile-new:hover { border-color: ${ink.muted}; color: ${ink.strong}; }

    .lq-path { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 13px; }
    .lq-path-arrow { color: ${ink.faint}; }

    .lq-rise { animation: weave-rise .22s cubic-bezier(.2, .8, .2, 1) both; }
    .lq-fade { animation: weave-fade .2s ease both; }

    .lq-hero-art { width: 100%; max-width: 440px; height: auto; }
    .lq-aside { position: sticky; top: 128px; }
    .lq-two { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
    .lq-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .lq-scroll-x { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .lq-scroll-x::-webkit-scrollbar { display: none; }
    .lq-scroll-x > * { flex-shrink: 0; }

    @media (max-width: 760px) {
      .lq-two { grid-template-columns: minmax(0, 1fr); }
      .lq-aside { position: static; }
    }
    @media (max-width: 640px) {
      .lq-header-inner { padding: 0 16px; }
      .lq-main { padding: 20px 16px 88px; }
      .lq-proposal { grid-template-columns: 42px minmax(0, 1fr); gap: 12px; padding: 14px 14px 14px 12px; }
      .lq-upvote { width: 42px; height: 50px; }
      .lq-tabs { gap: 18px; }
      .lq-hide-phone { display: none !important; }
      .lq-vote { height: 64px; }
    }
  `;
  globalThis.document.head.appendChild(style);
}
