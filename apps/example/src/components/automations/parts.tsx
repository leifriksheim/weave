import type { CSSProperties, ReactNode } from 'react';
import {
  clauseOn,
  clauseWords,
  needsValue,
  opsFor,
  type Clause,
  type ClauseField,
} from '../../derive/conditions';
import { nameOf, type People } from '../../derive/people';
import { styles, palette } from '../../styles';

/**
 * The pieces the notification and rule builders share: a sentence made of
 * choices ("someone else adds a [task] in [this space]"), and the list of
 * "only when…" conditions under it, each picked from what the collection's
 * fields can hold. Native selects under the look, so they work with a
 * keyboard, a screen reader and a phone's own picker.
 */

/** One choice inside a sentence, drawn as a word you can change */
export function Pill<T extends string>({
  value,
  options,
  onChange,
  label,
  strong = true,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  label: string;
  strong?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const picked = options.find((option) => option.value === event.target.value);
        if (picked) onChange(picked.value);
      }}
      data-pill
      style={{ ...pill, fontWeight: strong ? 600 : 500 }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** A value to compare against, in the form its field takes */
export function ValueInput({
  field,
  clause,
  people,
  me,
  onChange,
}: {
  field: ClauseField;
  clause: Clause;
  people: People;
  me: string | null;
  onChange: (patch: Pick<Clause, 'value' | 'me'>) => void;
}) {
  const label = `${field.label}: value`;
  switch (field.kind) {
    case 'choice': {
      const choices = field.choices ?? [];
      const at = choices.findIndex((choice) => choice.value === clause.value);
      return (
        <Pill
          label={label}
          value={at < 0 ? '' : String(at)}
          options={[
            ...(at < 0 ? [{ value: '', label: 'pick one' }] : []),
            ...choices.map((choice, i) => ({ value: String(i), label: choice.label })),
          ]}
          onChange={(picked) => {
            const value = choices[Number(picked)]?.value;
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
              onChange({ value });
          }}
        />
      );
    }
    case 'person':
    case 'people': {
      const others = [...people.keys()].filter((did) => did !== me);
      return (
        <Pill
          label={label}
          value={clause.me ? 'me' : typeof clause.value === 'string' ? clause.value : 'me'}
          options={[
            { value: 'me', label: 'me' },
            ...others.map((did) => ({ value: did, label: nameOf(did, people) })),
          ]}
          onChange={(picked) => onChange(picked === 'me' ? { me: true } : { value: picked })}
        />
      );
    }
    case 'yesno':
      return (
        <Pill
          label={label}
          value={clause.value === false ? 'no' : 'yes'}
          options={[
            { value: 'yes', label: 'yes' },
            { value: 'no', label: 'no' },
          ]}
          onChange={(picked) => onChange({ value: picked === 'yes' })}
        />
      );
    case 'number':
      return (
        <input
          aria-label={label}
          type="number"
          value={typeof clause.value === 'number' ? clause.value : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? { value: undefined } : { value: Number(event.target.value) })
          }
          placeholder="0"
          style={{ ...box, width: 88 }}
        />
      );
    case 'date':
      return (
        <input
          aria-label={label}
          type="date"
          value={typeof clause.value === 'string' ? clause.value : ''}
          onChange={(event) => onChange({ value: event.target.value || undefined })}
          style={{ ...box, width: 150 }}
        />
      );
    default:
      return (
        <input
          aria-label={label}
          value={typeof clause.value === 'string' ? clause.value : ''}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder="some text"
          style={{ ...box, width: 160 }}
        />
      );
  }
}

/**
 * "Only when…": a condition per row, and a way to add one on any field. With
 * none yet, `suggest` offers a few the fields make likely — "assigned to me".
 */
export function ClauseList({
  fields,
  clauses,
  onChange,
  people,
  me,
  suggest = true,
  empty,
}: {
  fields: ReadonlyArray<ClauseField>;
  clauses: ReadonlyArray<Clause>;
  onChange: (clauses: ReadonlyArray<Clause>) => void;
  people: People;
  me: string | null;
  suggest?: boolean;
  /** Said when there are no conditions: what that means */
  empty?: string;
}) {
  const set = (i: number, next: Clause) => onChange(clauses.map((c, j) => (j === i ? next : c)));
  const unused = fields.filter((f) => !clauses.some((c) => c.field === f.name));
  const suggestions = suggest && clauses.length === 0 ? suggestionsFor(fields) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {clauses.length === 0 && empty && <p style={{ fontSize: 13, color: palette.ink.muted }}>{empty}</p>}
      {clauses.map((clause, i) => {
        const field = fields.find((f) => f.name === clause.field);
        if (!field) return null;
        const ops = opsFor(field.kind);
        return (
          <div key={`${clause.field}-${i}`} style={clauseRow}>
            <span style={{ fontSize: 13, color: palette.ink.faint, width: 34, flexShrink: 0 }}>
              {i === 0 ? 'where' : 'and'}
            </span>
            <Pill
              label={`Condition ${i + 1}: field`}
              value={clause.field}
              options={fields.map((f) => ({ value: f.name, label: f.label.toLowerCase() }))}
              onChange={(name) => {
                const next = fields.find((f) => f.name === name);
                if (next) set(i, clauseOn(next));
              }}
            />
            {ops.length > 1 ? (
              <Pill
                label={`Condition ${i + 1}: comparison`}
                strong={false}
                value={clause.op}
                options={ops.map((o) => ({ value: o.op, label: o.label }))}
                onChange={(op) => set(i, { ...clause, op })}
              />
            ) : (
              <span style={{ fontSize: 14, color: palette.ink.muted }}>is</span>
            )}
            {needsValue(clause.op) && (
              <ValueInput
                field={field}
                clause={clause}
                people={people}
                me={me}
                onChange={(patch) => {
                  const { value: _value, me: _me, ...rest } = clause;
                  set(i, { ...rest, ...patch });
                }}
              />
            )}
            <button
              type="button"
              onClick={() => onChange(clauses.filter((_, j) => j !== i))}
              aria-label={`Remove condition ${i + 1}`}
              data-variant="ghost"
              style={{ ...styles.rowAction, marginLeft: 'auto' }}
            >
              ✕
            </button>
          </div>
        );
      })}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {unused.length > 0 && (
          <label style={{ position: 'relative', display: 'inline-flex' }}>
            <span style={addButton}>+ Only when…</span>
            <select
              aria-label="Add a condition on"
              value=""
              onChange={(event) => {
                const field = fields.find((f) => f.name === event.target.value);
                if (field) onChange([...clauses, clauseOn(field)]);
              }}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            >
              <option value="">Add a condition on…</option>
              {unused.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {suggestions.map((clause) => (
          <button
            key={clauseWords(clause, fields)}
            type="button"
            onClick={() => onChange([clause])}
            data-variant="quiet"
            style={suggestion}
          >
            {clauseWords(clause, fields)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Conditions worth one click: "for me" on each people field, and the first option of each choice */
function suggestionsFor(fields: ReadonlyArray<ClauseField>): ReadonlyArray<Clause> {
  const mine = fields.filter((f) => f.kind === 'person' || f.kind === 'people').map(clauseOn);
  const choice = fields
    .filter((f) => f.kind === 'choice')
    .slice(0, 1)
    .flatMap((f) =>
      (f.choices ?? [])
        .slice(-1)
        .flatMap((c) =>
          typeof c.value === 'string' || typeof c.value === 'number'
            ? [{ ...clauseOn(f), value: c.value }]
            : [],
        ),
    );
  return [...mine, ...choice].slice(0, 3);
}

/** A numbered step of a builder: a short label on the left, what is picked on the right */
export function Step({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}
    >
      <span style={stepLabel}>{label}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** Text with pills inside it, wrapping like a sentence */
export function Sentence({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
        fontSize: 15,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

/** Where a builder's parts sit: one card */
export const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 16,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  background: palette.surface.card,
};

/** What a rule or notification would have caught, under the builder */
export const previewBox: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  background: palette.surface.sunken,
  border: `1px solid ${palette.surface.line}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  color: palette.ink.body,
};

const pill: CSSProperties = {
  height: 32,
  padding: '0 26px 0 12px',
  borderRadius: 999,
  border: `1px solid ${palette.surface.lineStrong}`,
  background: `${palette.surface.card} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23666' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center`,
  appearance: 'none',
  color: palette.ink.strong,
  fontSize: 14,
  maxWidth: '100%',
  cursor: 'pointer',
};

const box: CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 8,
  border: `1px solid ${palette.surface.lineStrong}`,
  background: palette.surface.card,
  color: palette.ink.strong,
  fontSize: 14,
};

const clauseRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  padding: '6px 6px 6px 10px',
  borderRadius: 10,
  background: palette.surface.sunken,
};

const addButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 30,
  padding: '0 12px',
  borderRadius: 999,
  border: `1px dashed ${palette.surface.lineStrong}`,
  color: palette.ink.muted,
  fontSize: 13,
  fontWeight: 500,
};

const suggestion: CSSProperties = {
  ...styles.smallButton,
  height: 30,
  borderRadius: 999,
  fontSize: 13,
  color: palette.ink.muted,
};

const stepLabel: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: palette.ink.faint,
  paddingTop: 8,
};
