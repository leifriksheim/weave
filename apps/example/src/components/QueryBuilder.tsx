import type { CSSProperties } from 'react';
import type { Query } from '@weaveprotocol/core';
import type { Clause, ClauseField } from '../derive/conditions';
import type { Sort } from '../derive/filters';
import type { People } from '../derive/people';
import { ClauseList } from './automations/parts';
import { styles, palette, ui } from '../styles';

export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** Filters, order and page size for one collection, picked from its schema; the query they make shown underneath */
export function QueryBuilder({
  fields,
  clauses,
  onClauses,
  sort,
  onSort,
  pageSize,
  onPageSize,
  people,
  me,
  query,
}: {
  fields: ReadonlyArray<ClauseField>;
  clauses: ReadonlyArray<Clause>;
  onClauses: (next: ReadonlyArray<Clause>) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  pageSize: number;
  onPageSize: (next: number) => void;
  people: People;
  me: string | null;
  query: Query;
}) {
  // Record times first, then the fields that compare simply.
  const sortable = [
    ...fields.filter((f) => f.name.startsWith('@') && f.kind === 'date'),
    ...fields.filter(
      (f) => !f.name.startsWith('@') && ['search', 'number', 'yesno', 'choice'].includes(f.kind),
    ),
  ];

  return (
    <div style={{ ...ui.stack, gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <ClauseList
            fields={fields}
            clauses={clauses}
            onChange={onClauses}
            people={people}
            me={me}
            suggest={false}
            add="+ Filter"
          />
        </div>
        {clauses.length > 0 && (
          <button
            onClick={() => onClauses([])}
            data-variant="quiet"
            style={{ ...styles.smallButton, height: 30, color: palette.ink.muted }}
          >
            Clear filters
          </button>
        )}
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
function directionLabel(fields: ReadonlyArray<ClauseField>, name: string, direction: 'asc' | 'desc'): string {
  const kind = fields.find((f) => f.name === name)?.kind;
  const asc = direction === 'asc';
  switch (kind) {
    case 'date':
      return asc ? 'Oldest first' : 'Newest first';
    case 'search':
      return asc ? 'A → Z' : 'Z → A';
    case 'yesno':
      return asc ? 'No first' : 'Yes first';
    default:
      return asc ? 'Low → high' : 'High → low';
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
