import { useEffect, useState } from 'react';
import type { NodeCollection, SpaceProfile, SpaceSummary } from 'weave-protocol';
import { createInviteLink } from '../spaces';
import { requireSession, type Session } from '../protocol';
import { useLive } from '../hooks/useLive';
import { collectionLabel } from '../derive/schema-ui';
import { CollectionView } from './CollectionView';
import { RecordView } from './RecordView';
import { NewCollection } from './NewCollection';
import { DelegationPanel } from './DelegationPanel';
import { spaceBadges } from './SpaceList';
import { styles, palette } from '../styles';
import { Avatar } from './Avatar';
import { nameOf, peopleFrom } from '../derive/people';

const CONNECTION_LABEL: Record<string, string> = {
  offline: '○ offline',
  connecting: '◌ connecting',
  connected: '● connected',
  error: '○ no relay',
};

/** Where in the space we are: its overview, one collection, or one record */
export interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/**
 * One space, drawn from what it says about itself: the kinds of things in it
 * (its catalogue), their records, and how they point at each other. Nothing
 * here knows what any of them are.
 */
export function SpaceView({ record: space, session, onBack }: { record: SpaceSummary; session: Session; onBack: () => void }) {
  const { node } = requireSession();
  const [place, setPlace] = useState<Place>({ collection: null, key: null });

  // Opening a space starts syncing it; leaving stops.
  useEffect(() => {
    void node.spaces.open(space.id);
    return () => void node.spaces.close(space.id);
  }, [node, space.id]);

  const collections = useLive(space.id, () => node.collections.list(space.id), []) ?? [];
  const profiles = useLive(space.id, () => node.spaces.profiles(space.id), []);
  const people = peopleFrom(profiles);
  const status = useLive(space.id, () => node.spaces.status(space.id), []);

  const go = (next: Place) => setPlace(next);
  const current = collections.find((c) => c.name === place.collection) ?? null;

  return (
    <>
      <header style={styles.header}>
        <nav style={{ ...styles.linkRow, marginTop: 0 }} aria-label="Breadcrumbs">
          <button onClick={onBack} data-variant="ghost" style={styles.linkButton}>
            ← All spaces
          </button>
          {place.collection && (
            <button onClick={() => go({ collection: null, key: null })} data-variant="ghost" style={styles.linkButton}>
              / {space.name}
            </button>
          )}
          {place.key && place.collection && (
            <button onClick={() => go({ collection: place.collection, key: null })} data-variant="ghost" style={styles.linkButton}>
              / {current ? collectionLabel(current) : place.collection}
            </button>
          )}
        </nav>
        <h1 style={{ ...styles.appTitle, fontSize: 22 }}>{space.name}</h1>
        <div style={styles.identityBar}>
          <span style={styles.badge}>{spaceBadges(space)}</span>
          {status && (
            <span style={styles.badge}>
              {CONNECTION_LABEL[status.connection]} · {status.peers.length} {status.peers.length === 1 ? 'peer' : 'peers'}
            </span>
          )}
          {status && status.rejected > 0 && (
            <span style={{ ...styles.badge, color: palette.accent.danger }} title="Records peers sent that failed validation">
              {status.rejected} rejected
            </span>
          )}
        </div>
      </header>

      {!space.writable && (
        <p style={styles.errorHint}>You are following this space. It is {nameOf(space.owner, people)}'s, so only they can change it.</p>
      )}

      {place.key && place.collection ? (
        <RecordView space={space} recordKey={place.key} collections={collections} go={go} />
      ) : place.collection ? (
        <CollectionView space={space} name={place.collection} collection={current} go={go} />
      ) : (
        <>
          <Overview space={space} collections={collections} go={go} />
          <People profiles={profiles ?? []} me={session.rootDid} owner={space.owner} people={people} />
        </>
      )}

      {!place.collection && (
        <>
          <Share space={space} />
          <DelegationPanel session={session} spaceId={space.id} />
        </>
      )}
    </>
  );
}

/** The kinds of things in the space. The protocol's own annotations only show once used. */
function Overview({ space, collections, go }: { space: SpaceSummary; collections: ReadonlyArray<NodeCollection>; go: (p: Place) => void }) {
  const [defining, setDefining] = useState(false);
  const shown = collections.filter((c) => !c.name.startsWith('sys.') || c.records > 0);

  return (
    <section style={styles.panelSection} aria-label="What this space holds">
      <h2 style={styles.sectionTitle}>What's here</h2>
      {shown.length === 0 && (
        <p style={styles.hint}>
          Nothing yet. Define a kind of thing below — or ask an agent: this page offers the space's operations as WebMCP tools.
        </p>
      )}
      <div style={styles.todoList}>
        {shown.map((c) => (
          <button key={c.name} onClick={() => go({ collection: c.name, key: null })} data-variant="ghost" style={styles.spaceButton}>
            <span style={styles.todoText}>{collectionLabel(c)}</span>
            <span style={styles.todoMeta}>
              {c.records} {c.records === 1 ? 'record' : 'records'} · <code>{c.name}</code>
              {c.schema === null && ' · undescribed'}
            </span>
            {c.description && <span style={styles.todoMeta}>{c.description}</span>}
          </button>
        ))}
      </div>
      {space.writable &&
        (defining ? (
          <NewCollection
            space={space}
            onDone={(name) => {
              setDefining(false);
              if (name) go({ collection: name, key: null });
            }}
          />
        ) : (
          <button onClick={() => setDefining(true)} data-variant="quiet" style={{ ...styles.smallButton, alignSelf: 'flex-start', marginTop: 8 }}>
            + Define a kind of thing
          </button>
        ))}
    </section>
  );
}

/** Who is here: everyone who has said who they are in this space */
function People({ profiles, me, owner, people }: { profiles: ReadonlyArray<SpaceProfile>; me: string; owner: string; people: ReturnType<typeof peopleFrom> }) {
  if (profiles.length === 0) return null;
  return (
    <section style={styles.panelSection} aria-label="People">
      <h2 style={styles.sectionTitle}>People ({profiles.length})</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {profiles.map((p) => (
          <span key={p.did} title={p.did} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 10px 4px 4px', border: `1px solid ${palette.surface.line}`, borderRadius: 999, fontSize: 13 }}>
            <Avatar did={p.did} size={22} />
            <span style={{ color: palette.ink.strong }}>{nameOf(p.did, people)}</span>
            {p.did === me && <span style={{ color: palette.ink.faint }}>you</span>}
            {p.did === owner && p.did !== me && <span style={{ color: palette.ink.faint }}>owner</span>}
          </span>
        ))}
      </div>
    </section>
  );
}

function Share({ space }: { space: SpaceSummary }) {
  const [invite, setInvite] = useState<string | null>(null);
  const share = async () => {
    const link = await createInviteLink(space.id);
    setInvite(link);
    await globalThis.navigator.clipboard?.writeText(link).catch(() => {});
  };
  return (
    <section style={styles.panelSection}>
      <h2 style={styles.sectionTitle}>Share this space</h2>
      <p style={styles.hint}>
        {space.type === 'shared'
          ? 'Anyone who opens this link joins as a member and can write.'
          : 'This is a personal space: the link lets others follow along, but only you can write.'}
        {space.visibility === 'private' && ' The key travels in the link fragment, so it never reaches a server — treat the link as a secret.'}
      </p>
      <button onClick={() => void share()} data-variant="primary" style={styles.addButton}>
        Create invite link
      </button>
      {invite && <code style={styles.token}>{invite}</code>}
    </section>
  );
}
