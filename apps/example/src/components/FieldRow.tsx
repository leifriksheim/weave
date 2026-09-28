import { FIELD_TYPES, isFieldType, type FieldTypeName } from '../derive/field-types';
import { styles, palette } from '../styles';

/** A field as the forms that define a collection edit it */
interface FieldRowValue {
  name: string;
  /** Null for a field of a shape the form doesn't offer — kept exactly as it is */
  type: FieldTypeName | null;
  required: boolean;
  options?: string;
}

/** One field of a collection being defined or changed: its name, type, whether it is required, and a choice's options */
export function FieldRow({
  field,
  index,
  onChange,
  onRemove,
}: {
  field: FieldRowValue;
  index: number;
  onChange: (
    patch: Partial<{ name: string; type: FieldTypeName; required: boolean; options: string }>,
  ) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <input
        aria-label={`Field ${n} name`}
        value={field.name}
        onChange={(e) => onChange({ name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
        placeholder="field name"
        style={{ ...styles.input, flex: 1 }}
      />
      {field.type === null ? (
        <span style={{ fontSize: 13, color: palette.ink.faint, padding: '0 8px' }}>kept as it is</span>
      ) : (
        <select
          aria-label={`Field ${n} type`}
          value={field.type}
          onChange={(e) => {
            const type = e.target.value;
            if (isFieldType(type)) onChange({ type });
          }}
          style={styles.input}
        >
          {Object.keys(FIELD_TYPES).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      )}
      <label style={{ fontSize: 12, display: 'flex', gap: 4 }}>
        <input
          type="checkbox"
          checked={field.required}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        required
      </label>
      <button
        type="button"
        onClick={onRemove}
        data-variant="ghost"
        style={styles.linkButton}
        aria-label={`Remove field ${n}`}
      >
        ✕
      </button>
      {field.type === 'choice' && (
        <input
          aria-label={`Field ${n} options`}
          value={field.options ?? ''}
          onChange={(e) => onChange({ options: e.target.value })}
          placeholder="Options, separated by commas: To do, Doing, Done"
          style={{ ...styles.input, flexBasis: '100%' }}
        />
      )}
    </div>
  );
}
