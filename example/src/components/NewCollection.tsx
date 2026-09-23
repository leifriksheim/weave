import { useState, type FormEvent } from 'react';
import type { JsonSchema, NodeCollection, SpaceSummary } from '@p2p-web/protocol';
import { requireSession } from '../protocol';
import { useLive } from '../hooks/useLive';
import { collectionLabel } from '../derive/schema-ui';
import { styles } from '../styles';

const TYPES = {
  text: { type: 'string' },
  'long text': { type: 'string', maxLength: 10000 },
  number: { type: 'number' },
  'yes/no': { type: 'boolean' },
  'list of text': { type: 'array', items: { type: 'string' } },
} as const;
type TypeName = keyof typeof TYPES;

/**
 * Defines a kind of thing in the space: a name, some fields, and optionally
 * what it points at. The bare minimum a person needs without an agent —
 * everything else about how it is shown is worked out from this.
 */
export function NewCollection({ space, onDone }: { space: SpaceSummary; onDone: (name: string | null) => void }) {
  const { node } = requireSession();
  const existing = useLive(space.id, () => node.collections.list(space.id), []) ?? [];
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Array<{ name: string; type: TypeName; required: boolean }>>([{ name: 'title', type: 'text', required: true }]);
  const [pointsAt, setPointsAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const name = `app.${slug || 'thing'}`;
  const targets = existing.filter((c: NodeCollection) => !c.builtIn && c.schema !== null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const named = fields.filter((f) => f.name.trim());
    const schema: JsonSchema = {
      type: 'object',
      properties: Object.fromEntries(named.map((f) => [f.name.trim(), TYPES[f.type]])),
      required: named.filter((f) => f.required).map((f) => f.name.trim()),
    };
    try {
      await node.collections.define(space.id, {
        name,
        title: title.trim(),
        schema,
        ...(pointsAt ? { links: { about: { to: [pointsAt], cardinality: 'one' as const } } } : {}),
      });
      onDone(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form onSubmit={submit} style={{ ...styles.form, gap: 10, marginTop: 12 }} aria-label="Define a kind of thing">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it called? (e.g. Poll)" style={styles.input} required />
      <span style={styles.todoMeta}>
        Stored as <code>{name}</code>
      </span>
      {fields.map((field, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            aria-label={`Field ${i + 1} name`}
            value={field.name}
            onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') } : f)))}
            placeholder="field name"
            style={{ ...styles.input, flex: 1 }}
          />
          <select
            aria-label={`Field ${i + 1} type`}
            value={field.type}
            onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as TypeName } : f)))}
            style={styles.input}
          >
            {Object.keys(TYPES).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <label style={{ fontSize: 12, display: 'flex', gap: 4 }}>
            <input type="checkbox" checked={field.required} onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, required: e.target.checked } : f)))} />
            required
          </label>
          <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} data-variant="ghost" style={styles.linkButton} aria-label={`Remove field ${i + 1}`}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setFields([...fields, { name: '', type: 'text', required: false }])} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start' }}>
        + Add a field
      </button>
      {targets.length > 0 && (
        <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
          Each one is about… (optional)
          <select value={pointsAt} onChange={(e) => setPointsAt(e.target.value)} style={styles.input}>
            <option value="">— nothing in particular —</option>
            {targets.map((c) => (
              <option key={c.name} value={c.name}>
                {collectionLabel(c)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.linkRow}>
        <button type="submit" data-variant="primary" style={styles.addButton}>
          Define
        </button>
        <button type="button" onClick={() => onDone(null)} data-variant="ghost" style={styles.linkButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
