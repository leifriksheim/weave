import { useState, type FormEvent } from 'react';
import type { JsonSchema } from '@p2p-web/protocol';
import { choicesOf, emptyValue, fieldsOf, type Field, type LinkedByRel } from '../derive/schema-ui';
import { styles } from '../styles';

/**
 * A form for a record, drawn from its collection's schema. Without a schema,
 * the body is edited as JSON. The node checks the result against the schema
 * when it is written, so the form only has to be helpful, not strict.
 */
export function SchemaForm({
  schema,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  linked = {},
}: {
  schema: JsonSchema | null;
  initial?: unknown;
  /** The records this one links to, by role — where `x-choicesFrom` finds its options */
  linked?: LinkedByRel;
  submitLabel: string;
  onSubmit: (body: unknown) => Promise<void>;
  onCancel?: () => void;
}) {
  const fields = fieldsOf(schema);
  const [value, setValue] = useState<Record<string, unknown>>(() =>
    (initial as Record<string, unknown>) ?? Object.fromEntries(fields.map((f) => [f.name, emptyValue(f)])),
  );
  const [json, setJson] = useState(() => JSON.stringify(initial ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let body: unknown;
    try {
      body = fields.length > 0 ? clean(value) : JSON.parse(json);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ ...styles.form, gap: 12 }}>
      {fields.length === 0 ? (
        <label style={labelStyle}>
          <span>Body (JSON) — this kind of thing has no schema</span>
          <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={6} style={{ ...styles.input, fontFamily: 'monospace' }} />
        </label>
      ) : (
        fields.map((field) => (
          <FieldInput key={field.name} field={field} linked={linked} value={value[field.name]} onChange={(v) => setValue((old) => ({ ...old, [field.name]: v }))} />
        ))
      )}
      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.linkRow}>
        <button type="submit" disabled={busy} data-variant="primary" style={styles.addButton}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} data-variant="ghost" style={styles.linkButton}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const labelStyle = { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 13 };

function FieldInput({ field, value, onChange, linked = {} }: { field: Field; value: unknown; onChange: (value: unknown) => void; linked?: LinkedByRel }) {
  const label = (
    <span>
      {field.label}
      {field.required && ' *'}
      {typeof field.schema.description === 'string' && <span style={{ opacity: 0.6 }}> — {field.schema.description}</span>}
    </span>
  );

  switch (field.kind) {
    case 'boolean':
      return (
        <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case 'choice': {
      const choices = choicesOf(field, linked);
      // Choices from a linked record that is not here: fall back to a plain input for the type.
      if (!choices) return <FieldInput field={{ ...field, kind: field.schema.type === 'integer' ? 'integer' : field.schema.type === 'number' ? 'number' : 'text' }} value={value} onChange={onChange} />;
      const selected = choices.findIndex((c) => c.value === value);
      return (
        <label style={labelStyle}>
          {label}
          <select value={selected < 0 ? '' : String(selected)} onChange={(e) => onChange(e.target.value === '' ? undefined : choices[Number(e.target.value)]?.value)} style={styles.input}>
            <option value="">—</option>
            {choices.map((choice, i) => (
              <option key={i} value={String(i)}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case 'number':
    case 'integer':
      return (
        <label style={labelStyle}>
          {label}
          <input
            type="number"
            step={field.kind === 'integer' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            style={styles.input}
          />
        </label>
      );
    case 'longText':
      return (
        <label style={labelStyle}>
          {label}
          <textarea value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} rows={4} style={styles.input} />
        </label>
      );
    case 'list':
      return <ListInput field={field} label={label} value={Array.isArray(value) ? value : []} onChange={onChange} />;
    case 'object':
      return (
        <fieldset style={{ ...labelStyle, border: '1px solid #e6e8ec', borderRadius: 8, padding: 10 }}>
          <legend>{label}</legend>
          {fieldsOf(field.schema).map((sub) => (
            <FieldInput
              key={sub.name}
              field={sub}
              value={(value as Record<string, unknown> | undefined)?.[sub.name]}
              onChange={(v) => onChange({ ...((value as object) ?? {}), [sub.name]: v })}
            />
          ))}
        </fieldset>
      );
    case 'json':
      return <JsonInput label={label} value={value} onChange={onChange} />;
    default:
      return (
        <label style={labelStyle}>
          {label}
          <input type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} style={styles.input} />
        </label>
      );
  }
}

/** A list of short values: one box each, plus one to add */
function ListInput({ field, label, value, onChange }: { field: Field; label: React.ReactNode; value: unknown[]; onChange: (value: unknown) => void }) {
  const numeric = ((field.schema.items ?? {}) as JsonSchema).type !== 'string';
  const parse = (raw: string) => (numeric ? Number(raw) : raw);
  return (
    <div style={labelStyle}>
      {label}
      {value.map((item, index) => (
        <div key={index} style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label={`${field.label} ${index + 1}`}
            type={numeric ? 'number' : 'text'}
            value={String(item ?? '')}
            onChange={(e) => onChange(value.map((old, i) => (i === index ? parse(e.target.value) : old)))}
            style={{ ...styles.input, flex: 1 }}
          />
          <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))} data-variant="ghost" style={styles.linkButton} aria-label={`Remove ${field.label} ${index + 1}`}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...value, numeric ? 0 : ''])} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start' }}>
        + Add {field.label.toLowerCase()}
      </button>
    </div>
  );
}

function JsonInput({ label, value, onChange }: { label: React.ReactNode; value: unknown; onChange: (value: unknown) => void }) {
  const [raw, setRaw] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  return (
    <label style={labelStyle}>
      {label}
      <textarea
        value={raw}
        rows={3}
        onChange={(e) => {
          setRaw(e.target.value);
          try {
            onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
          } catch {
            /* keep typing */
          }
        }}
        style={{ ...styles.input, fontFamily: 'monospace' }}
      />
    </label>
  );
}

/** Drops fields left empty, so an optional field is absent rather than "" */
function clean(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== ''));
}
