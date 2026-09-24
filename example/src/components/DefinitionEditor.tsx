import { useState, type FormEvent } from 'react';
import { roleHolds } from 'weave-protocol';
import type { DefineCollection, JsonSchema, NodeCollection, SpaceSummary } from 'weave-protocol';
import { useAccess, useAccount, useNode, useProfiles } from 'weave-protocol/react';
import { collectionLabel, humanize } from '../derive/schema-ui';
import { FIELD_TYPES, SUGGESTED_LINKS, fieldSchema, fieldTypeOf, optionsOf, relFrom, type FieldTypeName } from '../derive/field-types';
import { nameOf, peopleFrom } from '../derive/people';
import { styles, palette } from '../styles';

type LinkDeclaration = NonNullable<DefineCollection['links']>[string];

interface FieldDraft {
  /** The name it had, for a field that already exists */
  readonly was?: string;
  name: string;
  /** Null for a field of a shape this form doesn't offer — kept exactly as it is */
  type: FieldTypeName | null;
  options: string;
  required: boolean;
  /** The field's schema as it stands, for one this form cannot re-make */
  readonly original?: JsonSchema;
}

interface LinkDraft {
  readonly was?: string;
  label: string;
  description: string;
  /** Empty means anything */
  to: string[];
  many: boolean;
}

/** Whether this account may change a collection's definition, and if not, why */
export function useMayRedefine(space: SpaceSummary, collection: NodeCollection | null): { may: boolean; reason: string } {
  const account = useAccount();
  const access = useAccess(space.id);
  const people = peopleFrom(useProfiles(space.id));
  if (!collection) return { may: false, reason: '' };
  if (collection.definedBy === account.did || roleHolds(access?.role, 'manage')) return { may: true, reason: '' };
  const definer = collection.definedBy ? nameOf(collection.definedBy, people) : 'whoever made it';
  return { may: false, reason: `Only ${definer}, or someone who manages the space, can change what ${collectionLabel(collection)} is.` };
}

/**
 * Changes what a collection is: its name, its fields, and the kinds of
 * link its records may carry. This is the schema, not any one record — a
 * change here reaches everyone's apps, and applies to records written from
 * then on. Anything this form doesn't understand is kept as it was.
 */
export function DefinitionEditor({
  space,
  collection,
  collections,
  onDone,
}: {
  space: SpaceSummary;
  collection: NodeCollection;
  collections: ReadonlyArray<NodeCollection>;
  onDone: () => void;
}) {
  const node = useNode();
  const schema = collection.schema ?? { type: 'object' };
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);

  const [title, setTitle] = useState(collectionLabel(collection));
  const [description, setDescription] = useState(collection.description ?? '');
  const [fields, setFields] = useState<FieldDraft[]>(() =>
    Object.entries(properties).map(([name, s]) => ({
      was: name,
      name,
      type: fieldTypeOf(s),
      options: Array.isArray(s.enum) ? s.enum.join(', ') : '',
      required: required.has(name),
      original: s,
    })),
  );
  const [links, setLinks] = useState<LinkDraft[]>(() =>
    Object.entries(collection.links).map(([rel, d]) => ({
      was: rel,
      label: humanize(rel).toLowerCase(),
      description: d.description ?? '',
      to: d.to === '*' ? [] : [...d.to],
      many: d.cardinality !== 'one',
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets = collections.filter((c) => c.schema !== null);
  const setField = (i: number, patch: Partial<FieldDraft>) => setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const setLink = (i: number, patch: Partial<LinkDraft>) => setLinks(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const unused = SUGGESTED_LINKS.filter((s) => !links.some((l) => relFrom(l.label) === s.rel));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const named = fields.filter((f) => f.name.trim());
    const empty = named.find((f) => f.type === 'choice' && optionsOf(f.options).length === 0);
    if (empty) return setError(`Give "${empty.name}" some options to choose from, separated by commas`);
    const rels = links.map((l) => relFrom(l.label));
    if (rels.some((r) => !r)) return setError('Every kind of link needs a name');
    if (new Set(rels).size !== rels.length) return setError('Two kinds of link have the same name');

    const nextSchema: JsonSchema = {
      ...schema,
      properties: Object.fromEntries(
        named.map((f) => {
          // Unchanged fields keep their schema exactly — titles, limits and all.
          const same = f.original && f.type === fieldTypeOf(f.original) && (f.type !== 'choice' || f.options === (f.original.enum as unknown[] | undefined)?.join(', '));
          return [f.name.trim(), same || f.type === null ? f.original! : fieldSchema(f.type, f.options)];
        }),
      ),
      required: named.filter((f) => f.required).map((f) => f.name.trim()),
    };
    const nextLinks: Record<string, LinkDeclaration> = Object.fromEntries(
      links.map((l, i) => [
        rels[i]!,
        { to: l.to.length ? l.to : '*', cardinality: l.many ? 'many' : 'one', ...(l.description.trim() ? { description: l.description.trim() } : {}) },
      ]),
    );
    const definition: DefineCollection = {
      name: collection.name,
      title: title.trim() || collectionLabel(collection),
      ...(description.trim() ? { description: description.trim() } : {}),
      schema: nextSchema,
      history: collection.history,
      links: nextLinks,
      permissions: collection.permissions,
      rules: collection.rules,
    };
    setBusy(true);
    try {
      await node.collections.define(space.id, definition);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Only an empty collection: records left without a definition would lose their shape and rules.
  const label = collectionLabel(collection);
  const cannotDelete = collection.records
    ? `Delete its ${collection.records === 1 ? 'one record' : `${collection.records} records`} first. A definition can only be deleted once nothing uses it.`
    : null;
  const remove = async () => {
    if (!globalThis.confirm(`Delete the definition of ${label}? It's removed for everyone in the space.`)) return;
    setError(null);
    setBusy(true);
    try {
      await node.collections.delete(space.id, collection.name);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} aria-label={`Edit what ${collectionLabel(collection)} is`} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Edit definition</h2>
        <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
          What every {collectionLabel(collection).toLowerCase()} is: its fields and what it can link to. Changes reach everyone in the space, and every device checks new records against them. Stored as <code>{collection.name}</code>.
        </p>
      </header>

      <section style={section}>
        <h3 style={styles.sectionTitle}>Name</h3>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name" style={styles.input} />
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A sentence on what it is (optional)" aria-label="Description" style={styles.input} />
      </section>

      <section style={section}>
        <h3 style={styles.sectionTitle}>Fields</h3>
        {fields.map((field, i) => (
          <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <input
              aria-label={`Field ${i + 1} name`}
              value={field.name}
              onChange={(e) => setField(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })}
              placeholder="field name"
              style={{ ...styles.input, flex: 1 }}
            />
            {field.type === null ? (
              <span style={{ fontSize: 13, color: palette.ink.faint, padding: '0 8px' }}>kept as it is</span>
            ) : (
              <select aria-label={`Field ${i + 1} type`} value={field.type} onChange={(e) => setField(i, { type: e.target.value as FieldTypeName })} style={styles.input}>
                {Object.keys(FIELD_TYPES).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            )}
            <label style={{ fontSize: 12, display: 'flex', gap: 4 }}>
              <input type="checkbox" checked={field.required} onChange={(e) => setField(i, { required: e.target.checked })} />
              required
            </label>
            <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} data-variant="ghost" style={styles.linkButton} aria-label={`Remove field ${i + 1}`}>
              ✕
            </button>
            {field.type === 'choice' && (
              <input
                aria-label={`Field ${i + 1} options`}
                value={field.options}
                onChange={(e) => setField(i, { options: e.target.value })}
                placeholder="Options, separated by commas: To do, Doing, Done"
                style={{ ...styles.input, flexBasis: '100%' }}
              />
            )}
          </div>
        ))}
        <button type="button" onClick={() => setFields([...fields, { name: '', type: 'text', options: '', required: false }])} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start' }}>
          + Add a field
        </button>
      </section>

      <section style={section}>
        <h3 style={styles.sectionTitle}>Links</h3>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: -4 }}>The ways one {collectionLabel(collection).toLowerCase()} can point at other records. Records are linked from their own page.</p>
        {links.map((link, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: `1px solid ${palette.surface.line}`, borderRadius: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input aria-label={`Link ${i + 1} name`} value={link.label} onChange={(e) => setLink(i, { label: e.target.value })} placeholder="e.g. in, about, part of" style={{ ...styles.input, flex: 1 }} />
              <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== i))} data-variant="ghost" style={styles.linkButton} aria-label={`Remove link ${i + 1}`}>
                ✕
              </button>
            </div>
            <input aria-label={`Link ${i + 1} description`} value={link.description} onChange={(e) => setLink(i, { description: e.target.value })} placeholder="What it means (optional)" style={styles.input} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 13 }}>
              <span style={{ color: palette.ink.muted }}>Can point at</span>
              <label style={{ display: 'inline-flex', gap: 4 }}>
                <input type="checkbox" checked={link.to.length === 0} onChange={() => setLink(i, { to: [] })} />
                anything
              </label>
              {targets.map((c) => (
                <label key={c.name} style={{ display: 'inline-flex', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={link.to.includes(c.name)}
                    onChange={(e) => setLink(i, { to: e.target.checked ? [...link.to, c.name] : link.to.filter((t) => t !== c.name) })}
                  />
                  {collectionLabel(c)}
                </label>
              ))}
            </div>
            <label style={{ display: 'inline-flex', gap: 6, fontSize: 13, alignItems: 'center' }}>
              <input type="checkbox" checked={link.many} onChange={(e) => setLink(i, { many: e.target.checked })} />
              More than one per {collectionLabel(collection).toLowerCase()}
            </label>
          </div>
        ))}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <button type="button" onClick={() => setLinks([...links, { label: '', description: '', to: [], many: true }])} data-variant="ghost" style={styles.linkButton}>
            + Add a kind of link
          </button>
          {unused.map((s) => (
            <button
              key={s.rel}
              type="button"
              title={s.description}
              onClick={() => setLinks([...links, { label: humanize(s.rel).toLowerCase(), description: s.description, to: [], many: true }])}
              data-variant="quiet"
              style={{ ...styles.smallButton, height: 26, fontSize: 12 }}
            >
              {humanize(s.rel).toLowerCase()}
            </button>
          ))}
        </div>
      </section>

      <p style={{ fontSize: 12, color: palette.ink.faint }}>Nothing already written is changed or deleted. Records that no longer fit — say, missing a field that's now required — are marked as not fitting when they're shown.</p>
      {error && <p style={styles.error}>{error}</p>}
      <div style={styles.linkRow}>
        <button type="submit" disabled={busy} data-variant="primary" style={styles.addButton}>
          {busy ? 'Saving…' : 'Save definition'}
        </button>
        <button type="button" onClick={onDone} data-variant="ghost" style={styles.linkButton}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void remove()}
          disabled={busy || !!cannotDelete}
          title={cannotDelete ?? undefined}
          data-variant="danger"
          style={{ ...styles.smallButton, color: palette.accent.danger, marginLeft: 'auto' }}
        >
          Delete definition
        </button>
      </div>
      {cannotDelete && <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: -16 }}>{cannotDelete}</p>}
    </form>
  );
}

const section = { display: 'flex', flexDirection: 'column' as const, gap: 10 };
