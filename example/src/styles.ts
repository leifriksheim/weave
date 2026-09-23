import type { CSSProperties } from 'react';

/**
 * One visual vocabulary for the whole app.
 *
 * Black and white, after Vercel's: white page, near-black text, one grey for
 * everything secondary, hairline borders instead of shadows, and black as the
 * only accent. Built from a small set of tokens rather than ad-hoc values, so
 * nothing on screen competes with the data itself.
 *
 * Inline styles cannot express hover, focus or placeholders, so those live in
 * {@link injectBaseStyles} — the two halves are meant to be read together.
 */

const ink = {
  /** Headings and anything that must be read first */
  strong: '#000000',
  /** Body text */
  body: '#171717',
  /** Supporting text: metadata, hints, the things you skim */
  muted: '#666666',
  /** Barely there: timestamps, ids */
  faint: '#8f8f8f',
} as const;

const surface = {
  page: '#ffffff',
  card: '#ffffff',
  sunken: '#fafafa',
  line: '#eaeaea',
  lineStrong: '#d4d4d4',
} as const;

const accent = {
  /** The one accent is black */
  base: '#000000',
  soft: '#f2f2f2',
  danger: '#e5484d',
  dangerSoft: '#fff0f0',
  good: '#1a7f37',
} as const;

const radius = { sm: 6, md: 6, lg: 8, pill: 999 } as const;

const font = '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const mono = '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/**
 * The rules inline styles cannot carry.
 *
 * Called once at startup. Everything here is either a base reset or an
 * interactive state — no layout, so the inline styles stay the single place to
 * look for how something is arranged.
 */
export function injectBaseStyles(): void {
  if (globalThis.document.getElementById('weave-base-styles')) return;

  const style = globalThis.document.createElement('style');
  style.id = 'weave-base-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: ${surface.page};
      color: ${ink.body};
      font-family: ${font};
      font-size: 14px;
      letter-spacing: -0.006em;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    h1, h2, h3, p, ul, figure { margin: 0; }
    ul { padding: 0; }

    button { font-family: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
    button:not(:disabled) { cursor: pointer; }
    button:disabled { opacity: .5; cursor: not-allowed; }

    /* Primary actions lift slightly; quiet ones just warm up. */
    [data-variant="primary"]:not(:disabled):hover { background-color: #383838 !important; }
    [data-variant="quiet"]:not(:disabled):hover { background-color: ${surface.sunken} !important; color: ${ink.strong} !important; }
    [data-variant="ghost"]:not(:disabled):hover { color: ${ink.strong} !important; }
    [data-variant="danger"]:not(:disabled):hover { background-color: ${accent.dangerSoft} !important; color: ${accent.danger} !important; }

    input, textarea, select { font-family: inherit; transition: border-color .15s ease, box-shadow .15s ease; }
    input::placeholder, textarea::placeholder { color: ${ink.faint}; }
    input:focus, textarea:focus, select:focus { border-color: ${ink.muted} !important; box-shadow: 0 0 0 3px rgba(0, 0, 0, .06); outline: none; }
    [data-variant="quiet"], [data-variant="secondary"] { border: 1px solid ${surface.line} !important; }
    tbody tr { transition: background-color .12s ease; }
    tbody tr:hover { background-color: ${surface.sunken}; }
    button[style*="text-align: left"]:not(:disabled):hover { border-color: ${surface.lineStrong} !important; }

    /* Visible only for keyboard users, so a mouse click stays quiet. */
    :focus-visible { outline: 2px solid ${ink.strong}; outline-offset: 2px; }
    button:focus:not(:focus-visible) { outline: none; }

    summary { cursor: pointer; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary::after { content: '›'; float: right; transition: transform .15s ease; display: inline-block; }
    details[open] > summary::after { transform: rotate(90deg); }
    summary:hover { color: ${ink.strong}; }

    /* A list row is a target, not a card: it earns a background on hover
       rather than carrying a border all the time. */
    [data-row]:hover { background-color: ${surface.sunken} !important; }
    [data-menu-item]:not(:disabled):hover { background-color: ${surface.sunken} !important; color: ${ink.strong} !important; }
    [data-row]:hover [data-row-action] { opacity: 1; }
    [data-row-action] { opacity: 0; transition: opacity .12s ease; }
    /* Keyboard users never hover, so the action has to be reachable anyway. */
    [data-row-action]:focus-visible { opacity: 1; }

    @keyframes weave-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes weave-rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }

    code { font-family: ${mono}; }

    @media (max-width: 520px) {
      [data-card] { padding: 28px 20px !important; }
    }
  `;
  globalThis.document.head.appendChild(style);
}

const button: CSSProperties = {
  height: 40,
  padding: '0 16px',
  borderRadius: radius.md,
  border: '1px solid transparent',
  backgroundColor: accent.base,
  color: '#fff',
  fontSize: 14,
  fontWeight: 500,
  width: '100%',
};

const quietButton: CSSProperties = {
  ...button,
  backgroundColor: surface.card,
  borderColor: surface.lineStrong,
  color: ink.body,
};

/** Shared inline styles — kept in one place so the app has a single visual vocabulary. */
export const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: '56px 20px 80px',
  },
  /** Onboarding is a column on a white page, not a box — Vercel's sign-in, not a dialog. */
  card: {
    padding: '64px 0 0',
    maxWidth: 380,
    width: '100%',
  },
  title: {
    fontSize: 28,
    fontWeight: 600,
    letterSpacing: '-0.04em',
    color: ink.strong,
    marginBottom: 8,
  },
  subtitle: { fontSize: 15, color: ink.muted, marginBottom: 32, lineHeight: 1.5 },
  hint: { fontSize: 14, color: ink.muted, marginBottom: 20, lineHeight: 1.6 },

  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  input: {
    width: '100%',
    height: 40,
    padding: '0 12px',
    borderRadius: radius.md,
    border: `1px solid ${surface.lineStrong}`,
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 14,
    outline: 'none',
  },
  button,

  error: { color: accent.danger, fontSize: 14, fontWeight: 500 },
  errorBox: {
    marginTop: 16,
    padding: '14px 16px',
    borderRadius: radius.md,
    backgroundColor: accent.dangerSoft,
    border: `1px solid #f5d9d7`,
  },
  errorHint: { color: ink.muted, fontSize: 13, marginTop: 8, lineHeight: 1.6 },

  app: { maxWidth: 720, width: '100%' },
  header: {
    marginBottom: 24,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
  },
  headerRow: {
    marginBottom: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  appTitle: { fontSize: 24, fontWeight: 600, letterSpacing: '-0.04em', color: ink.strong },
  identityBar: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  badge: {
    fontSize: 12,
    color: ink.muted,
    backgroundColor: surface.card,
    border: `1px solid ${surface.line}`,
    padding: '2px 8px',
    borderRadius: radius.pill,
  },

  addForm: { display: 'flex', gap: 8, marginBottom: 16 },
  todoInput: {
    flex: 1,
    height: 40,
    padding: '0 12px',
    borderRadius: radius.md,
    border: `1px solid ${surface.lineStrong}`,
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 14,
    outline: 'none',
  },
  addButton: { ...button, width: 'auto', whiteSpace: 'nowrap', alignSelf: 'flex-start' },
  /** Secondary actions: white, hairline border, a little shorter */
  smallButton: {
    height: 32,
    padding: '0 12px',
    borderRadius: radius.md,
    border: `1px solid ${surface.line}`,
    backgroundColor: surface.card,
    color: ink.body,
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },

  todoList: { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 },
  emptyState: {
    textAlign: 'center',
    color: ink.faint,
    fontSize: 14,
    padding: '36px 16px',
    border: `1px dashed ${surface.lineStrong}`,
    borderRadius: radius.md,
  },
  todoItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '11px 12px',
    borderRadius: radius.md,
    border: '1px solid transparent',
  },
  checkbox: { marginTop: 4, width: 15, height: 15, accentColor: accent.base, cursor: 'pointer' },
  todoContent: { flex: 1, minWidth: 0 },
  todoText: { fontSize: 14, fontWeight: 500, color: ink.strong, lineHeight: 1.5, wordBreak: 'break-word' },
  todoMeta: { fontSize: 12, color: ink.faint, marginTop: 3, lineHeight: 1.5 },
  footer: { marginTop: 28, textAlign: 'center' },
  footerHint: { fontSize: 12, color: ink.faint, lineHeight: 1.6 },

  panel: {
    marginTop: 16,
    border: `1px solid ${surface.line}`,
    borderRadius: radius.md,
    backgroundColor: surface.card,
    overflow: 'hidden',
  },
  panelSummary: {
    padding: '13px 16px',
    fontSize: 14,
    fontWeight: 500,
    color: ink.body,
    userSelect: 'none',
  },
  panelBody: {
    padding: '4px 16px 16px',
    fontSize: 13,
    color: ink.muted,
    lineHeight: 1.6,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  panelSection: {
    paddingTop: 20,
    marginTop: 8,
    borderTop: `1px solid ${surface.line}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: ink.strong, letterSpacing: '-0.01em' },

  chain: {
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    padding: 14,
    fontSize: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  chainRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  chainArrow: { color: ink.faint },
  token: {
    display: 'block',
    marginTop: 8,
    padding: 12,
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    fontSize: 11,
    color: ink.muted,
    wordBreak: 'break-all',
    lineHeight: 1.5,
    maxHeight: 96,
    overflow: 'auto',
  },

  linkRow: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 10 },
  linkButton: {
    background: 'none',
    border: 'none',
    color: ink.muted,
    fontSize: 13,
    fontWeight: 500,
    padding: '6px 8px',
    borderRadius: radius.sm,
  },

  recoveryCode: {
    display: 'block',
    marginTop: 14,
    padding: '14px 16px',
    backgroundColor: surface.sunken,
    border: `1px solid ${surface.line}`,
    borderRadius: radius.md,
    fontSize: 14,
    letterSpacing: '0.06em',
    color: ink.strong,
    textAlign: 'center',
    wordBreak: 'break-all',
  },

  spaceButton: {
    width: '100%',
    textAlign: 'left',
    padding: '16px',
    borderRadius: radius.lg,
    border: `1px solid ${surface.line}`,
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },

  inviteBanner: {
    padding: '16px 18px',
    borderRadius: radius.lg,
    backgroundColor: surface.sunken,
    border: `1px solid ${surface.line}`,
    marginBottom: 16,
  },

  saveForm: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 14,
    color: ink.body,
    cursor: 'pointer',
  },

  diagnostics: { marginTop: 12 },
  factList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 },
  factLabel: { color: ink.muted, fontSize: 12 },
  factValue: { color: ink.strong, fontSize: 12, fontWeight: 500 },
  infoList: {
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '4px 16px 18px',
    fontSize: 13,
    color: ink.muted,
    lineHeight: 1.6,
  },

  /** A small circled "i", sitting inline with the text it explains. */
  infoButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    padding: 0,
    marginLeft: 6,
    verticalAlign: 'text-bottom',
    borderRadius: radius.pill,
    border: `1px solid ${surface.lineStrong}`,
    background: 'none',
    color: ink.faint,
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
  },
  /** What the circled "i" opens. */
  popover: {
    position: 'absolute',
    zIndex: 30,
    top: 22,
    left: 0,
    width: 260,
    padding: '12px 14px',
    borderRadius: radius.md,
    backgroundColor: surface.card,
    border: `1px solid ${surface.line}`,
    boxShadow: '0 12px 28px -12px rgba(15, 17, 21, .22)',
    fontSize: 12.5,
    lineHeight: 1.6,
    color: ink.muted,
    textAlign: 'left',
    fontWeight: 400,
    animation: 'weave-fade .1s ease',
  },

  /** Dims the page behind a modal, and centres it. */
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(0, 0, 0, .4)',
    animation: 'weave-fade .12s ease',
  },
  modal: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: surface.card,
    borderRadius: radius.lg,
    padding: '24px 22px',
    boxShadow: '0 24px 48px -20px rgba(15, 17, 21, .3)',
    animation: 'weave-rise .16s ease',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: 600, letterSpacing: '-0.03em', color: ink.strong },

  /** Two choices side by side, for a question with exactly two answers. */
  segmented: {
    display: 'flex',
    padding: 3,
    gap: 3,
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
  },
  segment: {
    flex: 1,
    padding: '7px 10px',
    borderRadius: radius.sm,
    border: 'none',
    background: 'none',
    color: ink.muted,
    fontSize: 13,
    fontWeight: 500,
  },
  segmentActive: {
    flex: 1,
    padding: '7px 10px',
    borderRadius: radius.sm,
    border: 'none',
    backgroundColor: surface.card,
    color: ink.strong,
    fontSize: 13,
    fontWeight: 600,
    boxShadow: '0 1px 2px rgba(15, 17, 21, .08)',
  },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: ink.muted, marginBottom: 6 },

  /** A row in a list: a target, with no border until you are over it. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderRadius: radius.md,
    border: '1px solid transparent',
    background: 'none',
    width: '100%',
    textAlign: 'left',
  },
  rowAction: {
    border: 'none',
    background: 'none',
    color: ink.faint,
    fontSize: 15,
    lineHeight: 1,
    padding: '4px 6px',
    borderRadius: radius.sm,
    flexShrink: 0,
  },

  /** A panel that floats over the page rather than sitting in it. */
  menu: {
    position: 'absolute',
    right: 0,
    top: 44,
    zIndex: 20,
    minWidth: 300,
    marginTop: 0,
    border: `1px solid ${surface.line}`,
    borderRadius: radius.md,
    backgroundColor: surface.card,
    boxShadow: '0 12px 28px -12px rgba(15, 17, 21, .22), 0 2px 6px -2px rgba(15, 17, 21, .1)',
  },

  ok: { color: accent.good, fontSize: 13, fontWeight: 500 },
  bad: { color: accent.danger, fontSize: 13, fontWeight: 500 },
} satisfies Record<string, CSSProperties>;

/** Quieter alternatives, for actions that should not compete with the main one. */
export const variants = {
  quiet: quietButton,
  danger: { ...quietButton, color: accent.danger },
} satisfies Record<string, CSSProperties>;

export const palette = { ink, surface, accent, radius, font, mono };
