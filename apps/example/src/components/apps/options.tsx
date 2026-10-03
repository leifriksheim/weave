import { useState, type ReactNode } from 'react';
import type { QueryRecord } from '@weaveprotocol/core';
import { Avatar } from '@weave/app-shared/Avatar';
import { ago } from '../../derive/time';
import { styles, palette, ui } from '../../styles';
import { Person } from '../Person';

const MAX_OPTIONS = 10;
const box = {
  ...ui.stack,
  padding: 16,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
} as const;

/** A question put to the space: who asked, its title, its options and what follows them */
export function OptionCard({
  record,
  verb,
  badge,
  title,
  open,
  onOpen,
  children,
}: {
  record: Pick<QueryRecord, 'createdBy' | 'author' | 'createdAt'>;
  verb: string;
  badge: string | false;
  title: string;
  open: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <article style={{ ...box, gap: 12 }}>
      <header style={{ ...ui.stack, gap: 6 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: palette.ink.faint }}
        >
          <Avatar did={record.createdBy ?? record.author} size={18} />
          <span>
            <Person did={record.createdBy} /> {verb} · {ago(record.createdAt)}
          </span>
          {badge && <span style={{ ...styles.badge, marginLeft: 'auto' }}>{badge}</span>}
        </div>
        <button
          onClick={onOpen}
          title={open}
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            font: 'inherit',
            fontSize: 16,
            fontWeight: 600,
            color: palette.ink.strong,
            textAlign: 'left',
            wordBreak: 'break-word',
          }}
        >
          {title}
        </button>
      </header>
      {children}
    </article>
  );
}

/** One option, filled as far as its share goes */
export function OptionBar({
  label,
  count,
  share,
  chosen,
  strong = chosen,
  radio,
  clickable,
  voters,
  onClick,
}: {
  label: ReactNode;
  count: ReactNode;
  share: number;
  chosen: boolean;
  strong?: boolean;
  radio?: boolean;
  clickable: boolean;
  voters: string[];
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      aria-pressed={chosen}
      title={voters.length ? voters.join(', ') : undefined}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 40,
        padding: '0 12px',
        border: `1px solid ${strong ? palette.ink.strong : palette.surface.line}`,
        borderRadius: 8,
        background: palette.surface.card,
        font: 'inherit',
        fontSize: 14,
        color: palette.ink.body,
        textAlign: 'left',
        // A closed question is still for reading, so it should not look greyed out.
        opacity: 1,
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          width: `${share * 100}%`,
          background: strong ? palette.accent.soft : palette.surface.sunken,
          transition: 'width .3s ease',
        }}
      />
      {radio && (
        <span
          aria-hidden
          style={{
            position: 'relative',
            width: 14,
            height: 14,
            flexShrink: 0,
            borderRadius: 999,
            border: `1.5px solid ${chosen ? palette.ink.strong : palette.surface.lineStrong}`,
            background: chosen ? palette.ink.strong : 'none',
            boxShadow: chosen ? `inset 0 0 0 2px ${palette.surface.card}` : 'none',
          }}
        />
      )}
      <span
        style={{
          ...ui.ellipsis,
          position: 'relative',
          flex: 1,
          minWidth: 0,
          fontWeight: strong ? (radio ? 500 : 600) : 400,
        }}
      >
        {label}
      </span>
      <span
        style={{
          position: 'relative',
          fontSize: 12,
          color: palette.ink.muted,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {count}
      </span>
    </button>
  );
}

/** A title and its options — more on demand, blanks dropped — with room for more fields */
export function OptionsForm({
  initialTitle = '',
  initialOptions = ['', ''],
  placeholder,
  label,
  submit,
  submitting,
  extra,
  valid = true,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string;
  initialOptions?: string[];
  placeholder: string;
  label: string;
  submit: string;
  submitting: string;
  extra?: ReactNode;
  valid?: boolean;
  onSubmit: (title: string, options: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [options, setOptions] = useState(initialOptions);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const unique = new Set(filled).size === filled.length;
  const ready = valid && title.trim() && filled.length >= 2 && unique;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onSubmit(title.trim(), filled).finally(() => setBusy(false));
      }}
      style={{ ...box, gap: 8 }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        style={styles.input}
      />
      {options.map((option, i) => (
        <input
          key={i}
          value={option}
          onChange={(e) => setOptions((was) => was.map((o, j) => (j === i ? e.target.value : o)))}
          placeholder={`Option ${i + 1}`}
          aria-label={`Option ${i + 1}`}
          style={styles.input}
        />
      ))}
      {extra}
      {!unique && <p style={{ fontSize: 13, color: palette.accent.danger }}>Two options are the same.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((was) => [...was, ''])}
            data-variant="quiet"
            style={styles.smallButton}
          >
            + Add option
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCancel} data-variant="quiet" style={styles.smallButton}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready || busy}
          data-variant="primary"
          style={{ ...styles.addButton, height: 32 }}
        >
          {busy ? submitting : submit}
        </button>
      </div>
    </form>
  );
}
