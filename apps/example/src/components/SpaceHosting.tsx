import { useCallback, useEffect, useState } from 'react';
import { DEFINE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { NodeCollection, SpaceHostingView, SpaceSummary } from '@weaveprotocol/core';
import { useAccess, useNode } from '@weaveprotocol/core/react';
import { host as hostSchema } from '@weaveprotocol/core/schemas';
import { styles, palette } from '../styles';

/** Who may choose the space's host: `std.host` asks for this permission */
const MANAGE_HOST = `${hostSchema.name}/manage`;
const DAY = 24 * 3600;

/**
 * Keeping a space online by paying for it together: the hosts it names in
 * `std.host`, how long each is paid for, and a Chip in button anyone may use.
 * Whoever may manage it picks the host. Members' devices hand the host the
 * space's pass once it is paid, so it keeps the space without reading it.
 */
export function SpaceHosting({
  space,
  collections,
}: {
  space: SpaceSummary;
  collections: ReadonlyArray<NodeCollection>;
}) {
  const node = useNode();
  const access = useAccess(space.id);
  const [hosts, setHosts] = useState<ReadonlyArray<SpaceHostingView> | null>(null);
  const [adding, setAdding] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const defined = collections.some((c) => c.name === hostSchema.name && c.version !== null);
  // A space that never named a host has none to ask about.
  const shown = defined ? hosts : [];
  const mayChoose = space.writable && roleHolds(access?.role, MANAGE_HOST);
  const mayDefine = space.writable && roleHolds(access?.role, DEFINE);

  const look = useCallback(() => {
    if (!defined) return;
    void node.hosting.space(space.id).then(setHosts, () => setHosts([]));
  }, [node, space.id, defined]);
  useEffect(() => {
    look();
    // Back from the pay page in another tab: the date has moved.
    const again = () => document.visibilityState === 'visible' && look();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [look]);

  const choose = async () => {
    setProblem(null);
    try {
      const url = new URL(adding.trim()).origin;
      const description = await describeHost(url);
      if (!defined) await node.collections.define(space.id, hostSchema);
      await node.records.put(space.id, hostSchema.name, {
        url,
        did: description.did,
        name: description.name,
      });
      setAdding('');
      look();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  const remove = async (url: string) => {
    const records = await node.records.list<{ url?: string }>(space.id, { collection: hostSchema.name });
    for (const record of records)
      if (record.body?.url === url) await node.records.delete(space.id, record.key);
    look();
  };

  return (
    <section aria-label="Keeping it online" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={styles.sectionTitle}>Keeping it online</h3>
      <p style={{ fontSize: 13, color: palette.ink.muted }}>
        A host keeps the space online when nobody has it open, without being able to read it. The space pays
        for it together: anyone here can chip in, and what they pay adds time.
      </p>
      {shown?.length === 0 && (
        <div style={{ ...styles.emptyState, padding: '16px' }}>
          No host keeps this space online yet. It is online while someone in it is.
        </div>
      )}
      {shown?.map((view) => (
        <article
          key={view.url}
          style={{
            border: `1px solid ${palette.surface.line}`,
            borderRadius: 10,
            padding: 14,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            background: palette.surface.card,
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <strong style={{ color: palette.ink.strong }}>{view.name}</strong>
            <div style={{ fontSize: 13, color: palette.ink.muted }}>{standing(view)}</div>
          </div>
          {view.pay && (
            <button
              data-variant="primary"
              style={styles.smallButton}
              onClick={() => window.open(view.pay!, '_blank', 'noopener')}
            >
              Chip in
            </button>
          )}
          {mayChoose && (
            <button data-variant="danger" style={styles.smallButton} onClick={() => void remove(view.url)}>
              Stop using
            </button>
          )}
        </article>
      ))}
      {mayChoose && (defined || mayDefine) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void choose();
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="https://host.example"
            aria-label="A host’s address"
            style={{ ...styles.input, flex: 1 }}
          />
          <button type="submit" disabled={!adding.trim()} style={styles.addButton}>
            Use this host
          </button>
        </form>
      )}
      {problem && <div style={styles.error}>{problem}</div>}
    </section>
  );
}

/** How a space stands at a host, in words: how long it is paid for, and whether it is kept now */
function standing(view: SpaceHostingView): string {
  if (view.error) return `Could not reach it: ${view.error}`;
  const status = view.status;
  if (!status || status.state === 'none') return 'Not paid for yet. Chip in to start.';
  const left = Math.ceil((status.paidUntil - Date.now() / 1000) / DAY);
  const kept = status.carrying ? '' : ' Waiting for a member’s device to hand it over.';
  if (status.state === 'active' && status.paidUntil === 0) return `Free on this host.${kept}`;
  if (status.state === 'active') return `${left} day${left === 1 ? '' : 's'} left.${kept}`;
  if (status.state === 'grace')
    return 'The time ran out; it is kept a little longer. Chip in to keep it online.';
  return 'The time ran out. Chip in to bring it back online.';
}
