import { useState } from 'react';
import type { NodeCollection, NodeRecord, SpaceSummary } from 'weave-protocol';
import { useLive, useNode, useProfiles, useSpaces } from 'weave-protocol/react';
import { addApp, app as appSchema, appScreen, copyApp, reviewApp, type App, type AppReview } from 'weave-protocol/schemas';
import { AppBoard } from './AppBoard';
import { ScreenFrame } from './ScreenFrame';
import { nameOf, peopleFrom, type People } from '../../derive/people';
import { ago } from '../../derive/time';
import { styles, palette } from '../../styles';

/**
 * Apps someone made for this space, kept in it as `std.app` records — often
 * proposed by an agent. A proposal defines nothing: it says which collections
 * it needs, and what each would allow, worked out from its rules rather than
 * from what its author says. Someone whose role lets them add collections
 * adds it; from then on it opens here, drawn from its definitions.
 */
export function useMadeApps(space: SpaceSummary): ReadonlyArray<NodeRecord<App>> {
  return useLive(space.id, (node) => node.records.list<App>(space.id, { collection: appSchema.name, newestFirst: true }), [space.id]) ?? [];
}

/** Added apps, as tiles to open */
export function MadeAppTiles({
  apps,
  collections,
  onOpen,
}: {
  apps: ReadonlyArray<NodeRecord<App>>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (key: string) => void;
}) {
  return (
    <>
      {apps.map((record) => (
        <button key={record.key} onClick={() => onOpen(record.key)} data-tile style={{ ...tile, textAlign: 'left', cursor: 'pointer' }}>
          <strong style={tileTitle}>{record.body!.title}</strong>
          {record.body!.description && <span style={tileText}>{record.body!.description}</span>}
          <span style={{ fontSize: 12, color: palette.ink.faint }}>
            {record.body!.needs.map((need) => collections.find((c) => c.name === need.name)?.title ?? need.title ?? need.name).join(' · ')}
          </span>
        </button>
      ))}
    </>
  );
}

/** Whether an app record is readable and fully added */
export function isAdded(record: NodeRecord<App>, collections: ReadonlyArray<NodeCollection>): boolean {
  return !!record.body && reviewApp(record.body, collections).added;
}

/** Proposals waiting for someone to add them */
export function Proposals({
  space,
  apps,
  collections,
  mayDefine,
  onAdded,
}: {
  space: SpaceSummary;
  apps: ReadonlyArray<NodeRecord<App>>;
  collections: ReadonlyArray<NodeCollection>;
  mayDefine: boolean;
  onAdded: (key: string) => void;
}) {
  const people = peopleFrom(useProfiles(space.id));
  if (apps.length === 0) return null;
  return (
    <section aria-label="Proposed apps" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <h2 style={styles.sectionTitle}>Proposed</h2>
        <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
          Apps someone — or their agent — made for this space. Nothing changes until someone who can add collections adds one. What each
          allows is worked out from its rules, not from what its author says about it.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {apps.map((record) => (
          <Proposal key={record.key} space={space} record={record} collections={collections} people={people} mayDefine={mayDefine} onAdded={onAdded} />
        ))}
      </div>
    </section>
  );
}

function Proposal({
  space,
  record,
  collections,
  people,
  mayDefine,
  onAdded,
}: {
  space: SpaceSummary;
  record: NodeRecord<App>;
  collections: ReadonlyArray<NodeCollection>;
  people: People;
  mayDefine: boolean;
  onAdded: (key: string) => void;
}) {
  const node = useNode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const body = record.body;
  const review: AppReview | null = body ? reviewApp(body, collections) : null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await addApp(node, space.id, record.key);
      onAdded(record.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await node.records.delete(space.id, record.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const mine = record.createdBy === node.did;
  const changes = review?.needs.filter((need) => need.status === 'change') ?? [];

  return (
    <article style={{ ...tile, gap: 12 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ ...tileTitle, fontSize: 15 }}>{body?.title ?? 'An app that could not be read'}</strong>
          <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 2 }}>
            Proposed by {nameOf(record.createdBy, people)}
            {record.viaAgent && record.seq === 0 && <AgentBadge />} · {ago(record.createdAt)}
            {body?.from && ' · copied from another space'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {mine && (
            <button onClick={() => void remove()} disabled={busy} data-variant="quiet" style={{ ...styles.smallButton, height: 28 }}>
              Withdraw
            </button>
          )}
          {mayDefine && review && !review.problem && (
            <button onClick={() => void add()} disabled={busy} data-variant="primary" style={{ ...styles.smallButton, height: 28 }} aria-label={`Add ${body?.title}`}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          )}
        </div>
      </header>

      {body?.description && (
        <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
          <span style={{ color: palette.ink.faint }}>What they say it's for: </span>“{body.description}”
        </p>
      )}

      {review?.problem && <p style={styles.error}>This can't be added: {review.problem}</p>}

      {body && appScreen(body) && <ScreenNote screen={appScreen(body)!.screen} />}

      {review && !review.problem && (
        <>
          {changes.length > 0 && (
            <p style={{ fontSize: 13, color: palette.accent.danger, lineHeight: 1.5 }}>
              It changes {changes.map((c) => collections.find((held) => held.name === c.definition.name)?.title ?? c.definition.name).join(' and ')},
              which this space already has: {changes.map((c) => c.changes.join(', ')).join('; ')}.
            </p>
          )}
          <button onClick={() => setOpen((was) => !was)} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start', padding: 0, fontSize: 13 }}>
            {open ? 'Hide what it allows' : `What it allows (${review.needs.length} ${review.needs.length === 1 ? 'collection' : 'collections'})`}
          </button>
          {open && (
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10, borderTop: `1px solid ${palette.surface.line}` }}>
              {review.needs.map((need) => (
                <li key={need.definition.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                    <span style={{ color: palette.ink.strong, fontWeight: 500 }}>
                      {need.definition.title ?? need.definition.name} <code style={{ fontSize: 11, color: palette.ink.faint }}>{need.definition.name}</code>
                    </span>
                    <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: need.status === 'change' ? palette.accent.danger : need.status === 'same' ? palette.accent.good : palette.ink.faint }}>
                      {need.status === 'new' ? 'new' : need.status === 'same' ? 'already here' : 'changes it'}
                    </span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {need.summary.map((sentence) => (
                      <li key={sentence} style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.45 }}>
                        {sentence}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {!mayDefine && review && !review.problem && (
        <p style={{ fontSize: 12, color: palette.ink.faint }}>Someone whose role lets them add collections can add it.</p>
      )}
      {error && <p style={styles.error}>{error}</p>}
    </article>
  );
}

/**
 * An app that brings its own screen. Code can't be summed up the way rules
 * can, so this says what the screen is able to do at all — which the frame
 * enforces — and shows the code for anyone who wants to read it.
 */
function ScreenNote({ screen }: { screen: string }) {
  const [open, setOpen] = useState(false);
  const kb = Math.max(1, Math.round(new TextEncoder().encode(screen).length / 1024));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: palette.surface.sunken, borderRadius: 8 }}>
      <p style={{ fontSize: 13, color: palette.ink.body, lineHeight: 1.5 }}>
        <strong style={{ color: palette.ink.strong }}>It brings its own screen</strong> ({kb} KB of code). It runs sealed: it can read and
        change only this app's records, in this space, as whoever is looking — under the rules below. It can't reach the internet or
        anything else in the app. The rules below can't vouch for what the screen shows, so add it only if you trust whoever
        proposed it.
      </p>
      <button onClick={() => setOpen((was) => !was)} data-variant="ghost" style={{ ...styles.linkButton, alignSelf: 'flex-start', padding: 0, fontSize: 13 }}>
        {open ? 'Hide the code' : 'Show the code'}
      </button>
      {open && (
        <pre style={{ maxHeight: 280, overflow: 'auto', margin: 0, padding: 10, fontSize: 11, lineHeight: 1.45, background: palette.surface.card, border: `1px solid ${palette.surface.line}`, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {screen}
        </pre>
      )}
    </div>
  );
}

/** "via agent", beside a name */
function AgentBadge() {
  return (
    <span
      title="An agent wrote this for them. Their account said so when it let the agent in."
      style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, border: `1px solid ${palette.surface.line}`, fontSize: 11, color: palette.ink.muted }}
    >
      via agent
    </span>
  );
}

/**
 * An added app. Its own screen when one of its collections, as the space
 * defines it, carries one — what the person who added it approved, not what
 * the proposal says now. Otherwise drawn from its definitions.
 */
export function MadeAppScreen({
  space,
  record,
  collections,
  onOpen,
  onBack,
}: {
  space: SpaceSummary;
  record: NodeRecord<App>;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  onBack: () => void;
}) {
  const body = record.body!;
  const names = body.needs.map((need) => need.name);
  const withScreen = names.map((name) => collections.find((c) => c.name === name)).find((c) => c?.screen);
  const [plain, setPlain] = useState(false);

  return (
    <section aria-label={body.title} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={onBack} data-variant="quiet" style={styles.smallButton}>
          ← Apps
        </button>
        <h2 style={{ ...styles.appTitle, fontSize: 22 }}>{body.title}</h2>
        {withScreen && (
          <button onClick={() => setPlain((was) => !was)} data-variant="ghost" style={{ ...styles.linkButton, fontSize: 13 }}>
            {plain ? 'Show its screen' : 'Show the records'}
          </button>
        )}
        <CopyTo space={space} record={record} />
      </header>
      {body.description && <p style={{ fontSize: 14, color: palette.ink.muted, marginTop: -8 }}>{body.description}</p>}
      {withScreen?.screen && !plain ? (
        <ScreenFrame spaceId={space.id} collections={names} screen={withScreen.screen} title={body.title} />
      ) : (
        <AppBoard space={space} names={names} collections={collections} onOpen={onOpen} />
      )}
    </section>
  );
}

/** Proposes the same app in another of your spaces — people there decide for themselves */
function CopyTo({ space, record }: { space: SpaceSummary; record: NodeRecord<App> }) {
  const node = useNode();
  const { spaces } = useSpaces();
  const [said, setSaid] = useState<string | null>(null);
  const others = spaces.filter((other) => other.id !== space.id && other.writable);
  if (others.length === 0) return null;
  return (
    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      {said && <span style={{ color: palette.ink.muted }}>{said}</span>}
      <select
        value=""
        aria-label="Copy to another space"
        onChange={(event) => {
          const target = others.find((other) => other.id === event.target.value);
          if (!target) return;
          setSaid(null);
          copyApp(node, space.id, record.key, target.id).then(
            () => setSaid(`Proposed in ${target.name}`),
            (e: unknown) => setSaid(e instanceof Error ? e.message : String(e)),
          );
        }}
        style={{ ...styles.smallButton, height: 30 }}
      >
        <option value="">Copy to…</option>
        {others.map((other) => (
          <option key={other.id} value={other.id}>
            {other.name}
          </option>
        ))}
      </select>
    </span>
  );
}

const tile = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 10,
  background: palette.surface.card,
  font: 'inherit',
  color: 'inherit',
};
const tileTitle = { fontSize: 14, fontWeight: 600, color: palette.ink.strong };
const tileText = { fontSize: 13, lineHeight: 1.5, color: palette.ink.muted };
