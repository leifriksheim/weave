import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { DefineCollection, JsonSchema, NodeCollection } from '@weaveprotocol/core';
import { collectionLabel, humanize, isObject } from '../derive/schema-ui';
import {
  FIELD_TYPES,
  FIELD_TYPE_INFO,
  SUGGESTED_LINKS,
  fieldNameFrom,
  fieldSchema,
  fieldTypeOf,
  isFieldType,
  relFrom,
  type FieldTypeName,
} from '../derive/field-types';
import { SchemaForm } from './SchemaForm';
import { styles, palette } from '../styles';

type LinkDeclaration = NonNullable<DefineCollection['links']>[string];

/** A field as the designer edits it */
interface FieldDraft {
  readonly id: number;
  /** The name it is stored under, for a field that already exists: kept, so its records keep their values */
  readonly was?: string;
  label: string;
  /** Null for a field of a shape the designer doesn't offer — kept exactly as it is */
  type: FieldTypeName | null;
  options: ReadonlyArray<string>;
  required: boolean;
  /** The field's schema as it stands */
  readonly original?: JsonSchema;
}

interface LinkDraft {
  readonly id: number;
  readonly was?: string;
  label: string;
  description: string;
  /** Empty means anything */
  to: ReadonlyArray<string>;
  many: boolean;
}

/** Who may change a record once it's there, in the two ways people mean it */
type Who = 'anyone' | 'creator';

/** Where a new collection starts: a few fields that thing usually has */
const TEMPLATES: ReadonlyArray<{
  title: string;
  /** What one of them is called, for the name when none is typed yet */
  thing?: string;
  fields: ReadonlyArray<{ label: string; type: FieldTypeName; required?: boolean; options?: string[] }>;
}> = [
  { title: 'Blank', fields: [{ label: 'Title', type: 'text', required: true }] },
  {
    title: 'To-do',
    thing: 'Task',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'Done', type: 'yes/no' },
      { label: 'Due', type: 'date' },
      { label: 'Assigned to', type: 'people' },
    ],
  },
  {
    title: 'Sign-up sheet',
    thing: 'Sign-up',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Slot', type: 'choice', options: ['Morning', 'Afternoon', 'Evening'] },
      { label: 'Note', type: 'long text' },
    ],
  },
  {
    title: 'Reading list',
    thing: 'Book',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'Author', type: 'text' },
      { label: 'Link', type: 'web link' },
      { label: 'Status', type: 'choice', options: ['Want to read', 'Reading', 'Finished'] },
      { label: 'Rating', type: 'whole number' },
    ],
  },
  {
    title: 'Event',
    thing: 'Event',
    fields: [
      { label: 'Title', type: 'text', required: true },
      { label: 'When', type: 'date', required: true },
      { label: 'Where', type: 'text' },
      { label: 'Host', type: 'person' },
    ],
  },
];

let nextId = 0;
const id = () => ++nextId;

function draftsFrom(collection: NodeCollection | null): FieldDraft[] {
  if (!collection)
    return TEMPLATES[0]!.fields.map((f) => ({
      id: id(),
      label: f.label,
      type: f.type,
      options: [],
      required: !!f.required,
    }));
  const schema = collection.schema ?? {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const s = isObject(value) ? value : {};
    return {
      id: id(),
      was: name,
      label: typeof s.title === 'string' ? s.title : humanize(name),
      type: fieldTypeOf(s),
      options: Array.isArray(s.enum) ? s.enum.map(String) : [],
      required: required.has(name),
      original: s,
    };
  });
}

/** The name a field is stored under: its old one, or one made from what it's called */
const storedName = (field: FieldDraft) => field.was ?? fieldNameFrom(field.label);

/** A field's schema: kept exactly when nothing about its shape changed, else made from the picked type */
function schemaOf(field: FieldDraft): JsonSchema {
  const same =
    field.original &&
    field.type === fieldTypeOf(field.original) &&
    (field.type !== 'choice' ||
      JSON.stringify(field.options) ===
        JSON.stringify(Array.isArray(field.original.enum) ? field.original.enum : null));
  const base: JsonSchema =
    same || field.type === null ? { ...field.original } : fieldSchema(field.type, field.options);
  const name = storedName(field);
  const { title: _title, ...rest } = base;
  // A title only when the name alone wouldn't say it: "Assigned to" for `assignedTo` needs none.
  return field.label.trim() && field.label.trim() !== humanize(name)
    ? { ...rest, title: field.label.trim() }
    : rest;
}

/**
 * What a collection is, made or changed by someone who has never seen a
 * schema: its name, its fields as things people recognise (a date, a
 * person, a choice), what it can point at, and who may change it — with a
 * preview of the form everyone will fill in. It writes an ordinary
 * definition, JSON Schema and all; anything it doesn't understand is kept
 * as it was.
 */
export function CollectionDesigner({
  collection,
  collections,
  onSave,
  onCancel,
  onDelete,
  cannotDelete,
}: {
  /** The collection being changed; null to make one */
  collection: NodeCollection | null;
  collections: ReadonlyArray<NodeCollection>;
  onSave: (definition: DefineCollection) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  /** Why it can't be deleted, when it can't */
  cannotDelete?: string | null;
}) {
  const making = collection === null;
  const [title, setTitle] = useState(collection ? collectionLabel(collection) : '');
  const [description, setDescription] = useState(collection?.description ?? '');
  const [fields, setFields] = useState<FieldDraft[]>(() => draftsFrom(collection));
  const [links, setLinks] = useState<LinkDraft[]>(() =>
    Object.entries(collection?.links ?? {}).map(([rel, d]) => ({
      id: id(),
      was: rel,
      label: humanize(rel).toLowerCase(),
      description: d.description ?? '',
      to: d.to === '*' ? [] : [...d.to],
      many: d.cardinality !== 'one',
    })),
  );
  const [who, setWho] = useState<Who>(
    collection ? (collection.rules.edit === 'creator' ? 'creator' : 'anyone') : 'creator',
  );
  const [onePer, setOnePer] = useState(false);
  const [template, setTemplate] = useState('Blank');
  const [picking, setPicking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = useRef(new Map<number, HTMLInputElement>());

  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const name = collection?.name ?? `app.${slug || 'thing'}`;
  const thing = (title.trim() || 'entry').toLowerCase();
  const targets = collections.filter((c) => c.schema !== null && c.version !== null && c.name !== name);
  const about = links.find((l) => relFrom(l.label) === 'about' && !l.many && l.to.length > 0);

  const setField = (fid: number, patch: Partial<FieldDraft>) =>
    setFields((all) => all.map((f) => (f.id === fid ? { ...f, ...patch } : f)));
  const setLink = (lid: number, patch: Partial<LinkDraft>) =>
    setLinks((all) => all.map((l) => (l.id === lid ? { ...l, ...patch } : l)));
  const move = (fid: number, by: -1 | 1) =>
    setFields((all) => {
      const at = all.findIndex((f) => f.id === fid);
      const to = at + by;
      if (at < 0 || to < 0 || to >= all.length) return all;
      const next = [...all];
      [next[at], next[to]] = [next[to]!, next[at]!];
      return next;
    });
  const addField = () => {
    const fresh: FieldDraft = { id: id(), label: '', type: 'text', options: [], required: false };
    setFields((all) => [...all, fresh]);
    globalThis.setTimeout(() => labels.current.get(fresh.id)?.focus(), 0);
  };
  const applyTemplate = (picked: (typeof TEMPLATES)[number]) => {
    setTemplate(picked.title);
    setFields(
      picked.fields.map((f) => ({
        id: id(),
        label: f.label,
        type: f.type,
        options: f.options ?? [],
        required: !!f.required,
      })),
    );
    if (!title.trim() && picked.thing) setTitle(picked.thing);
  };

  const named = fields.filter((f) => f.label.trim() || f.was);
  const schema: JsonSchema = {
    ...(collection?.schema ?? { type: 'object' }),
    type: 'object',
    properties: Object.fromEntries(named.map((f) => [storedName(f), schemaOf(f)])),
    required: named.filter((f) => f.required).map(storedName),
  };

  const problem = (): string | null => {
    if (!title.trim()) return 'Give it a name';
    if (named.length === 0) return 'Give it at least one field';
    const names = named.map(storedName);
    const bad = named.find((f) => !storedName(f));
    if (bad) return `“${bad.label}” needs a name with a letter in it`;
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return `Two fields would both be called “${twice}”`;
    const empty = named.find((f) => f.type === 'choice' && f.options.length === 0);
    if (empty) return `Give “${empty.label}” some options to choose from`;
    const rels = links.map((l) => relFrom(l.label));
    if (rels.some((r) => !r)) return 'Every connection needs a name';
    if (new Set(rels).size !== rels.length) return 'Two connections have the same name';
    if (making && collections.some((c) => c.name === name))
      return `There is already a collection called ${title.trim()}`;
    return null;
  };

  const save = async () => {
    setError(null);
    const why = problem();
    if (why) return setError(why);
    const nextLinks: Record<string, LinkDeclaration> = Object.fromEntries(
      links.map((l) => [
        relFrom(l.label),
        {
          to: l.to.length ? [...l.to] : '*',
          cardinality: l.many ? 'many' : 'one',
          ...(l.description.trim() ? { description: l.description.trim() } : {}),
        },
      ]),
    );
    const { edit: _edit, delete: _delete, ...otherRules } = collection?.rules ?? {};
    const rules = {
      ...otherRules,
      ...(who === 'creator'
        ? { edit: 'creator' as const, delete: ['creator' as const, 'can:moderate' as const] }
        : {}),
      ...(making && about && onePer ? { onePer: ['@author', 'link:about'] } : {}),
    };
    const permissions = [
      ...new Set([...(collection?.permissions ?? []), ...(who === 'creator' ? ['moderate'] : [])]),
    ];
    setBusy(true);
    try {
      await onSave({
        name,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        schema,
        ...(collection ? { history: collection.history } : {}),
        links: nextLinks,
        permissions,
        rules,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="designer" style={{ display: 'grid', gap: 28, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, minWidth: 0 }}>
        <section style={section}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={making ? 'What are you keeping track of? A book, a chore, an idea…' : 'Name'}
            aria-label="Name"
            autoFocus={making}
            style={{ ...styles.input, height: 48, fontSize: 18, fontWeight: 600 }}
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A sentence on what it is (optional)"
            aria-label="Description"
            style={styles.input}
          />
          {making && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12.5, color: palette.ink.faint, marginRight: 2 }}>Start from</span>
              {TEMPLATES.map((t) => (
                <button
                  key={t.title}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  aria-pressed={template === t.title}
                  data-variant="quiet"
                  style={{
                    ...chip,
                    ...(template === t.title
                      ? { borderColor: palette.ink.strong, color: palette.ink.strong }
                      : {}),
                  }}
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </section>

        <section style={section}>
          <Heading title="Fields" about={`What every ${thing} has.`} />
          <ol
            style={{
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 0,
              margin: 0,
            }}
          >
            {fields.map((field, i) => (
              <li key={field.id} style={fieldCard}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <button
                      type="button"
                      onClick={() => move(field.id, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${field.label || 'field'} up`}
                      style={nudge}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => move(field.id, 1)}
                      disabled={i === fields.length - 1}
                      aria-label={`Move ${field.label || 'field'} down`}
                      style={nudge}
                    >
                      ▼
                    </button>
                  </div>
                  {field.type === null ? (
                    <span
                      title="A shape this editor doesn't offer: kept exactly as it is"
                      style={{ ...typeButton, cursor: 'default' }}
                    >
                      <span style={mark}>{'{}'}</span>
                      <span>as it is</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPicking(picking === field.id ? null : field.id)}
                      aria-expanded={picking === field.id}
                      aria-label={`Type of ${field.label || 'field'}: ${field.type}`}
                      style={typeButton}
                    >
                      <span style={mark}>{FIELD_TYPE_INFO[field.type].mark}</span>
                      <span>{field.type}</span>
                      <span style={{ color: palette.ink.faint, fontSize: 10 }}>▾</span>
                    </button>
                  )}
                  <input
                    ref={(el) => {
                      if (el) labels.current.set(field.id, el);
                      else labels.current.delete(field.id);
                    }}
                    value={field.label}
                    onChange={(e) => setField(field.id, { label: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addField();
                      }
                    }}
                    placeholder="What is it called?"
                    aria-label={`Field ${i + 1} name`}
                    title={storedName(field) ? `Stored as ${storedName(field)}` : undefined}
                    style={{ ...styles.input, flex: '1 1 180px', width: 'auto', minWidth: 0, height: 36 }}
                  />
                  <label style={toggle} title="Every one must have this filled in">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => setField(field.id, { required: e.target.checked })}
                    />
                    Must fill in
                  </label>
                  <button
                    type="button"
                    onClick={() => setFields((all) => all.filter((f) => f.id !== field.id))}
                    aria-label={`Remove ${field.label || `field ${i + 1}`}`}
                    data-variant="ghost"
                    style={styles.rowAction}
                  >
                    ✕
                  </button>
                </div>

                {picking === field.id && (
                  <div role="listbox" aria-label="Field type" style={typeGrid}>
                    {Object.keys(FIELD_TYPES)
                      .filter(isFieldType)
                      .map((type) => (
                        <button
                          key={type}
                          type="button"
                          role="option"
                          aria-selected={field.type === type}
                          onClick={() => {
                            setField(field.id, { type });
                            setPicking(null);
                          }}
                          style={{
                            ...typeTile,
                            ...(field.type === type
                              ? {
                                  borderColor: palette.ink.strong,
                                  boxShadow: `0 0 0 1px ${palette.ink.strong}`,
                                }
                              : {}),
                          }}
                        >
                          <span style={{ ...mark, width: 30, height: 30, fontSize: 13 }}>
                            {FIELD_TYPE_INFO[type].mark}
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <strong
                              style={{ fontSize: 13, color: palette.ink.strong, textTransform: 'capitalize' }}
                            >
                              {type}
                            </strong>
                            <span style={{ fontSize: 11.5, color: palette.ink.muted, lineHeight: 1.35 }}>
                              {FIELD_TYPE_INFO[type].hint}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                )}

                {field.type === 'choice' && (
                  <Options options={field.options} onChange={(options) => setField(field.id, { options })} />
                )}
                {field.was &&
                  field.original &&
                  field.type !== null &&
                  field.type !== fieldTypeOf(field.original) && (
                    <p style={{ fontSize: 12, color: palette.ink.muted, paddingLeft: 30 }}>
                      What's already written stays as it is; entries that don't fit the new type show as not
                      fitting.
                    </p>
                  )}
              </li>
            ))}
          </ol>
          <button type="button" onClick={addField} style={addField_}>
            + Add a field
          </button>
        </section>

        <section style={section}>
          <Heading
            title="Connections"
            about={`What one ${thing} can point at: the poll a vote is about, the project a task is part of.`}
          />
          {links.map((link) => (
            <div key={link.id} style={fieldCard}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, color: palette.ink.muted }}>Each {thing} is</span>
                <input
                  aria-label="Connection name"
                  value={link.label}
                  onChange={(e) => setLink(link.id, { label: e.target.value })}
                  placeholder="about, in, part of…"
                  style={{ ...styles.input, width: 150, height: 34 }}
                />
                <select
                  aria-label="How many"
                  value={link.many ? 'many' : 'one'}
                  onChange={(e) => setLink(link.id, { many: e.target.value === 'many' })}
                  style={{ ...styles.input, width: 'auto', height: 34 }}
                >
                  <option value="one">one</option>
                  <option value="many">any number of</option>
                </select>
                <select
                  aria-label="What it points at"
                  value={link.to.length === 1 ? link.to[0] : link.to.length === 0 ? '*' : 'several'}
                  onChange={(e) => setLink(link.id, { to: e.target.value === '*' ? [] : [e.target.value] })}
                  style={{ ...styles.input, width: 'auto', height: 34 }}
                >
                  <option value="*">anything</option>
                  {link.to.length > 1 && <option value="several">{link.to.length} kinds</option>}
                  {targets.map((c) => (
                    <option key={c.name} value={c.name}>
                      {collectionLabel(c).toLowerCase()}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setLinks((all) => all.filter((l) => l.id !== link.id))}
                  aria-label={`Remove connection ${link.label}`}
                  data-variant="ghost"
                  style={{ ...styles.rowAction, marginLeft: 'auto' }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTED_LINKS.filter((s) => !links.some((l) => relFrom(l.label) === s.rel)).map((s) => (
              <button
                key={s.rel}
                type="button"
                title={s.description}
                onClick={() =>
                  setLinks((all) => [
                    ...all,
                    {
                      id: id(),
                      label: humanize(s.rel).toLowerCase(),
                      description: s.description,
                      to: [],
                      many: s.rel !== 'about' && s.rel !== 'in' && s.rel !== 'partOf',
                    },
                  ])
                }
                data-variant="quiet"
                style={chip}
              >
                + {humanize(s.rel).toLowerCase()}
              </button>
            ))}
          </div>
        </section>

        <section style={section}>
          <Heading
            title="Who can do what"
            about="Every device in the space enforces this, not just this app."
          />
          <div style={styles.segmented} role="group" aria-label="Who can change one">
            {(
              [
                ['creator', 'Only whoever added it can change it'],
                ['anyone', 'Anyone in the space can change it'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={who === value}
                onClick={() => setWho(value)}
                style={who === value ? styles.segmentActive : styles.segment}
              >
                {label}
              </button>
            ))}
          </div>
          {making && about && (
            <label style={{ ...toggle, fontSize: 13.5 }}>
              <input type="checkbox" checked={onePer} onChange={(e) => setOnePer(e.target.checked)} />
              One per person, per{' '}
              {collectionLabel(
                targets.find((c) => c.name === about.to[0]) ?? { name: about.to[0] ?? 'record' },
              ).toLowerCase()}{' '}
              — adding again changes theirs
            </label>
          )}
          {!making && collection?.rules.onePer && (
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              One per{' '}
              {collection.rules.onePer
                .map((part) =>
                  part === '@author' ? 'person' : humanize(part.replace(/^link:/, '')).toLowerCase(),
                )
                .join(', per ')}
              .
            </p>
          )}
        </section>

        {!making && (
          <p style={{ fontSize: 12.5, color: palette.ink.faint, lineHeight: 1.5 }}>
            Changes reach everyone in the space and apply to what's written from now on. Nothing already
            written is changed or deleted. Stored as <code>{name}</code>.
          </p>
        )}
        {error && <p style={styles.error}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            data-variant="primary"
            style={{ ...styles.button, width: 'auto' }}
          >
            {busy ? 'Saving…' : making ? `Create ${title.trim() || 'collection'}` : 'Save changes'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-variant="quiet"
            style={{ ...styles.smallButton, height: 40 }}
          >
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={busy || !!cannotDelete}
              title={cannotDelete ?? undefined}
              data-variant="danger"
              style={{ ...styles.smallButton, height: 40, color: palette.accent.danger, marginLeft: 'auto' }}
            >
              Delete
            </button>
          )}
        </div>
        {cannotDelete && (
          <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: -16 }}>{cannotDelete}</p>
        )}
      </div>

      <aside aria-label="Preview" className="designer-preview" style={preview}>
        <p style={{ ...styles.fieldLabel, marginBottom: 2 }}>Preview</p>
        <p style={{ fontSize: 12.5, color: palette.ink.muted, marginBottom: 12 }}>
          The form for adding {title.trim() ? `a ${thing}` : 'one'}.
        </p>
        <fieldset disabled style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
          <SchemaForm
            key={JSON.stringify(schema)}
            schema={schema}
            submitLabel="Add"
            onSubmit={() => Promise.resolve()}
          />
        </fieldset>
      </aside>
    </div>
  );
}

/** A choice's options, as chips, and a box to add one: Enter or a comma adds what's typed */
function Options({
  options,
  onChange,
}: {
  options: ReadonlyArray<string>;
  onChange: (options: ReadonlyArray<string>) => void;
}) {
  const [typing, setTyping] = useState('');
  const add = () => {
    const fresh = typing
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o && !options.includes(o));
    if (fresh.length) onChange([...options, ...fresh]);
    setTyping('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !typing && options.length) {
      onChange(options.slice(0, -1));
    }
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingLeft: 30 }}>
      {options.map((option) => (
        <span key={option} style={optionChip}>
          {option}
          <button
            type="button"
            onClick={() => onChange(options.filter((o) => o !== option))}
            aria-label={`Remove ${option}`}
            style={{ border: 'none', background: 'none', padding: 0, color: palette.ink.faint, fontSize: 12 }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={typing}
        onChange={(e) => setTyping(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={options.length ? 'Add another…' : 'Type an option, then Enter'}
        aria-label="Add an option"
        style={{ ...styles.input, height: 30, width: 190, fontSize: 13 }}
      />
    </div>
  );
}

function Heading({ title, about }: { title: string; about: string }) {
  return (
    <div>
      <h3 style={{ ...styles.sectionTitle, fontSize: 15 }}>{title}</h3>
      <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>{about}</p>
    </div>
  );
}

const section: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const fieldCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 8,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
  background: palette.surface.card,
};
const nudge: CSSProperties = {
  border: 'none',
  background: 'none',
  color: palette.ink.faint,
  fontSize: 8,
  lineHeight: 1,
  padding: '2px 4px',
};
const typeButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  padding: '0 10px 0 4px',
  borderRadius: 8,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.sunken,
  color: palette.ink.body,
  fontSize: 13,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  minWidth: 138,
};
const mark: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 6,
  background: palette.surface.card,
  border: `1px solid ${palette.surface.line}`,
  fontSize: 12,
  fontWeight: 600,
  color: palette.ink.strong,
  flexShrink: 0,
};
const typeGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
  gap: 6,
  padding: 6,
  borderRadius: 8,
  background: palette.surface.sunken,
};
const typeTile: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: 8,
  borderRadius: 8,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.card,
  textAlign: 'left',
};
const toggle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  color: palette.ink.muted,
  whiteSpace: 'nowrap',
};
const chip: CSSProperties = { ...styles.smallButton, height: 28, borderRadius: 999, fontSize: 12.5 };
const optionChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 8px 0 10px',
  borderRadius: 999,
  background: palette.surface.sunken,
  border: `1px solid ${palette.surface.line}`,
  fontSize: 13,
  color: palette.ink.strong,
};
const addField_: CSSProperties = {
  height: 40,
  borderRadius: 10,
  border: `1px dashed ${palette.surface.lineStrong}`,
  background: 'none',
  color: palette.ink.muted,
  fontSize: 13.5,
  fontWeight: 500,
};
const preview: CSSProperties = {
  position: 'sticky',
  top: 0,
  padding: 16,
  borderRadius: 12,
  border: `1px solid ${palette.surface.line}`,
  background: palette.surface.sunken,
};
