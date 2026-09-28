import { useState } from 'react';
import { DEFINE, roleHolds } from '@weaveprotocol/core';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useNode } from '@weaveprotocol/core/react';
// `useSchemas` defines collections in a space; it is not a React hook, whatever its name says.
import { supersededApps, useSchemas as addSchemas } from '@weaveprotocol/core/schemas';
import { hash } from '@weave/app-shared/hash';
import { APPS, readiness, has, type WeaveApp } from './index';
import { CreateApp } from './CreateApp';
import { isAdded, MadeAppScreen, Proposals, useMadeApps } from './MadeApps';
import { Icon, type IconName } from '../Icon';
import { styles, palette } from '../../styles';

/**
 * The apps a space can be used with, laid out like a phone's home screen:
 * the ones ready to open, a way to make a new one, then the rest. The ones
 * whose schemas the space already holds are ready to open; the rest say what
 * they need, and adding one defines just what is missing.
 *
 * Two kinds sit side by side: apps written as code here (Chat, Kanban…), and
 * apps made for this space and kept in it as records — often by an agent.
 * Those arrive as proposals, and someone who can add collections adds them.
 */
export function AppsView({
  space,
  collections,
  onOpen,
  onBuildByHand,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  onOpen: (record: NodeRecord) => void;
  /** Defining a collection yourself, under the hood */
  onBuildByHand?: () => void;
}) {
  const node = useNode();
  const access = useAccess(space.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const mayDefine = space.writable && roleHolds(access?.role, DEFINE);
  const made = useMadeApps(space);
  const [openMade, setOpenMade] = useState<string | null>(null);
  // A version a newer one replaced would only undo it: neither open nor offered.
  const superseded = supersededApps(made, collections);
  const current = made.filter((record) => !superseded.has(record.key));
  const madeAdded = current.filter((record) => isAdded(record, collections));
  const proposed = current.filter((record) => !isAdded(record, collections));

  const openRecordApp = madeAdded.find((record) => record.key === openMade);
  if (openRecordApp) {
    return (
      <MadeAppScreen
        space={space}
        record={openRecordApp}
        collections={collections}
        onOpen={onOpen}
        onBack={() => setOpenMade(null)}
      />
    );
  }

  const open = APPS.find((a) => a.id === openId && readiness(a, collections).ready);
  if (open) {
    return (
      <section
        aria-label={open.title}
        style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => setOpenId(null)} data-variant="quiet" style={styles.smallButton}>
            ← Apps
          </button>
          <AppIcon icon={open.icon} hue={open.hue} size={28} />
          <h2 style={{ ...styles.appTitle, fontSize: 22 }}>{open.title}</h2>
        </header>
        <open.View space={space} collections={collections} onOpen={onOpen} />
      </section>
    );
  }

  const ready = APPS.filter((a) => readiness(a, collections).ready);
  const addable = APPS.filter((a) => !readiness(a, collections).ready);

  const add = async (app: WeaveApp) => {
    setBusy(app.id);
    setError(null);
    try {
      await addSchemas(node, space.id, app.needs);
      await app.setup?.(node, space.id);
      setOpenId(app.id);
    } catch (e) {
      setError(`Could not add ${app.title}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <section aria-label="Apps in this space" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 style={{ ...styles.appTitle, fontSize: 20 }}>Apps</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
              What you use together here. Everything they save stays in the space.
            </p>
          </div>
          {space.writable && (
            <button
              onClick={() => setCreating(true)}
              data-variant="primary"
              className="hide-on-phone"
              style={{ ...styles.button, ...inlineButton }}
            >
              <Icon name="sparkle" size={14} /> Create an app
            </button>
          )}
        </div>

        <div className="app-grid">
          {madeAdded.map((record) => (
            <AppCard
              key={record.key}
              icon="sparkle"
              hue={hash(record.key) % 360}
              title={record.body!.title}
              description={record.body!.description}
              onClick={() => setOpenMade(record.key)}
            />
          ))}
          {ready.map((app) => (
            <AppCard
              key={app.id}
              icon={app.icon}
              hue={app.hue}
              title={app.title}
              description={app.description}
              onClick={() => setOpenId(app.id)}
            />
          ))}
          {space.writable && (
            <button onClick={() => setCreating(true)} data-tile-new className="app-card" style={createCard}>
              <span
                style={{
                  ...iconBox(44),
                  border: `1px dashed ${palette.surface.lineStrong}`,
                  color: palette.ink.muted,
                }}
              >
                <Icon name="plus" size={20} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <strong style={cardTitle}>Create an app</strong>
                <span className="app-card-text" style={cardText}>
                  Describe it, and an agent builds it for this space
                </span>
              </span>
            </button>
          )}
        </div>
        {ready.length === 0 && madeAdded.length === 0 && (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>
            No apps here yet. Add a ready-made one below, or create your own.
          </p>
        )}
      </section>

      <Proposals
        space={space}
        apps={proposed}
        all={made}
        collections={collections}
        mayDefine={mayDefine}
        onAdded={setOpenMade}
      />

      {addable.length > 0 && (
        <section aria-label="More apps" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <h2 style={styles.sectionTitle}>More apps</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
              {mayDefine
                ? 'Ready-made. Adding one adds the collections it needs, which hold ordinary records.'
                : 'Someone whose role lets them add collections can add these.'}
            </p>
          </div>
          <div className="app-list">
            {addable.map((app) => (
              <div key={app.id} style={addRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <AppIcon icon={app.icon} hue={app.hue} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={cardTitle}>{app.title}</strong>
                    <p style={cardText}>{app.description}</p>
                  </div>
                  {mayDefine && (
                    <button
                      onClick={() => void add(app)}
                      disabled={busy !== null}
                      aria-label={`Add ${app.title}`}
                      data-variant="quiet"
                      style={{ ...styles.smallButton, flexShrink: 0 }}
                    >
                      {busy === app.id ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </div>
                <details style={{ marginTop: 6 }}>
                  <summary style={{ fontSize: 12, color: palette.ink.faint, paddingLeft: 52 }}>
                    What it stores
                  </summary>
                  <SchemaList app={app} collections={collections} />
                </details>
              </div>
            ))}
          </div>
          {error && <p style={styles.error}>{error}</p>}
        </section>
      )}

      {/* On a phone the button in the heading gives way to one under the thumb. */}
      {space.writable && (
        <button onClick={() => setCreating(true)} data-variant="primary" className="fab">
          <Icon name="sparkle" size={16} /> Create an app
        </button>
      )}

      {creating && (
        <CreateApp
          space={space}
          mayDefine={mayDefine}
          onClose={() => setCreating(false)}
          {...(onBuildByHand ? { onBuildByHand } : {})}
        />
      )}
    </div>
  );
}

/** An app on the home screen: its icon, its name, and a line on what it's for */
function AppCard({
  icon,
  hue,
  title,
  description,
  onClick,
}: {
  icon: IconName;
  hue: number;
  title: string;
  description?: string | undefined;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} data-tile className="app-card" style={card}>
      <AppIcon icon={icon} hue={hue} size={44} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <strong style={cardTitle}>{title}</strong>
        {description && (
          <span className="app-card-text" style={cardText}>
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

/** An app's glyph on its own tint, the same wherever the app appears */
function AppIcon({ icon, hue, size }: { icon: IconName; hue: number; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        ...iconBox(size),
        background: `linear-gradient(145deg, hsl(${hue} 80% 62%), hsl(${(hue + 25) % 360} 70% 46%))`,
        color: '#fff',
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.48)} />
    </span>
  );
}

/** What an app reads and writes, and whether this space has each yet */
function SchemaList({ app, collections }: { app: WeaveApp; collections: ReadonlyArray<NodeCollection> }) {
  const rows = [
    ...app.needs.map((s) => ({ s, optional: false })),
    ...(app.uses ?? []).map((s) => ({ s, optional: true })),
  ];
  return (
    <ul
      style={{
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        marginTop: 8,
        paddingTop: 8,
        borderTop: `1px solid ${palette.surface.line}`,
      }}
    >
      {rows.map(({ s, optional }) => {
        const here = has(collections, s.name);
        return (
          <li
            key={s.name}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 12,
            }}
          >
            <span style={{ color: palette.ink.body }}>
              {s.title} <code style={{ fontSize: 11, color: palette.ink.faint }}>{s.name}</code>
            </span>
            <span style={{ color: here ? palette.accent.good : palette.ink.faint, whiteSpace: 'nowrap' }}>
              {here ? 'in this space' : optional ? 'optional' : 'will be added'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const iconBox = (size: number) =>
  ({
    width: size,
    height: size,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Math.round(size * 0.28),
  }) as const;

const card = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: 14,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  background: palette.surface.card,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
} as const;
const createCard = {
  ...card,
  borderStyle: 'dashed',
  borderColor: palette.surface.lineStrong,
  background: 'none',
} as const;
const cardTitle = { fontSize: 15, fontWeight: 600, color: palette.ink.strong };
const cardText = { fontSize: 13, lineHeight: 1.45, color: palette.ink.muted };
const addRow = {
  padding: 12,
  border: `1px solid ${palette.surface.line}`,
  borderRadius: 12,
  background: palette.surface.card,
} as const;
const inlineButton = {
  width: 'auto',
  height: 36,
  padding: '0 14px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
} as const;
