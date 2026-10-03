import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFINE, MANAGE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { FundOffer, SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { host as hostSchema } from '@weaveprotocol/core/schemas';
import { DEFAULT_HOST } from './relay';
import { Modal } from './Modal';
import { useWanted, type Wanted } from './HostAddress';
import { HostOfferPicker, HostStatusRow, StopFooter, useAskAgain, useOffer } from './HostOffer';
import { ChipIn, RemindMe, dollars, lastsFor } from './Payment';
import { Benefit, FeatureIcon, Glyph, shortDate, timeLeft, type Tone } from './Feature';
import { useAction } from './action';
import { styles, palette } from './styles';

/** Who may choose the space's host: `std.host` asks for this permission */
const MANAGE_HOST = `${hostSchema.name}/manage`;
const DAY = 86_400;
/** How long the dialog waits for a host just chosen to show among the space's, before it shows the form again */
const CHOSEN_SHOWS_MS = 20_000;

/**
 * The hosts a space names in `std.host`, each with how the space stands
 * there, asked again when the tab comes back (from a checkout page) and when
 * `look` is called; `looking` while one is being asked. Also whether this
 * account may choose the host.
 */
export function useSpaceHosts(spaceId: string, writable: boolean) {
  const node = useNode();
  const access = useAccess(spaceId);
  const collections = useCollections(spaceId);
  const [asked, setHosts] = useState<ReadonlyArray<SpaceHostingView> | null>(null);
  const [looking, setLooking] = useState(false);
  const looks = useRef(0);
  const defined = collections.some((c) => c.name === hostSchema.name && c.version !== null);
  // A space that never named a host has none to ask about.
  const hosts = defined ? asked : [];
  const ask = useCallback(
    () => (defined ? node.hosting.space(spaceId).then(setHosts, () => setHosts([])) : Promise.resolve()),
    [node, spaceId, defined],
  );
  /** Asks again because someone said to, so what they pressed can say it is asking */
  const look = useCallback(() => {
    looks.current += 1;
    setLooking(true);
    void ask().finally(() => {
      looks.current -= 1;
      if (looks.current === 0) setLooking(false);
    });
  }, [ask]);
  useAskAgain(ask);
  const mayChoose =
    writable && roleHolds(access?.role, MANAGE_HOST) && (defined || roleHolds(access?.role, DEFINE));
  return { hosts, look, looking, defined, mayChoose };
}

/** The host that keeps a space online now: carrying it, paid or in its grace period */
export const onlineHost = (hosts: ReadonlyArray<SpaceHostingView> | null) =>
  hosts?.find(
    (host) => host.status?.carrying && (host.status.state === 'active' || host.status.state === 'grace'),
  );

/** Whether a host waits for money before it keeps the space: named, reachable, and its fund empty or never added to */
export const needsFunding = (view: SpaceHostingView): boolean =>
  view.fund !== null && !view.error && view.status?.state !== 'active';

/**
 * How a space stands at a host, as a pill and one line. Each says what
 * happens next, not only that it is off: a host named and never paid waits
 * for its fund, one that was paid waits for a member's device to hand the
 * space over, and one that can't be reached says why.
 */
export function standing(view: SpaceHostingView): { tone: Tone; pill: string; line: string } {
  if (view.error) return { tone: 'bad', pill: "Can't reach host", line: view.error };
  const status = view.status;
  if (!status || status.state === 'none') {
    if (view.fund)
      return {
        tone: 'warn',
        pill: 'Not paid yet',
        line: `Turns on once there is money in its fund · $${view.fund.monthly} a month`,
      };
    if (!view.free)
      return { tone: 'neutral', pill: 'Off', line: `${view.name} doesn't keep communities online` };
  }
  if (status?.state === 'lapsed')
    return {
      tone: 'bad',
      pill: 'Off',
      line: view.fund ? 'The fund ran out. Add to it to turn it back on' : `It lapsed at ${view.name}`,
    };
  if (!status?.carrying)
    return {
      tone: 'neutral',
      pill: 'Waiting',
      line: `${view.name} takes it the next time a member's device is online`,
    };
  if (!view.fund) return { tone: 'good', pill: 'Online', line: `Free at ${view.name}` };
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
 * tab, Liquid's People): the host, how the space stands there, and what can
 * be done about it. Anyone chips in; whoever may manage the space turns it
 * on, and stops using a host. A host that can't be reached is asked again.
 */
export function SpaceHosting({ spaceId, writable }: { spaceId: string; writable: boolean }) {
  const { hosts, look, looking, mayChoose } = useSpaceHosts(spaceId, writable);
  const [dialog, setDialog] = useState<'keep' | 'stop' | null>(null);
  const host = hosts?.[0];
  const view = host ? standing(host) : null;
  const close = () => {
    setDialog(null);
    look();
  };
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
        <HostStatusRow
          size={36}
          name={hosts === null ? 'Asking the host…' : host ? host.name : 'Online only while someone is'}
          pill={view}
          line={
            hosts === null
              ? 'One moment.'
              : view
                ? view.line
                : mayChoose
                  ? 'A host can keep it reachable when everyone is offline, without reading it.'
                  : 'A host can keep it reachable when everyone is offline. An admin can turn that on.'
          }
        >
          {host?.error && (
            <button onClick={look} disabled={looking} data-variant="quiet" style={styles.smallButton}>
              {looking ? 'Asking…' : 'Try again'}
            </button>
          )}
          {host?.fund && (
            <button
              onClick={() => setDialog('keep')}
              data-variant={needsFunding(host) ? 'primary' : 'quiet'}
              style={needsFunding(host) ? styles.darkSmall : styles.smallButton}
            >
              {needsFunding(host) ? 'Add to the fund' : 'Chip in'}
            </button>
          )}
          {host && mayChoose && (
            <button onClick={() => setDialog('stop')} data-variant="danger" style={styles.smallButton}>
              Remove
            </button>
          )}
          {hosts !== null && !host && mayChoose && (
            <button onClick={() => setDialog('keep')} data-variant="primary" style={styles.darkSmall}>
              Turn on
            </button>
          )}
        </HostStatusRow>
      </div>
      {dialog === 'keep' && <KeepOnlineDialog spaceId={spaceId} writable={writable} onClose={close} />}
      {dialog === 'stop' && host && (
        <Modal title={`Stop using ${host.name}?`} onClose={close} width={460}>
          <StopHost spaceId={spaceId} host={host} onKeep={close} onStopped={close} />
        </Modal>
      )}
    </section>
  );
}

/**
 * Stopping a host, said plainly before it happens (`hosting.stopForSpace`):
 * its bots are removed and a private space gets a new key. What the host
 * has stays there, unreadable, as does the fund.
 */
function StopHost({
  spaceId,
  host,
  onKeep,
  onStopped,
}: {
  spaceId: string;
  host: SpaceHostingView;
  onKeep: () => void;
  onStopped: () => void;
}) {
  const node = useNode();
  const access = useAccess(spaceId);
  const { run, busy, error } = useAction();
  const mayManage = roleHolds(access?.role, MANAGE);
  const members = new Set(access?.members.map((member) => member.did));
  const bots = host.bots.filter((bot) => members.has(bot.bot));
  const botNames = bots.map((bot) => bot.name).join(' and ');
  // As the node decides it: a host that can't say whether it was handed the space is taken to have been.
  const handed = host.status ? host.status.carrying : true;
  const newKey = mayManage && access?.key != null && (bots.length > 0 || handed);
  const balance = host.status?.balance ?? 0;
  const stop = () => void run(() => node.hosting.stopForSpace(spaceId, host.url).then(onStopped));
  const said = { fontSize: 14, color: palette.ink.body, lineHeight: 1.5 };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={said}>
        Members' devices stop handing this community to {host.name}, so it is reachable only while one of them
        is online.
      </p>
      {bots.length > 0 && (
        <p style={said}>
          {mayManage
            ? `${botNames} ${bots.length === 1 ? 'is' : 'are'} removed from the community: ${host.name} runs ${bots.length === 1 ? 'it' : 'them'}.`
            : `${botNames} ${bots.length === 1 ? 'stays' : 'stay'} until an admin removes ${bots.length === 1 ? 'it' : 'them'}: ${host.name} reads what ${bots.length === 1 ? 'it' : 'they'} can read.`}
        </p>
      )}
      {host.error && (
        <p style={said}>
          {host.name} can't be asked which bots it runs here. If it runs any, remove them under People.
        </p>
      )}
      {newKey && (
        <p style={said}>
          The community gets a new key, so {host.name} can't follow it from here on. View-only links made
          before stop working.
        </p>
      )}
      {host.status?.carrying && (
        <p style={said}>
          {host.fund
            ? `What ${host.name} already has stays there, unreadable, until the fund runs out.`
            : `What ${host.name} already has stays unreadable.`}
          {balance > 0 ? ` The ${dollars(balance)} in the fund stays with it too.` : ''}
        </p>
      )}
      {host.fund?.recurring && (
        <p style={said}>
          A card that adds every month keeps being charged until whoever set it up stops it
          {host.fund.manage ? (
            <>
              {' '}
              <a
                href={host.fund.manage}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: palette.ink.strong }}
              >
                at the payment provider
              </a>
            </>
          ) : null}
          .
        </p>
      )}
      <StopFooter name={host.name} busy={busy} error={error} onKeep={onKeep} onStop={stop} />
    </div>
  );
}

/** The dialog for keeping a space online: choosing a host, then its fund */
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
 * What the dialog shows, for other dialogs to show too: without `hero`, no
 * heading of its own. Choosing a host names it in the space at once, before
 * anyone pays, so any member can add to its fund from then on.
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
  const { hosts, look, looking, defined, mayChoose } = useSpaceHosts(spaceId, writable);
  const wanted = useWanted();
  const { offer, asked: offerAsked } = useOffer();
  const { run, busy, error: problem } = useAction();
  const [stopping, setStopping] = useState(false);
  // The host just chosen, until the space's hosts show it.
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (!chosen) return;
    const timer = setTimeout(() => setChosen(null), CHOSEN_SHOWS_MS);
    return () => clearTimeout(timer);
  }, [chosen]);

  /** Names the host at an address as the space's, once it answered as one and is still wanted */
  const choose = async (url: string, stillWanted: Wanted) => {
    const description = await describeHost(url);
    if (!stillWanted()) return;
    if (!defined) await node.collections.define(spaceId, hostSchema);
    await node.records.put(spaceId, hostSchema.name, {
      url,
      did: description.did,
      name: description.name,
    });
    setChosen(url);
    look();
  };

  const host = hosts?.[0];
  const balance = host?.status?.balance ?? 0;
  const settling = chosen !== null && !host;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {hero && !stopping && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="online" glyph="cloud" size={44} />
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {host ? host.name : 'Around the clock'}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted, overflowWrap: 'anywhere' }}>
              {host ? standing(host).line : 'Paid from a fund anyone in the community can add to'}
            </p>
          </div>
        </div>
      )}

      {hosts === null || settling ? (
        <p role="status" style={{ fontSize: 13, color: palette.ink.muted }}>
          One moment…
        </p>
      ) : host && stopping ? (
        <>
          <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>Stop using {host.name}?</p>
          <StopHost
            spaceId={spaceId}
            host={host}
            onKeep={() => setStopping(false)}
            onStopped={() => {
              // Shown inside another dialog, this stays open: back to choosing a host.
              setStopping(false);
              setChosen(null);
              look();
              onClose();
            }}
          />
        </>
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
          ) : !offerAsked ? (
            <p role="status" style={{ fontSize: 13, color: palette.ink.muted }}>
              One moment…
            </p>
          ) : (
            <HostOfferPicker
              offer={offer}
              price={
                offer?.free
                  ? 'Free'
                  : offer?.fund
                    ? `$${offer.fund.monthly} a month, from the fund`
                    : (offer?.price ?? '')
              }
              busy={busy}
              onContinue={() => void run(() => choose(DEFAULT_HOST ?? '', wanted))}
              onAddress={choose}
            />
          )}
        </>
      ) : host.error ? (
        <>
          <p style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
            {host.name} couldn't be asked just now, so nothing can be paid or checked there. The community
            stays on its members' devices either way.
          </p>
          <button onClick={look} disabled={looking} data-variant="primary" style={styles.button}>
            {looking ? 'Asking…' : 'Try again'}
          </button>
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
        <>
          {!host.free && (
            <p style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
              {host.name} takes no payments from communities, so it can't keep this one online.
            </p>
          )}
          <button onClick={onClose} data-variant="primary" style={styles.button}>
            Done
          </button>
        </>
      )}

      {problem && (
        <p role="alert" style={{ fontSize: 13, color: palette.accent.danger }}>
          {problem}
        </p>
      )}
      {host && mayChoose && !stopping && !settling && (
        <button
          onClick={() => setStopping(true)}
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
