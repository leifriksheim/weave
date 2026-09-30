import { useCallback, useEffect, useState } from 'react';
import { DEFINE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { HostDescription, SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { host as hostSchema } from '@weaveprotocol/core/schemas';
import { DEFAULT_HOST } from './relay';
import { Payment, RemindMe } from './Payment';
import { styles, palette } from './styles';

/** Who may choose the space's host: `std.host` asks for this permission */
const MANAGE_HOST = `${hostSchema.name}/manage`;
const DAY = 24 * 3600;

/**
 * Keeping a space online by paying for it together, in any app: the hosts the
 * space names in `std.host`, how long each is paid for, and a Chip in button
 * anyone may use, which pays right here (`Payment`). Whoever may manage it picks the host, the build's own
 * (`VITE_WEAVE_HOST`) in one click, any other by its address. Members' devices
 * hand the host the space's pass once it is paid, so it keeps the space
 * without reading it, and reach it over its socket.
 */
export function SpaceHosting({ spaceId, writable }: { spaceId: string; writable: boolean }) {
  const node = useNode();
  const access = useAccess(spaceId);
  const collections = useCollections(spaceId);
  const [hosts, setHosts] = useState<ReadonlyArray<SpaceHostingView> | null>(null);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [other, setOther] = useState(!DEFAULT_HOST);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The host being chipped in for, by address */
  const [paying, setPaying] = useState<string | null>(null);
  const defined = collections.some((c) => c.name === hostSchema.name && c.version !== null);
  // A space that never named a host has none to ask about.
  const shown = defined ? hosts : [];
  const mayChoose = writable && roleHolds(access?.role, MANAGE_HOST);
  const mayDefine = writable && roleHolds(access?.role, DEFINE);

  const look = useCallback(() => {
    if (!defined) return;
    void node.hosting.space(spaceId).then(setHosts, () => setHosts([]));
  }, [node, spaceId, defined]);
  useEffect(() => {
    look();
    // Back from a checkout page in another tab: the date has moved.
    const again = () => document.visibilityState === 'visible' && look();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [look]);
  useEffect(() => {
    if (!DEFAULT_HOST || !mayChoose) return;
    void describeHost(DEFAULT_HOST).then(setOffer, () => setOther(true));
  }, [mayChoose]);

  const choose = async (address: string) => {
    setProblem(null);
    setBusy(true);
    try {
      const url = new URL(address.trim()).origin;
      const description = await describeHost(url);
      if (!defined) await node.collections.define(spaceId, hostSchema);
      await node.records.put(spaceId, hostSchema.name, {
        url,
        did: description.did,
        name: description.name,
      });
      setAdding('');
      look();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (url: string) => {
    const records = await node.records.list<{ url?: string }>(spaceId, { collection: hostSchema.name });
    for (const record of records)
      if (record.body?.url === url) await node.records.delete(spaceId, record.key);
    look();
  };

  const mayStart = mayChoose && (defined || mayDefine) && shown?.length === 0;

  return (
    <section aria-label="Keeping it online" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={styles.sectionTitle}>Keeping it online</h3>
      <p style={{ fontSize: 13, color: palette.ink.muted }}>
        A host keeps the space online when nobody has it open, without being able to read it. The space pays
        for it together: anyone here can chip in, and what they pay adds time.
      </p>
      {shown?.length === 0 && !mayStart && (
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
          {view.plans.length > 0 && (
            <button
              data-variant={paying === view.url ? 'quiet' : 'primary'}
              style={styles.smallButton}
              onClick={() => setPaying(paying === view.url ? null : view.url)}
            >
              {paying === view.url ? 'Close' : 'Chip in'}
            </button>
          )}
          {mayChoose && (
            <button data-variant="quiet" style={styles.smallButton} onClick={() => void remove(view.url)}>
              Stop using
            </button>
          )}
          {paying === view.url && (
            <div style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Payment
                plans={view.plans}
                start={(plan) => node.hosting.payForSpace(spaceId, view.url, plan)}
                paid={async () => {
                  const now = await node.hosting.space(spaceId);
                  const moved =
                    (now.find((known) => known.url === view.url)?.status?.paidUntil ?? 0) >
                    (view.status?.paidUntil ?? 0);
                  if (moved) setHosts(now);
                  return moved;
                }}
              />
              {view.reminds && (
                <RemindMe remind={(email) => node.hosting.remindForSpace(spaceId, view.url, email)} />
              )}
            </div>
          )}
        </article>
      ))}
      {mayStart && offer && DEFAULT_HOST && !other && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
              alignSelf: 'stretch',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 14, color: palette.ink.strong }}>
              {offer.name}
              {offer.free ? ' · free' : offer.price ? ` · ${offer.price}` : ''}
            </span>
            <button disabled={busy} style={styles.addButton} onClick={() => void choose(DEFAULT_HOST ?? '')}>
              {busy ? 'Starting…' : 'Keep it online'}
            </button>
          </div>
          <button data-variant="quiet" style={styles.smallButton} onClick={() => setOther(true)}>
            Use another host
          </button>
        </div>
      )}
      {mayStart && other && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void choose(adding);
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
          <button type="submit" disabled={busy || !adding.trim()} style={styles.addButton}>
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
  const until = new Date(status.paidUntil * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  const left = Math.ceil((status.paidUntil - Date.now() / 1000) / DAY);
  const kept = status.carrying ? 'Online' : 'Waiting for a member’s device to hand it over';
  if (status.state === 'active' && status.paidUntil === 0) return `${kept} · free on this host`;
  if (status.state === 'active')
    return `${kept} · funded until ${until}${left <= 14 ? `, ${left} day${left === 1 ? '' : 's'} left` : ''}`;
  if (status.state === 'grace')
    return 'The time ran out; it is kept a little longer. Chip in to keep it online.';
  return 'The time ran out. Chip in to bring it back online.';
}
