/**
 * @module elements/auth-styles
 * How `<weave-auth>` looks.
 *
 * Black and white, hairline borders, one accent. Every colour, the font and
 * the corner radius are custom properties on the element, so a host page
 * restyles it without reaching inside:
 *
 * ```css
 * weave-auth { --weave-accent: #4f46e5; --weave-font: 'Inter', sans-serif; }
 * ```
 *
 * It sizes itself to its container rather than the window — a container query,
 * not a media query — so the same element fits a full page, a modal or a side
 * panel without being told which.
 */
export const AUTH_CSS = `
weave-auth {
  --weave-ink: #000;
  --weave-body: #171717;
  --weave-muted: #666;
  --weave-faint: #8f8f8f;
  --weave-surface: #fff;
  --weave-sunken: #fafafa;
  --weave-line: #eaeaea;
  --weave-line-strong: #d4d4d4;
  --weave-accent: #000;
  --weave-accent-hover: #383838;
  --weave-on-accent: #fff;
  --weave-danger: #e5484d;
  --weave-danger-soft: #fff0f0;
  --weave-radius: 6px;
  --weave-font: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --weave-mono: "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  display: block;
  container-type: inline-size;
  color: var(--weave-body);
  font-family: var(--weave-font);
  font-size: 14px;
  letter-spacing: -0.006em;
  -webkit-font-smoothing: antialiased;
}
weave-auth[hidden] { display: none; }
weave-auth *, weave-auth *::before, weave-auth *::after { box-sizing: border-box; }
weave-auth :is(h1, p) { margin: 0; }

weave-auth .wa-card { width: 100%; max-width: 380px; margin: 0 auto; }
weave-auth .wa-wordmark { display: flex; align-items: center; gap: 8px; margin-bottom: 40px; color: var(--weave-ink); font-weight: 600; font-size: 16px; letter-spacing: -0.03em; }
weave-auth .wa-title { font-size: 28px; font-weight: 600; letter-spacing: -0.04em; color: var(--weave-ink); margin-bottom: 8px; line-height: 1.2; }
weave-auth .wa-subtitle { font-size: 15px; color: var(--weave-muted); margin-bottom: 32px; line-height: 1.5; }
weave-auth .wa-hint { font-size: 14px; color: var(--weave-muted); margin-bottom: 20px; line-height: 1.6; }
weave-auth .wa-small { font-size: 13px; color: var(--weave-muted); margin-top: 8px; line-height: 1.6; }
weave-auth .wa-error { color: var(--weave-danger); font-size: 14px; font-weight: 500; }
weave-auth .wa-error-box { margin-top: 16px; padding: 12px 14px; border-radius: var(--weave-radius); background: var(--weave-danger-soft); }

weave-auth .wa-form { display: flex; flex-direction: column; gap: 8px; }
weave-auth .wa-form + .wa-form { margin-top: 10px; }
weave-auth input {
  width: 100%; height: 40px; padding: 0 12px;
  border-radius: var(--weave-radius); border: 1px solid var(--weave-line-strong);
  background: var(--weave-surface); color: var(--weave-ink);
  font: inherit; font-size: 14px; outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
weave-auth input::placeholder { color: var(--weave-faint); }
weave-auth input:focus { border-color: var(--weave-muted); box-shadow: 0 0 0 3px rgba(0, 0, 0, .06); }
weave-auth .wa-offscreen {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

weave-auth button { font: inherit; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
weave-auth button:not(:disabled) { cursor: pointer; }
weave-auth button:disabled { opacity: .5; cursor: not-allowed; }
weave-auth :focus-visible { outline: 2px solid var(--weave-ink); outline-offset: 2px; }
weave-auth button:focus:not(:focus-visible) { outline: none; }

weave-auth .wa-button {
  width: 100%; height: 40px; padding: 0 16px;
  border-radius: var(--weave-radius); border: 1px solid transparent;
  background: var(--weave-accent); color: var(--weave-on-accent);
  font-size: 14px; font-weight: 500;
}
weave-auth .wa-button:not(:disabled):hover { background: var(--weave-accent-hover); }
weave-auth .wa-link {
  background: none; border: none; padding: 4px 0; margin-right: 12px;
  color: var(--weave-muted); font-size: 13px; font-weight: 500; text-align: left;
}
weave-auth .wa-link:not(:disabled):hover { color: var(--weave-ink); }
weave-auth .wa-links { display: flex; flex-wrap: wrap; margin-top: 10px; }

weave-auth .wa-options { display: flex; flex-direction: column; gap: 12px; }
weave-auth .wa-option {
  display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 16px;
  text-align: left; border-radius: var(--weave-radius);
  border: 1px solid var(--weave-line); background: var(--weave-surface); color: var(--weave-body);
}
weave-auth .wa-option:not(:disabled):hover { background: var(--weave-sunken); border-color: var(--weave-line-strong); }
weave-auth .wa-option-title { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--weave-ink); }
weave-auth .wa-option-text { color: var(--weave-muted); font-size: 13px; line-height: 1.5; }
weave-auth .wa-badge {
  font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 999px;
  background: var(--weave-sunken); border: 1px solid var(--weave-line); color: var(--weave-muted);
}

weave-auth .wa-account { padding: 12px 0; border-top: 1px solid var(--weave-line); }
weave-auth .wa-account:last-of-type { border-bottom: 1px solid var(--weave-line); margin-bottom: 8px; }
weave-auth .wa-account-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px; margin: 0 -8px;
  width: calc(100% + 16px); text-align: left;
  background: none; border: 1px solid transparent; border-radius: var(--weave-radius); color: var(--weave-body);
}
weave-auth .wa-account-row:not(:disabled):hover { background: var(--weave-sunken); }
weave-auth .wa-account-name { display: block; font-weight: 600; color: var(--weave-ink); }
weave-auth .wa-account-did { display: block; font-size: 12px; color: var(--weave-faint); font-family: var(--weave-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
weave-auth .wa-account-body { margin-top: 10px; }
weave-auth .wa-avatar { flex-shrink: 0; display: block; border-radius: 8px; }

weave-auth .wa-code {
  display: block; margin-top: 16px; padding: 12px; border-radius: var(--weave-radius);
  background: var(--weave-sunken); border: 1px solid var(--weave-line);
  font-family: var(--weave-mono); font-size: 13px; color: var(--weave-ink);
  word-break: break-all; user-select: all;
}

weave-auth .wa-info { position: relative; display: inline; }
weave-auth .wa-info-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; padding: 0; margin-left: 6px; vertical-align: text-bottom;
  border-radius: 999px; border: 1px solid var(--weave-line-strong); background: none;
  color: var(--weave-faint); font-size: 10px; font-weight: 700; line-height: 1;
}
weave-auth .wa-popover {
  position: absolute; z-index: 30; top: 22px; left: 0; width: min(260px, 80cqi);
  padding: 12px 14px; border-radius: var(--weave-radius);
  background: var(--weave-surface); border: 1px solid var(--weave-line);
  box-shadow: 0 12px 28px -12px rgba(15, 17, 21, .22);
  font-size: 12.5px; line-height: 1.6; color: var(--weave-muted); font-weight: 400;
}
weave-auth .wa-popover[hidden] { display: none; }

@container (max-width: 340px) {
  weave-auth .wa-title { font-size: 24px; }
  weave-auth .wa-subtitle { margin-bottom: 24px; }
  weave-auth .wa-wordmark { margin-bottom: 28px; }
  weave-auth .wa-popover { left: auto; right: -8px; }
}
`;
