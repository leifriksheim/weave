import { useEffect, useState } from 'react';
import type { NodeRecord, SpaceProfile, SpaceSummary } from 'weave-protocol';
import { createInviteLink } from '../spaces';
import { Choice } from './Modal';
import { requireSession, type Session } from '../protocol';
import { useLive } from 'weave-protocol/react';
import { collectionLabel } from '../derive/schema-ui';
import { CollectionView } from './CollectionView';
import { RecordPanel, ANNOTATIONS } from './RecordPanel';
import { Library } from './Library';
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

/** Where in the space we are: which kind of thing, and which record is open beside it */
export interface Place {
  readonly collection: string | null;
  readonly key: string | null;
}

/** Defining a new kind of thing, in the main area */
const NEW = '__new__';

/**
 * One space, laid out like an app: its kinds of things down the side, the
 * chosen one in the middle, and a record opening in a panel beside it. All of
 * it drawn from what the space says about itself — nothing here knows what
 * any of the things are.
 */
export function SpaceView({ record: space, session }: { record: SpaceSummary; session: Session }) {
  const { node } = requireSession();
  const [place, setPlace] = useState<Place>({ collection: null, key: null });

  // Opening a space starts syncing it; leaving stops. It writes nothing:
  // standard schemas are added only when someone picks them from the library.
  useEffect(() => {
    void node.spaces.open(space.id).catch(() => {});
    return () => void node.spaces.close(space.id);
  }, [node, space.id]);

  const collections = useLive(node, space.id, () => node.collections.list(space.id), []) ?? [];
  const profiles = useLive(node, space.id, () => node.spaces.profiles(space.id), []);
  const people = peopleFrom(profiles);
  const status = useLive(node, space.id, () => node.spaces.status(space.id), []);

  const kinds = collections.filter((c) => !ANNOTATIONS.has(c.name));
  // Land on the first kind of thing rather than an empty page.
  const selected = place.collection === NEW ? NEW : kinds.some((c) => c.name === place.collection) ? place.collection : (kinds[0]?.name ?? null);
  const current = collections.find((c) => c.name === selected) ?? null;
  const openRecord = (r: NodeRecord) => setPlace({ collection: kinds.some((c) => c.name === r.collection) ? r.collection : selected, key: r.key });

  return (
    <>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ ...styles.appTitle, fontSize: 26 }}>{space.name}</h1>
          <span style={styles.badge}>{spaceBadges(space)}</span>
          {status && (
            <span style={styles.badge} title="Peers connected to this space right now">
              {CONNECTION_LABEL[status.connection]} · {status.peers.length} {status.peers.length === 1 ? 'peer' : 'peers'}
            </span>
          )}
          {status && status.rejected > 0 && (
            <span style={{ ...styles.badge, color: palette.accent.danger }} title="Records peers sent that failed validation">
              {status.rejected} rejected
            </span>
          )}
        </div>
        {!space.writable && (
          <p style={{ ...styles.errorHint, marginTop: 0 }}>
            {space.type === 'personal'
              ? `You're following this space. It's ${nameOf(space.owner, people)}'s, so only they can change it.`
              : "You can see this space but not change it. Anyone who can edit it can send you a link that lets you."}
          </p>
        )}
      </header>

      <div className="space-layout">
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <nav aria-label="Kinds of things" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={sideHeading}>In this space</span>
            {kinds.map((c) => (
              <button
                key={c.name}
                onClick={() => setPlace({ collection: c.name, key: null })}
                aria-current={selected === c.name ? 'page' : undefined}
                data-nav
                style={{ ...navItem, ...(selected === c.name ? navItemOn : {}) }}
              >
                <span>{collectionLabel(c)}</span>
                <span style={{ color: palette.ink.faint, fontSize: 12 }}>{c.records}</span>
              </button>
            ))}
            {kinds.length === 0 && <span style={{ fontSize: 13, color: palette.ink.faint, padding: '6px 10px' }}>Nothing yet</span>}
            {space.writable && (
              <button onClick={() => setPlace({ collection: NEW, key: null })} data-nav style={{ ...navItem, color: palette.ink.muted, ...(selected === NEW ? navItemOn : {}) }}>
                + New kind of thing
              </button>
            )}
          </nav>
          <People profiles={profiles ?? []} me={session.did} owner={space.owner} people={people} />
          <Share space={space} />
        </aside>

        <main style={{ minWidth: 0 }}>
          {selected === NEW ? (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 style={{ ...styles.appTitle, fontSize: 22 }}>New kind of thing</h2>
              <p style={{ fontSize: 13, color: palette.ink.muted }}>Give it a name and some fields. Everything else — forms, lists, boards — is worked out from this.</p>
              <NewCollection space={space} onDone={(name) => setPlace({ collection: name, key: null })} />
              <Library space={space} collections={collections} title="Or add one from the library" onAdded={(name) => !ANNOTATIONS.has(name) && setPlace({ collection: name, key: null })} />
            </section>
          ) : selected ? (
            <CollectionView key={selected} space={space} name={selected} collection={current} onOpen={openRecord} />
          ) : (
            <div style={{ ...styles.emptyState, padding: '64px 24px', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
              <strong style={{ color: palette.ink.strong, fontSize: 15 }}>This space is empty</strong>
              <span>Define a kind of thing — or ask an agent: this page offers the space's operations as WebMCP tools.</span>
              {space.writable && (
                <button onClick={() => setPlace({ collection: NEW, key: null })} data-variant="primary" style={{ ...styles.addButton, alignSelf: 'center' }}>
                  New kind of thing
                </button>
              )}
            </div>
          )}
          {!selected && (
            <Library space={space} collections={collections} title="Start with a standard schema" onAdded={(name) => !ANNOTATIONS.has(name) && setPlace({ collection: name, key: null })} />
          )}
          <div style={{ marginTop: 40 }}>
            <DelegationPanel session={session} spaceId={space.id} />
          </div>
        </main>
      </div>

      {place.key && (
        <RecordPanel space={space} recordKey={place.key} collections={collections} onOpen={openRecord} onClose={() => setPlace({ collection: selected, key: null })} />
      )}
    </>
  );
}

const sideHeading = { fontSize: 12, fontWeight: 500, color: palette.ink.faint, textTransform: 'uppercase' as const, letterSpacing: '.05em', padding: '0 10px 6px' };
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
  // Only someone who can change a shared space can hand that on.
  const canOfferEdit = space.type === 'shared' && space.writable;
  const [access, setAccess] = useState<'edit' | 'view'>(canOfferEdit ? 'edit' : 'view');
  const share = async () => {
    const link = await createInviteLink(space.id, { viewOnly: access === 'view' });
    setInvite(link);
    await globalThis.navigator.clipboard?.writeText(link).catch(() => {});
  };
  const explanation =
    space.type === 'personal'
      ? 'Anyone with the link can follow along; only you write.'
      : access === 'edit'
        ? 'Anyone with the link joins and can add and change things.'
        : 'Anyone with the link can see everything, but change nothing.';
  return (
    <section style={{ ...styles.panelSection, gap: 10 }}>
      <h2 style={styles.sectionTitle}>Invite</h2>
      {canOfferEdit && (
        <Choice
          label="People with the link"
          value={access}
          options={[
            { value: 'edit', label: 'Can edit' },
            { value: 'view', label: 'Can view' },
          ]}
          onChange={(next) => {
            setAccess(next);
            setInvite(null); // a link made for the other choice would say the wrong thing
          }}
        />
      )}
      <p style={{ fontSize: 13, lineHeight: 1.5, color: palette.ink.muted }}>
        {explanation}
        {space.visibility === 'private' && ' The link carries the key — treat it as a secret.'}
      </p>
      <button onClick={() => void share()} data-variant="quiet" style={{ ...styles.smallButton, alignSelf: 'flex-start' }}>
        {invite ? 'Copied — new link' : 'Create invite link'}
      </button>
      {invite && <code style={styles.token}>{invite}</code>}
    </section>
  );
}
