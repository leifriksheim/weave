import { useCallback, useEffect, useState } from 'react';
import { DEFINE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { HostDescription, SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { host as hostSchema } from '@weaveprotocol/core/schemas';
import { DEFAULT_HOST } from './relay';
import { Modal } from './Modal';
import { PayFlow, RemindMe } from './Payment';
import { Benefit, FeatureIcon, StatusPill, shortDate, timeLeft, type Tone } from './Feature';
import { styles, palette } from './styles';

/** Who may choose the space's host: `std.host` asks for this permission */
const MANAGE_HOST = `${hostSchema.name}/manage`;
const DAY = 86_400;

/**
 * The hosts a space names in `std.host`, each with how the space stands
 * there, asked again when the tab comes back (from a checkout page) and when
 * `look` is called. Also whether this account may choose the host.
 */
export function useSpaceHosts(spaceId: string, writable: boolean) {
  const node = useNode();
  const access = useAccess(spaceId);
  const collections = useCollections(spaceId);
  const [asked, setHosts] = useState<ReadonlyArray<SpaceHostingView> | null>(null);
  const defined = collections.some((c) => c.name === hostSchema.name && c.version !== null);
  // A space that never named a host has none to ask about.
  const hosts = defined ? asked : [];
  const look = useCallback(() => {
    if (defined) void node.hosting.space(spaceId).then(setHosts, () => setHosts([]));
  }, [node, spaceId, defined]);
  useEffect(() => {
    look();
    const again = () => document.visibilityState === 'visible' && look();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [look]);
  const mayChoose =
    writable && roleHolds(access?.role, MANAGE_HOST) && (defined || roleHolds(access?.role, DEFINE));
  return { hosts, look, defined, mayChoose };
}

/** The host that keeps a space online now: carrying it, paid or in its grace period */
export const onlineHost = (hosts: ReadonlyArray<SpaceHostingView> | null) =>
  hosts?.find(
    (host) => host.status?.carrying && (host.status.state === 'active' || host.status.state === 'grace'),
  );

/** How a space stands at a host, as a pill and one line */
export function standing(view: SpaceHostingView): { tone: Tone; pill: string; line: string } {
  if (view.error) return { tone: 'bad', pill: "Can't reach host", line: view.error };
  const status = view.status;
  if (!status || status.state === 'none')
    return { tone: 'neutral', pill: 'Off', line: `${view.name} keeps it online once it is paid for` };
  if (status.state === 'lapsed')
    return { tone: 'bad', pill: 'Off', line: `The time paid at ${view.name} ran out` };
  if (status.state === 'grace')
    return {
      tone: 'bad',
      pill: 'Needs payment',
      line: `Ran out ${shortDate(status.paidUntil)}; kept a little longer`,
    };
  if (status.paidUntil === 0) return { tone: 'good', pill: 'Online', line: `Free at ${view.name}` };
  const soon = status.paidUntil - Date.now() / 1000 < 14 * DAY;
  return {
    tone: soon ? 'warn' : 'good',
    pill: soon ? `Runs out ${timeLeft(status.paidUntil)}` : 'Online',
    line: `Kept by ${view.name} · funded until ${shortDate(status.paidUntil)}`,
  };
}

/**
 * Keeping a space online, in the People tab of any app: how it stands, and
 * Chip in for anyone. Whoever may manage the space turns it on here too.
 */
export function SpaceHosting({ spaceId, writable }: { spaceId: string; writable: boolean }) {
  const { hosts, look, mayChoose } = useSpaceHosts(spaceId, writable);
  const [open, setOpen] = useState(false);
  if (hosts === null) return null;
  const host = hosts[0];
  const view = host ? standing(host) : null;
  return (
    <section aria-label="Always online" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={styles.sectionTitle}>Always online</h3>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          padding: 14,
          borderRadius: 12,
          border: `1px solid ${palette.surface.line}`,
        }}
      >
        <FeatureIcon kind="online" glyph="cloud" size={36} />
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14, color: palette.ink.strong }}>
              {host ? host.name : 'Online only while someone is'}
            </strong>
            {view && <StatusPill tone={view.tone}>{view.pill}</StatusPill>}
          </div>
          <p style={{ fontSize: 13, color: palette.ink.muted, marginTop: 2 }}>
            {view ? view.line : 'A host can keep it reachable when everyone is offline, without reading it.'}
          </p>
        </div>
        {host && host.plans.length > 0 ? (
          <button onClick={() => setOpen(true)} data-variant="quiet" style={styles.smallButton}>
            Chip in
          </button>
        ) : (
          !host &&
          mayChoose && (
            <button onClick={() => setOpen(true)} data-variant="primary" style={darkSmall}>
              Turn on
            </button>
          )
        )}
      </div>
      {open && (
        <KeepOnlineDialog
          spaceId={spaceId}
          writable={writable}
          onClose={() => {
            setOpen(false);
            look();
          }}
        />
      )}
    </section>
  );
}

/** A small button in the one accent, for the one thing to do next */
export const darkSmall = {
  ...styles.smallButton,
  background: palette.ink.strong,
  color: '#fff',
  border: `1px solid ${palette.ink.strong}`,
};

/**
 * The dialog for keeping a space online. Before a host is chosen: what it
 * gives, the host this build offers with its price, and Continue (another
 * host by its address, for those who have one). After: the host's plans for
 * spaces, paid here by anyone, and reminders by email.
 */
export function KeepOnlineDialog({
  spaceId,
  writable,
  onClose,
}: {
  spaceId: string;
  writable: boolean;
  onClose: () => void;
}) {
  const node = useNode();
  const { hosts, look, defined, mayChoose } = useSpaceHosts(spaceId, writable);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [other, setOther] = useState(!DEFAULT_HOST);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!DEFAULT_HOST) return;
    void describeHost(DEFAULT_HOST).then(setOffer, () => setOther(true));
  }, []);

  const choose = async (where: string) => {
    setProblem(null);
    setBusy(true);
    try {
      const url = new URL(where.trim()).origin;
      const description = await describeHost(url);
      if (!defined) await node.collections.define(spaceId, hostSchema);
      await node.records.put(spaceId, hostSchema.name, {
        url,
        did: description.did,
        name: description.name,
      });
      look();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const stop = async (url: string) => {
    const records = await node.records.list<{ url?: string }>(spaceId, { collection: hostSchema.name });
    for (const record of records)
      if (record.body?.url === url) await node.records.delete(spaceId, record.key);
    look();
  };

  const host = hosts?.[0];
  const paidUntil = host?.status?.paidUntil ?? 0;
  return (
    <Modal title="Keep it online" onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="online" glyph="cloud" size={44} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {host ? host.name : 'Around the clock'}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              {host ? standing(host).line : 'Your community, reachable even when everyone is offline'}
            </p>
          </div>
        </div>

        {hosts === null ? (
          <p style={{ fontSize: 13, color: palette.ink.muted }}>One moment…</p>
        ) : !host ? (
          <>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Benefit glyph="clock">
                Reachable when everyone is offline, so new members get in at once
              </Benefit>
              <Benefit glyph="shield">Encrypted end to end: the host keeps it and can't read it</Benefit>
              <Benefit glyph="users">Shared: anyone in the community can chip in</Benefit>
            </ul>
            {!mayChoose ? (
              <p style={{ fontSize: 13, color: palette.ink.muted }}>
                An admin of this community can turn it on.
              </p>
            ) : other || !offer ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void choose(address);
                }}
                style={{ display: 'flex', gap: 8 }}
              >
                <input
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://host.example"
                  aria-label="A host's address"
                  style={{ ...styles.input, flex: 1 }}
                />
                <button
                  type="submit"
                  disabled={busy || !address.trim()}
                  data-variant="primary"
                  style={styles.addButton}
                >
                  Use it
                </button>
              </form>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 10,
                    background: palette.surface.sunken,
                  }}
                >
                  <span style={{ fontSize: 14, color: palette.ink.strong, fontWeight: 500 }}>
                    {offer.name}
                  </span>
                  <span style={{ fontSize: 13, color: palette.ink.muted }}>
                    {offer.free ? 'Free' : (offer.price ?? '')}
                  </span>
                </div>
                <button
                  onClick={() => void choose(DEFAULT_HOST ?? '')}
                  disabled={busy}
                  data-variant="primary"
                  style={styles.button}
                >
                  {busy ? 'One moment…' : 'Continue'}
                </button>
                <button onClick={() => setOther(true)} style={{ ...styles.linkButton, alignSelf: 'center' }}>
                  Use another host
                </button>
              </>
            )}
          </>
        ) : host.plans.length > 0 ? (
          <>
            <PayFlow
              plans={host.plans}
              start={(plan) => node.hosting.payForSpace(spaceId, host.url, plan)}
              paid={async () => {
                const now = await node.hosting.space(spaceId);
                return (now.find((known) => known.url === host.url)?.status?.paidUntil ?? 0) > paidUntil;
              }}
              onDone={onClose}
            />
            {host.reminds && (
              <div style={{ alignSelf: 'center' }}>
                <RemindMe remind={(email) => node.hosting.remindForSpace(spaceId, host.url, email)} />
              </div>
            )}
          </>
        ) : (
          <button onClick={onClose} data-variant="primary" style={styles.button}>
            Done
          </button>
        )}

        {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
        {host && mayChoose && (
          <button
            onClick={() => void stop(host.url).then(onClose)}
            style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12, color: palette.ink.faint }}
          >
            Stop using {host.name}
          </button>
        )}
      </div>
    </Modal>
  );
}
