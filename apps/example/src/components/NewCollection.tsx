import type { SpaceSummary } from '@weaveprotocol/core';
import { useCollections, useNode } from '@weaveprotocol/core/react';
import { CollectionDesigner } from './CollectionDesigner';

/**
 * Defines a collection in the space: a name, some fields, what it points at
 * and who may change it. The bare minimum a person needs without an agent —
 * everything else about how it is shown is worked out from this.
 */
export function NewCollection({
  space,
  onDone,
}: {
  space: SpaceSummary;
  onDone: (name: string | null) => void;
}) {
  const node = useNode();
  const collections = useCollections(space.id);
  return (
    <CollectionDesigner
      collection={null}
      collections={collections}
      onSave={async (definition) => {
        await node.collections.define(space.id, definition);
        onDone(definition.name);
      }}
      onCancel={() => onDone(null)}
    />
  );
}
