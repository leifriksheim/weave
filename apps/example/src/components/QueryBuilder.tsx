import type { CSSProperties } from 'react';
import type { Query } from '@weaveprotocol/core';
import {
  conditionOn,
  needsValue,
  opsFor,
  type Condition,
  type FilterField,
  type Op,
  type Sort,
} from '../derive/filters';
import { nameOf, type People } from '../derive/people';
import { styles, palette } from '../styles';

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Filters, order and page size for one collection, picked rather than
 * typed. The fields and what each can be compared with come from the
 * collection's schema; the query it makes is shown underneath, the same
 * JSON the Query tab takes.
 */
export function QueryBuilder({
  fields,
  sortable,
  conditions,
  onConditions,
  sort,
  onSort,
  pageSize,
  onPageSize,
  people,
  query,
}: {
  fields: ReadonlyArray<FilterField>;
  sortable: ReadonlyArray<FilterField>;
  conditions: ReadonlyArray<Condition>;
  onConditions: (next: ReadonlyArray<Condition>) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  pageSize: number;
  onPageSize: (next: number) => void;
  people: People;
  query: Query;
}) {
  const nextId = Math.max(0, ...conditions.map((c) => c.id)) + 1;
  const change = (id: number, next: Partial<Condition>) =>
    onConditions(conditions.map((c) => (c.id === id ? { ...c, ...next } : c)));
  const first = fields[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {first && (
          <button
            onClick={() => onConditions([...conditions, conditionOn(first, nextId)])}
            data-variant="quiet"
            style={{ ...styles.smallButton, height: 32 }}
          >
            + Filter
          </button>
        )}
        {conditions.length > 0 && (
          <button
            onClick={() => onConditions([])}
            data-variant="quiet"
            style={{ ...styles.smallButton, height: 32, color: palette.ink.muted }}
          >
            Clear filters
          </button>
        )}
        <span style={{ flex: 1 }} />
        <label style={labelStyle}>
          Sort by
          <select
            value={sort.field}
            onChange={(e) => onSort({ ...sort, field: e.target.value })}
            style={select}
          >
            {sortable.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={sort.direction}
            onChange={(e) => onSort({ ...sort, direction: e.target.value === 'asc' ? 'asc' : 'desc' })}
            aria-label="Direction"
            style={select}
          >
            <option value="desc">{directionLabel(sortable, sort.field, 'desc')}</option>
            <option value="asc">{directionLabel(sortable, sort.field, 'asc')}</option>
          </select>
        </label>
        <label style={labelStyle}>
          Per page
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} style={select}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {conditions.length > 0 && (
        <div
          role="group"
          aria-label="Filters"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 10,
            border: `1px solid ${palette.surface.line}`,
            borderRadius: 10,
            background: palette.surface.sunken,
          }}
        >
          {conditions.map((condition, i) => {
            const field = fields.find((f) => f.name === condition.field) ?? first;
            if (!field) return null;
            return (
              <div
                key={condition.id}
                style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <span style={{ width: 40, fontSize: 12, color: palette.ink.faint }}>
                  {i === 0 ? 'Where' : 'and'}
                </span>
                <select
                  value={field.name}
                  aria-label="Field"
                  onChange={(e) => {
                    const next = fields.find((f) => f.name === e.target.value);
                    if (next) change(condition.id, conditionOn(next, condition.id));
                  }}
                  style={select}
                >
                  {fields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  value={condition.op}
                  aria-label="Comparison"
                  onChange={(e) => {
                    const op = opsFor(field.kind).find((o) => o.op === e.target.value)?.op;
                    if (op) change(condition.id, { op });
                  }}
                  style={select}
                >
                  {opsFor(field.kind).map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {needsValue(condition.op) && (
                  <ValueInput
                    field={field}
                    op={condition.op}
                    value={condition.value}
                    people={people}
                    onChange={(value) => change(condition.id, { value })}
                  />
                )}
                <button
                  onClick={() => onConditions(conditions.filter((c) => c.id !== condition.id))}
                  aria-label={`Remove filter on ${field.label}`}
                  data-variant="quiet"
                  style={{ ...styles.smallButton, height: 30, width: 30, padding: 0 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <details>
        <summary style={{ fontSize: 12, color: palette.ink.faint, cursor: 'pointer' }}>As a query</summary>
        <pre
          style={{
            margin: '6px 0 0',
            padding: '10px 12px',
            fontFamily: palette.mono,
            fontSize: 12,
            lineHeight: 1.6,
            overflowX: 'auto',
            border: `1px solid ${palette.surface.line}`,
            borderRadius: 8,
            background: palette.surface.sunken,
          }}
        >
          {JSON.stringify(query, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** "Newest first" for times, "A → Z" for text, "Low → high" for numbers */
function directionLabel(fields: ReadonlyArray<FilterField>, name: string, direction: 'asc' | 'desc'): string {
  const kind = fields.find((f) => f.name === name)?.kind;
  const asc = direction === 'asc';
  switch (kind) {
    case 'date':
      return asc ? 'Oldest first' : 'Newest first';
    case 'text':
      return asc ? 'A → Z' : 'Z → A';
    case 'boolean':
      return asc ? 'No first' : 'Yes first';
    default:
      return asc ? 'Low → high' : 'High → low';
  }
}

/** The input for a condition's value, as the field's kind wants it */
function ValueInput({
  field,
  op,
  value,
  people,
  onChange,
}: {
  field: FilterField;
  op: Op;
  value: string;
  people: People;
  onChange: (value: string) => void;
}) {
  const label = `${field.label} ${op}`;
  switch (field.kind) {
    case 'boolean':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={select}>
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      );
    case 'choice':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={select}>
          {(field.choices ?? []).map((c, i) => (
            <option key={i} value={String(i)}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'person':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} style={select}>
          <option value="">Pick someone</option>
          {[...people.keys()].map((did) => (
            <option key={did} value={did}>
              {nameOf(did, people)}
            </option>
          ))}
        </select>
      );
    case 'date':
      return (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          style={{ ...select, width: 150 }}
        />
      );
    default:
      return (
        <input
          type={field.kind === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Value"
          aria-label={label}
          style={{ ...select, width: 160 }}
        />
      );
  }
}

const select: CSSProperties = { ...styles.input, height: 30, fontSize: 13, width: 'auto', padding: '0 8px' };
const labelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  color: palette.ink.muted,
};
