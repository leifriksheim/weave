import { useState } from 'react';
import { DEFINE, roleHolds } from '@weaveprotocol/core';
import type { NodeCollection, NodeRecord, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useNode } from '@weaveprotocol/core/react';
import { useSchemas } from '@weaveprotocol/core/schemas';
import { APPS, readiness, has, type WeaveApp } from './index';
import { isAdded, MadeAppScreen, MadeAppTiles, Proposals, useMadeApps } from './MadeApps';
import { styles, palette } from '../../styles';

/**
 * The apps a space can be used with. The ones whose schemas the space already
 * holds are ready to open; the rest say what they need, and adding one
 * defines just what is missing.
 *
 * Two kinds sit side by side: apps written as code here (Chat, Kanban…), and
 * apps made for this space and kept in it as records — often by an agent.
 * Those arrive as proposals, and someone who can add collections adds them.
 */
export function AppsView({ space, collections, onOpen }: { space: SpaceSummary; collections: ReadonlyArray<NodeCollection>; onOpen: (record: NodeRecord) => void }) {
  const node = useNode();
  const access = useAccess(space.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayDefine = space.writable && roleHolds(access?.role, DEFINE);
  const made = useMadeApps(space);
  const [openMade, setOpenMade] = useState<string | null>(null);
  const madeAdded = made.filter((record) => isAdded(record, collections));
  const proposed = made.filter((record) => !isAdded(record, collections));

  const openRecordApp = madeAdded.find((record) => record.key === openMade);
  if (openRecordApp) {
    return <MadeAppScreen space={space} record={openRecordApp} collections={collections} onOpen={onOpen} onBack={() => setOpenMade(null)} />;
  }

  const open = APPS.find((a) => a.id === openId && readiness(a, collections).ready);
  if (open) {
    return (
      <section aria-label={open.title} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => setOpenId(null)} data-variant="quiet" style={styles.smallButton}>
            ← Apps
          </button>
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
      await useSchemas(node, space.id, app.needs);
      await app.setup?.(node, space.id);
      setOpenId(app.id);
    } catch (e) {
      setError(`Could not add ${app.title}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <section aria-label="Apps in this space" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <h2 style={styles.sectionTitle}>In this space</h2>
          <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>Apps show up here once the space holds the collections they understand.</p>
        </div>
        {ready.length === 0 && madeAdded.length === 0 ? (
          <div style={{ ...styles.emptyState, padding: '28px 16px' }}>No apps yet — add one below, or ask your agent to make one.</div>
        ) : (
          <div style={grid}>
            <MadeAppTiles apps={madeAdded} collections={collections} onOpen={setOpenMade} />
            {ready.map((app) => (
              <button key={app.id} onClick={() => setOpenId(app.id)} data-tile style={{ ...tile, textAlign: 'left', cursor: 'pointer' }}>
                <strong style={tileTitle}>{app.title}</strong>
                <span style={tileText}>{app.description}</span>
                <SchemaList app={app} collections={collections} />
              </button>
            ))}
          </div>
        )}
      </section>

      <Proposals space={space} apps={proposed} collections={collections} mayDefine={mayDefine} onAdded={setOpenMade} />

      {addable.length > 0 && (
        <section aria-label="Add an app" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <h2 style={styles.sectionTitle}>Add an app</h2>
            <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
              {mayDefine ? 'Adding one adds the collections it needs. They hold ordinary records: the Collections tab shows them too.' : 'Someone whose role lets them add collections can add these.'}
            </p>
          </div>
          <div style={grid}>
            {addable.map((app) => (
              <div key={app.id} style={tile}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={tileTitle}>{app.title}</strong>
                  {mayDefine && (
                    <button onClick={() => void add(app)} disabled={busy !== null} aria-label={`Add ${app.title}`} data-variant="quiet" style={{ ...styles.smallButton, height: 28 }}>
                      {busy === app.id ? 'Adding…' : 'Add'}
                    </button>
                  )}
                </div>
                <span style={tileText}>{app.description}</span>
                <SchemaList app={app} collections={collections} />
              </div>
            ))}
          </div>
          {error && <p style={styles.error}>{error}</p>}
        </section>
      )}
    </div>
  );
}

/** What an app reads and writes, and whether this space has each yet */
function SchemaList({ app, collections }: { app: WeaveApp; collections: ReadonlyArray<NodeCollection> }) {
  const rows = [...app.needs.map((s) => ({ s, optional: false })), ...(app.uses ?? []).map((s) => ({ s, optional: true }))];
  return (
    <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, paddingTop: 10, borderTop: `1px solid ${palette.surface.line}` }}>
      {rows.map(({ s, optional }) => {
        const here = has(collections, s.name);
        return (
          <li key={s.name} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
            <span style={{ color: palette.ink.body }}>
              {s.title} <code style={{ fontSize: 11, color: palette.ink.faint }}>{s.name}</code>
            </span>
            <span style={{ color: here ? palette.accent.good : palette.ink.faint, whiteSpace: 'nowrap' }}>{here ? 'in this space' : optional ? 'optional' : 'will be added'}</span>
          </li>
        );
      })}
    </ul>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 };
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
