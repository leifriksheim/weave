import { useState } from 'react';
import { labelOf, type Field, type LinkedByRel } from '../derive/schema-ui';
import { styles, palette } from '../styles';

/** Text longer than this folds away behind "Show": a screen's HTML is a field too */
const LONG = 400;
/** Nested data this deep is shown as JSON: past it, indentation stops helping */
const DEEPEST = 5;

/**
 * A field's value, read-only, in whatever form suits its kind — a choice by its label, not its stored value.
 * `compact` is for a table cell or a card line: nested data as a count, long text cut short.
 */
export function Value({
  field,
  value,
  linked,
  compact = false,
}: {
  field?: Field;
  value: unknown;
  linked?: LinkedByRel;
  compact?: boolean;
}) {
  if (value === undefined || value === null || value === '') return <span style={{ opacity: 0.4 }}>—</span>;
  const label = field ? labelOf(field, value, linked) : null;
  if (label !== null) return <span>{label}</span>;
  return <Plain value={value} compact={compact} longText={field?.kind === 'longText'} depth={0} />;
}

function Plain({
  value,
  compact,
  longText,
  depth,
}: {
  value: unknown;
  compact: boolean;
  longText: boolean;
  depth: number;
}) {
  if (value === undefined || value === null || value === '') return <span style={{ opacity: 0.4 }}>—</span>;
  if (typeof value === 'boolean') return <span>{value ? '✓ yes' : '✗ no'}</span>;
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object'))
    return <span>{value.join(', ')}</span>;
  if (typeof value === 'object') {
    const count = Array.isArray(value) ? value.length : Object.keys(value).length;
    if (compact)
      return (
        <span style={{ color: palette.ink.muted }}>
          {Array.isArray(value)
            ? `${count} ${count === 1 ? 'item' : 'items'}`
            : `${count} ${count === 1 ? 'field' : 'fields'}`}
        </span>
      );
    if (depth >= DEEPEST) {
      return (
        <code style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(value, null, 2)}
        </code>
      );
    }
    return Array.isArray(value) ? (
      <Items items={value} depth={depth} />
    ) : (
      <Fields entries={Object.entries(value)} depth={depth} />
    );
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value))
    return <span>{new Date(value).toLocaleString()}</span>;
  if (typeof value === 'string' && value.length > LONG)
    return compact ? <span>{value.slice(0, 80)}…</span> : <LongText text={value} />;
  if (longText) return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}

/** An object's fields, one per line, each value shown the same way — nested as deep as it goes */
function Fields({ entries, depth }: { entries: ReadonlyArray<[string, unknown]>; depth: number }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(80px, max-content) 1fr',
        gap: '4px 12px',
        margin: 0,
        minWidth: 0,
      }}
    >
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={{ fontSize: 12, color: palette.ink.muted, paddingTop: 1 }}>{key}</dt>
          <dd style={{ margin: 0, minWidth: 0, wordBreak: 'break-word' }}>
            <Plain value={value} compact={false} longText={false} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A list of objects, each set apart by a rule on its left */
function Items({ items, depth }: { items: ReadonlyArray<unknown>; depth: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {items.map((item, i) => (
        <div
          key={i}
          style={{ borderLeft: `2px solid ${palette.surface.line}`, paddingLeft: 10, minWidth: 0 }}
        >
          <Plain value={item} compact={false} longText={false} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

/** Long text folded away, with its size, until asked for */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const size = new TextEncoder().encode(text).length;
  const kb = size >= 1024 ? `${Math.round(size / 1024)} KB` : `${size} bytes`;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ color: palette.ink.muted }}>
        {open ? null : `${text.slice(0, 120).replace(/\s+/g, ' ')}…`}{' '}
        <button
          onClick={() => setOpen((was) => !was)}
          data-variant="ghost"
          style={{ ...styles.linkButton, padding: 0, fontSize: 12 }}
        >
          {open ? 'Hide' : `Show (${kb})`}
        </button>
      </span>
      {open && (
        <pre
          style={{
            maxHeight: 280,
            overflow: 'auto',
            margin: 0,
            padding: 8,
            fontSize: 11,
            lineHeight: 1.45,
            background: palette.surface.sunken,
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </pre>
      )}
    </span>
  );
}
