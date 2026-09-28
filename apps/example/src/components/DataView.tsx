import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { useState } from 'react';
import { collectionLabel } from '../derive/schema-ui';
import { namespaceOf } from '../derive/filters';
import { CollectionView } from './CollectionView';
import { CollectionsOverview, namespaceLabel } from './CollectionsOverview';
import { Library } from './Library';
import { NewCollection } from './NewCollection';
import { styles, palette } from '../styles';

/** Where the Data view is: which collection, and which record is open beside it */
export interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/** Defining a new collection, in the main area */
export const NEW = '__new__';
/** Every collection at once, in the main area */
const ALL = '__all__';

/**
 * Every record in a space, collection by collection: the collections down
 * the side, the chosen one beside them. Drawn from what the space says about
 * itself — nothing here knows what any of the records are.
 */
export function DataView({
  space,
  collections,
  place,
  onPlace,
  onOpen,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  place: Place;
  onPlace: (place: Place) => void;
  onOpen: (record: NodeRecord) => void;
}) {
  // Which namespace it shows; null for all of them.
  const [namespace, setNamespace] = useState<string | null>(null);

  // The space's own collections come before the standard ones.
  const ordered = [...collections].sort(
    (a, b) => Number(a.name.startsWith('std.')) - Number(b.name.startsWith('std.')),
  );
  const namespaces = [...new Set(ordered.map((c) => namespaceOf(c.name)))];
  const shown = namespace === null ? ordered : ordered.filter((c) => namespaceOf(c.name) === namespace);
  // Collections under a heading for their namespace, when there is more than one to tell apart.
  const groups = (namespace === null ? namespaces : [namespace])
    .map((ns) => ({ ns, members: shown.filter((c) => namespaceOf(c.name) === ns) }))
    .filter((g) => g.members.length > 0);
  // Land on every collection at once rather than an empty page.
  const selected =
    place.collection === NEW
      ? NEW
      : ordered.some((c) => c.name === place.collection)
        ? place.collection
        : ordered.length
          ? ALL
          : null;
  const current = collections.find((c) => c.name === selected) ?? null;

  return (
    <div className="space-layout">
      <aside className="space-side">
        {namespaces.length > 1 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="collection-nav-heading" style={sideHeading}>
              Namespace
            </span>
            <select
              value={namespace ?? ALL}
              onChange={(e) => setNamespace(e.target.value === ALL ? null : e.target.value)}
              aria-label="Namespace"
              style={{ ...styles.input, height: 34, fontSize: 13 }}
            >
              <option value={ALL}>All namespaces</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {namespaceLabel(ns)}
                </option>
              ))}
            </select>
          </label>
        )}
        <nav aria-label="Collections" className="collection-nav">
          <span className="collection-nav-heading" style={sideHeading}>
            In this space
          </span>
          {ordered.length > 0 && (
            <button
              onClick={() => onPlace({ collection: ALL, key: null })}
              aria-current={selected === ALL ? 'page' : undefined}
              data-nav
              style={{ ...navItem, ...(selected === ALL ? navItemOn : {}) }}
            >
              <span>All collections</span>
              <span style={{ color: palette.ink.faint, fontSize: 12 }}>{shown.length}</span>
            </button>
          )}
          {groups.map((g) => (
            <div key={g.ns} style={{ display: 'contents' }}>
              {groups.length > 1 && (
                <span className="collection-nav-heading" style={groupHeading}>
                  {namespaceLabel(g.ns)}
                </span>
              )}
              {g.members.map((c) => (
                <button
                  key={c.name}
                  onClick={() => onPlace({ collection: c.name, key: null })}
                  aria-current={selected === c.name ? 'page' : undefined}
                  title={c.name}
                  data-nav
                  style={{ ...navItem, ...(selected === c.name ? navItemOn : {}) }}
                >
                  <span>{collectionLabel(c)}</span>
                  <span style={{ color: palette.ink.faint, fontSize: 12 }}>{c.records}</span>
                </button>
              ))}
            </div>
          ))}
          {ordered.length === 0 && (
            <span style={{ fontSize: 13, color: palette.ink.faint, padding: '6px 10px' }}>Nothing yet</span>
          )}
          {space.writable && (
            <button
              onClick={() => onPlace({ collection: NEW, key: null })}
              aria-current={selected === NEW ? 'page' : undefined}
              data-nav
              style={{ ...navItem, color: palette.ink.muted, ...(selected === NEW ? navItemOn : {}) }}
            >
              + New collection
            </button>
          )}
        </nav>
      </aside>

      <main style={{ minWidth: 0 }}>
        {selected === NEW ? (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={{ ...styles.appTitle, fontSize: 22 }}>New collection</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              Give it a name and some fields. Everything else — forms, lists, boards — is worked out from
              this.
            </p>
            <NewCollection space={space} onDone={(name) => onPlace({ collection: name, key: null })} />
            <Library
              space={space}
              collections={collections}
              title="Or add one from the library"
              onAdded={(name) => onPlace({ collection: name, key: null })}
            />
          </section>
        ) : selected === ALL ? (
          <CollectionsOverview
            collections={shown}
            namespace={namespace}
            onOpen={(name) => onPlace({ collection: name, key: null })}
          />
        ) : selected ? (
          <CollectionView
            key={selected}
            space={space}
            name={selected}
            collection={current}
            collections={collections}
            onOpen={onOpen}
          />
        ) : (
          <div
            style={{
              ...styles.emptyState,
              padding: '64px 24px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <strong style={{ color: palette.ink.strong, fontSize: 15 }}>This space is empty</strong>
            <span>
              Define a collection — or ask an agent: this page offers the space's operations as WebMCP tools.
            </span>
            {space.writable && (
              <button
                onClick={() => onPlace({ collection: NEW, key: null })}
                data-variant="primary"
                style={{ ...styles.addButton, alignSelf: 'center' }}
              >
                New collection
              </button>
            )}
          </div>
        )}
        {!selected && (
          <Library
            space={space}
            collections={collections}
            title="Start with a standard schema"
            onAdded={(name) => onPlace({ collection: name, key: null })}
          />
        )}
      </main>
    </div>
  );
}

const sideHeading = {
  fontSize: 12,
  fontWeight: 500,
  color: palette.ink.faint,
  textTransform: 'uppercase' as const,
  letterSpacing: '.05em',
  padding: '0 10px 6px',
};
const groupHeading = {
  fontSize: 11,
  color: palette.ink.faint,
  padding: '12px 10px 4px',
  fontFamily: palette.mono,
};
const navItem = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  height: 34,
  padding: '0 10px',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: palette.ink.body,
  fontSize: 14,
  textAlign: 'left' as const,
};
const navItemOn = { background: palette.surface.sunken, color: palette.ink.strong, fontWeight: 500 };
