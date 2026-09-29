import { roleHolds } from '@weaveprotocol/core';
import type { NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useAccount, useNode, useProfiles } from '@weaveprotocol/core/react';
import { collectionLabel } from '../derive/schema-ui';
import { nameOf, peopleFrom } from '../derive/people';
import { CollectionDesigner } from './CollectionDesigner';
import { styles, palette } from '../styles';

/** Whether this account may change a collection's definition, and if not, why */
export function useMayRedefine(
  space: SpaceSummary,
  collection: NodeCollection | null,
): { may: boolean; reason: string } {
  const account = useAccount();
  const access = useAccess(space.id);
  const people = peopleFrom(useProfiles(space.id));
  if (!collection) return { may: false, reason: '' };
  if (collection.definedBy === account.did || roleHolds(access?.role, 'manage'))
    return { may: true, reason: '' };
  const definer = collection.definedBy ? nameOf(collection.definedBy, people) : 'whoever made it';
  return {
    may: false,
    reason: `Only ${definer}, or someone who manages the space, can change what ${collectionLabel(collection)} is.`,
  };
}

/**
 * Changes what a collection is: its name, its fields, what its records can
 * point at, and who may change them. This is the schema, not any one record
 * — a change here reaches everyone's apps, and applies to records written
 * from then on. Anything the designer doesn't understand is kept as it was.
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
  const label = collectionLabel(collection);
  // Only an empty collection: records left without a definition would lose their shape and rules.
  const cannotDelete = collection.records
    ? `Delete its ${collection.records === 1 ? 'one record' : `${collection.records} records`} first. A definition can only be deleted once nothing uses it.`
    : null;

  return (
    <section
      aria-label={`Edit what ${label} is`}
      style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>Edit {label}</h2>
        <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
          What every {label.toLowerCase()} is. Every device in the space checks new ones against it.
        </p>
      </header>
      <CollectionDesigner
        collection={collection}
        collections={collections}
        onSave={async (definition) => {
          await node.collections.define(space.id, definition);
          onDone();
        }}
        onCancel={onDone}
        onDelete={async () => {
          if (
            !globalThis.confirm(`Delete the definition of ${label}? It's removed for everyone in the space.`)
          )
            return;
          await node.collections.delete(space.id, collection.name);
          onDone();
        }}
        cannotDelete={cannotDelete}
      />
    </section>
  );
}
