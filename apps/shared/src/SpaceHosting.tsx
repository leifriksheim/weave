import { useCallback, useEffect, useState } from 'react';
import { DEFINE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { FundOffer, HostDescription, SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { host as hostSchema } from '@weaveprotocol/core/schemas';
import { DEFAULT_HOST } from './relay';
import { Modal } from './Modal';
import { ChipIn, RemindMe, dollars, lastsFor } from './Payment';
import { Benefit, FeatureIcon, Glyph, StatusPill, shortDate, timeLeft, type Tone } from './Feature';
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

/** How a space stands at a host, as a pill and one line: what is in its fund, and how long that lasts */
export function standing(view: SpaceHostingView): { tone: Tone; pill: string; line: string } {
  if (view.error) return { tone: 'bad', pill: "Can't reach host", line: view.error };
  const status = view.status;
  if (!status || status.state === 'none')
    return {
      tone: 'neutral',
      pill: 'Off',
      line: view.fund
        ? `Chip in to keep it online at ${view.name}`
        : `Online at ${view.name} once handed over`,
    };
  if (!view.fund && status.state === 'active')
    return { tone: 'good', pill: 'Online', line: `Free at ${view.name}` };
  if (status.state === 'lapsed') return { tone: 'bad', pill: 'Off', line: 'The fund ran out' };
  if (status.state === 'grace')
    return {
      tone: 'bad',
      pill: 'Fund empty',
      line: `Ran out ${shortDate(status.paidUntil)}; kept a little longer`,
    };
  const days = (status.paidUntil - Date.now() / 1000) / DAY;
  const lasts = `lasts about ${lastsFor(days / 30)}`;
  return {
    tone: days < 14 ? 'warn' : 'good',
    pill: days < 14 ? `Runs out ${timeLeft(status.paidUntil)}` : 'Online',
    line: `${dollars(status.balance ?? 0)} in the fund · ${lasts}`,
  };
}

/**
 * Keeping a space online, wherever an app shows it (the example's Hosting
 * tab, Liquid's People): how it stands, and Chip in for anyone. Whoever may
 * manage the space turns it on here too.
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
        {host && host.fund ? (
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
  return (
    <Modal title="Keep it online" onClose={onClose} width={460}>
      <KeepOnline spaceId={spaceId} writable={writable} onClose={onClose} />
    </Modal>
  );
}

/**
 * What the dialog shows, for other dialogs to show too (adding a bot starts
 * here when the community has no fund yet): without `hero`, no heading of its
 * own.
 */
export function KeepOnline({
  spaceId,
  writable,
  onClose,
  hero = true,
}: {
  spaceId: string;
  writable: boolean;
  onClose: () => void;
  hero?: boolean;
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
  const balance = host?.status?.balance ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {hero && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="online" glyph="cloud" size={44} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {host ? host.name : 'Around the clock'}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              {host ? standing(host).line : 'Paid from a fund anyone in the community can add to'}
            </p>
          </div>
        </div>
      )}

      {hosts === null ? (
        <p style={{ fontSize: 13, color: palette.ink.muted }}>One moment…</p>
      ) : !host ? (
        <>
          {hero && (
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Benefit glyph="clock">
                Reachable when everyone is offline, so new members get in at once
              </Benefit>
              <Benefit glyph="shield">Encrypted end to end: the host keeps it and can't read it</Benefit>
              <Benefit glyph="users">One shared fund: anyone chips in any amount, once or monthly</Benefit>
            </ul>
          )}
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
                <span style={{ fontSize: 14, color: palette.ink.strong, fontWeight: 500 }}>{offer.name}</span>
                <span style={{ fontSize: 13, color: palette.ink.muted }}>
                  {offer.free
                    ? 'Free'
                    : offer.fund
                      ? `$${offer.fund.monthly} a month, from the fund`
                      : (offer.price ?? '')}
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
      ) : host.fund ? (
        <>
          <FundPaysFor fund={host.fund} bots={host.bots} />
          <ChipIn
            fund={host.fund}
            rate={{ ...(host.status?.daily ? { daily: host.status.daily } : {}), bots: host.bots }}
            start={(payment) => node.hosting.payForSpace(spaceId, host.url, payment)}
            paid={async () => {
              const now = await node.hosting.space(spaceId);
              return (now.find((known) => known.url === host.url)?.status?.balance ?? 0) > balance;
            }}
            onDone={onClose}
          />
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            {host.reminds && (
              <RemindMe remind={(email) => node.hosting.remindForSpace(spaceId, host.url, email)} />
            )}
            {host.fund.manage && (
              <a
                href={host.fund.manage}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...styles.linkButton, padding: 0, textDecoration: 'none' }}
              >
                Stop adding every month
              </a>
            )}
          </div>
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
  );
}

/**
 * What a community's fund pays for, with a check for each: keeping it online
 * at the host's monthly rate, and each bot at what it has been spending. A
 * community without bots sees one line.
 */
export function FundPaysFor({
  fund,
  bots,
}: {
  fund: FundOffer;
  bots: ReadonlyArray<{ readonly name: string; readonly daily?: number }>;
}) {
  const line = (label: string, price: string) => (
    <li key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#eef8f0',
          color: palette.accent.good,
        }}
      >
        <Glyph name="check" size={12} style={{ strokeWidth: 2 }} />
      </span>
      <span style={{ flex: 1, color: palette.ink.body }}>{label}</span>
      <span style={{ fontSize: 13, color: palette.ink.muted }}>{price}</span>
    </li>
  );
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: palette.surface.sunken }}>
      <p style={{ fontSize: 12, fontWeight: 500, color: palette.ink.muted, marginBottom: 8 }}>
        This fund pays for
      </p>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {line('Always online, encrypted end to end', `$${fund.monthly} a month`)}
        {bots.map((bot) =>
          line(
            bot.name,
            bot.daily === undefined
              ? 'as it is used'
              : bot.daily * 30 < 250_000
                ? 'under $0.25 a month so far'
                : `about $${((bot.daily * 30) / 1e6).toFixed(2)} a month`,
          ),
        )}
      </ul>
      <p style={{ fontSize: 12, color: palette.ink.faint, marginTop: 10 }}>
        Anyone in the community can chip in, once or every month.
      </p>
    </div>
  );
}
