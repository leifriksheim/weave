import { useState } from 'react';
import type { NodeCollection, SpaceSummary } from '@weaveprotocol/core';
import { useNode } from '@weaveprotocol/core/react';
// `useSchemas` defines collections in a space; it is not a React hook, whatever its name says.
import { useSchemas as addSchemas } from '@weaveprotocol/core/schemas';
import { has, type WeaveApp } from './index';
import type { AppEntry, useSpaceApps } from './entries';
import { AppIcon, Count } from './AppIcon';
import { Proposals } from './MadeApps';
import { Icon } from '../Icon';
import { unreadOf, type Unread } from '../../seen';
import { styles, palette } from '../../styles';

/**
 * A space's apps, laid out like a phone's home screen: the ones ready to
 * open, with what is new in each, a way to make a new one, then proposals
 * and the built-in ones not added yet. Adding one defines just the
 * collections it is missing.
 *
 * Two kinds sit side by side: apps written as code here (Chat, Kanban…), and
 * apps made for this space and kept in it as records — often by an agent.
 * Those arrive as proposals, and someone who can add collections adds them.
 */
export function AppsView({
  space,
  collections,
  apps,
  unread,
  mayDefine,
  onOpenApp,
  onCreate,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
  apps: ReturnType<typeof useSpaceApps>;
  unread: ReadonlyMap<string, Unread>;
  mayDefine: boolean;
  onOpenApp: (id: string) => void;
  onCreate: () => void;
}) {
  const node = useNode();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (app: WeaveApp) => {
    setBusy(app.id);
    setError(null);
    try {
      await addSchemas(node, space.id, app.needs);
      await app.setup?.(node, space.id);
      onOpenApp(app.id);
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
              onClick={onCreate}
              data-variant="primary"
              className="hide-on-phone"
              style={{ ...styles.button, ...inlineButton }}
            >
              <Icon name="sparkle" size={14} /> Create an app
            </button>
          )}
        </div>

        <div className="app-grid">
          {apps.ready.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              unread={unreadOf(unread, app.id)}
              onClick={() => onOpenApp(app.id)}
            />
          ))}
          {space.writable && (
            <button onClick={onCreate} data-tile-new className="app-card" style={createCard}>
              <span
                className="app-card-icon"
                style={{
                  ...iconBox,
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
        {apps.ready.length === 0 && (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>
            No apps here yet. Add a ready-made one below, or create your own.
          </p>
        )}
      </section>

      <Proposals
        space={space}
        apps={apps.proposed}
        all={apps.made}
        collections={collections}
        mayDefine={mayDefine}
        onAdded={(key) => onOpenApp(`made:${key}`)}
      />

      {apps.addable.length > 0 && (
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
            {apps.addable.map((app) => (
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
        <button onClick={onCreate} data-variant="primary" className="fab">
          <Icon name="sparkle" size={16} /> Create an app
        </button>
      )}
    </div>
  );
}

/** An app on the home screen: its icon, its name, a line on what it's for, and what's new in it */
function AppCard({ app, unread, onClick }: { app: AppEntry; unread: Unread; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      data-tile
      className="app-card"
      data-unread={unread.count > 0 || undefined}
      style={card}
    >
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <AppIcon icon={app.icon} hue={app.hue} size={44} className="app-card-icon" />
        <span className="app-card-count">
          <Count unread={unread} />
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <strong style={cardTitle}>{app.title}</strong>
        {app.description && (
          <span className="app-card-text" style={cardText}>
            {app.description}
          </span>
        )}
      </span>
    </button>
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

const iconBox = {
  width: 44,
  height: 44,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 12,
} as const;

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
