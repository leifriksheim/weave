import type { Field } from '../derive/schema-ui';

/** A field's value, read-only, in whatever form suits its kind. */
export function Value({ field, value }: { field?: Field; value: unknown }) {
  if (value === undefined || value === null || value === '') return <span style={{ opacity: 0.4 }}>—</span>;
  if (typeof value === 'boolean') return <span>{value ? '✓ yes' : '✗ no'}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) return <span>{value.join(', ')}</span>;
  if (typeof value === 'object') {
    return <code style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(value, null, 2)}</code>;
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) return <span>{new Date(value).toLocaleString()}</span>;
  if (field?.kind === 'longText') return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}
