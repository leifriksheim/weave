import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { DEFINE, MANAGE, describeHost, roleHolds } from '@weaveprotocol/core';
import type { HostDescription, HostedBot, SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { profile } from '@weaveprotocol/core/schemas';
import { DEFAULT_HOST } from './relay';
import { Modal } from './Modal';
import { PayFlow } from './Payment';
import { Benefit, FeatureIcon, Glyph, StatusPill } from './Feature';
import { KeepOnlineDialog, darkSmall, onlineHost, standing, useSpaceHosts } from './SpaceHosting';
import { styles, palette } from './styles';

/** Where running a bot on a server is explained */
const SERVER_GUIDE =
  'https://github.com/leifriksheim/weave/blob/main/packages/cli/README.md#always-on-on-a-server';
const HIDDEN_KEY = 'weave-community-upgrades-hidden';
/** How long "Not now" keeps the upgrades out of the way */
const NOT_NOW_MS = 30 * 24 * 3600 * 1000;
/**
 * How the CLI is run where this app is built, from the connect command
 * (`VITE_WEAVE_CONNECT`): `npx @weaveprotocol/cli`, or in this repo
 * `npm run weave --`, whose `--` hands the flags after it to the CLI, not npm.
 */
const CLI = (import.meta.env.VITE_WEAVE_CONNECT ?? 'npx @weaveprotocol/cli connect').replace(
  /\s+connect$/,
  '',
);

/**
 * What an admin can add to a community, at the top of its screen, shown the
 * way the app shows anything worth having: two tiles, each with what it does
 * in a line, its price or how it stands, and one button. **Always online**
 * (a host the community pays for together) and **an AI helper** (a bot that
 * host runs). The details, and paying, are in a dialog. Quiet by design: only
 * those who may manage the community see it, and "Not now" puts it away for a
 * month.
 *
 * `cli` is how the CLI is run, when not the build's own (`CLI`).
 * `onAutomations` opens the space's automations, where a bot is told what to
 * do.
 */
export function CommunitySetup({
  spaceId,
  writable,
  cli = CLI,
  onAutomations,
}: {
  spaceId: string;
  writable: boolean;
  cli?: string;
  onAutomations?: () => void;
}) {
  const node = useNode();
  const access = useAccess(spaceId);
  const { hosts, look } = useSpaceHosts(spaceId, writable);
  const [offer, setOffer] = useState<HostDescription | null>(null);
  const [bots, setBots] = useState<ReadonlyArray<{ did: string; name: string }>>([]);
  const [dialog, setDialog] = useState<'online' | 'bot' | null>(null);
  // Put away with "Not now" until a date, asked once when it first shows.
  const [hidden, setHidden] = useState(() => (readHidden()[spaceId] ?? 0) > Date.now());
  const mayManage = writable && roleHolds(access?.role, MANAGE);

  const lookBots = useCallback(() => {
    void botsIn(node, spaceId).then(setBots, () => setBots([]));
  }, [node, spaceId]);
  useEffect(() => {
    if (!mayManage) return;
    lookBots();
    if (DEFAULT_HOST) void describeHost(DEFAULT_HOST).then(setOffer, () => {});
    // A bot joining, or a payment landing, shows without a reload.
    const timer = setInterval(() => {
      look();
      lookBots();
    }, 15_000);
    return () => clearInterval(timer);
  }, [mayManage, look, lookBots]);

  if (!mayManage || hosts === null || hidden) return null;
  const online = onlineHost(hosts);
  const host = hosts[0];
  const hosted = online?.bots ?? [];
  const running = hosted.filter((bot) => bot.status.carrying);
  const botNames = [
    ...running.map((bot) => bot.name),
    ...bots.filter((bot) => !hosted.some((h) => h.bot === bot.did)).map((bot) => bot.name),
  ];
  const onlineView = host ? standing(host) : null;
  const botPrice = online?.botPlans[0]
    ? splitPrice(online.botPlans[0].label)
    : online?.runsBots
      ? 'Free'
      : null;

  const close = () => {
    setDialog(null);
    look();
    lookBots();
  };

  return (
    <section aria-label="Upgrade this community" style={{ marginBottom: 28 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}
      >
        <p style={{ fontSize: 12, fontWeight: 500, color: palette.ink.muted, letterSpacing: 0.2 }}>
          For this community
        </p>
        <button
          onClick={() => {
            const until = Date.now() + NOT_NOW_MS;
            writeHidden({ ...readHidden(), [spaceId]: until });
            setHidden(true);
          }}
          style={{ ...styles.linkButton, padding: 0, fontSize: 12 }}
        >
          Not now
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <Tile
          icon={<FeatureIcon kind="online" glyph="cloud" />}
          title="Always online"
          pill={
            onlineView && host?.status ? (
              <StatusPill tone={onlineView.tone}>{onlineView.pill}</StatusPill>
            ) : null
          }
          detail="Reachable when everyone's offline. Encrypted, so the host can't read it."
          meta={online ? onlineView?.line : offer ? (offer.free ? 'Free' : offer.price) : undefined}
          action={
            online ? (
              <button onClick={() => setDialog('online')} data-variant="quiet" style={styles.smallButton}>
                Manage
              </button>
            ) : (
              <button onClick={() => setDialog('online')} data-variant="primary" style={darkSmall}>
                {host ? 'Finish' : 'Turn on'}
              </button>
            )
          }
        />
        <Tile
          icon={<FeatureIcon kind="bot" glyph="sparkle" />}
          title="AI helper"
          pill={
            botNames.length ? (
              <StatusPill tone="good">
                {botNames.length === 1 ? `${botNames[0]} is on` : `${botNames.length} on`}
              </StatusPill>
            ) : hosted.length ? (
              <StatusPill tone="warn">Waiting for payment</StatusPill>
            ) : null
          }
          detail="A bot that answers questions, sums up long threads and posts reminders."
          meta={
            !online ? (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Glyph name="lock" size={12} /> Needs Always online
              </span>
            ) : botPrice ? (
              `${botPrice}, AI use included`
            ) : (
              `${online.name} doesn't run bots`
            )
          }
          action={
            <button
              onClick={() => setDialog('bot')}
              disabled={!online}
              data-variant={botNames.length || !online ? 'quiet' : 'primary'}
              style={botNames.length || !online ? styles.smallButton : darkSmall}
            >
              {botNames.length ? 'Manage' : hosted.length ? 'Finish' : 'Add a bot'}
            </button>
          }
        />
      </div>

      {dialog === 'online' && <KeepOnlineDialog spaceId={spaceId} writable={writable} onClose={close} />}
      {dialog === 'bot' && online && (
        <AddBotDialog
          spaceId={spaceId}
          host={online}
          cli={cli}
          running={botNames}
          onAutomations={
            onAutomations
              ? () => {
                  close();
                  onAutomations();
                }
              : undefined
          }
          onClose={close}
        />
      )}
    </section>
  );
}

/** One upgrade: its icon, what it does in a line, its price or state, and one button */
function Tile({
  icon,
  title,
  pill,
  detail,
  meta,
  action,
}: {
  icon: ReactNode;
  title: string;
  pill: ReactNode;
  detail: string;
  meta: ReactNode;
  action: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        border: `1px solid ${palette.surface.line}`,
        background: palette.surface.card,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {icon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 22 }}>
            <strong style={{ fontSize: 14, color: palette.ink.strong }}>{title}</strong>
            {pill}
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.45, color: palette.ink.muted, marginTop: 2 }}>{detail}</p>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 'auto',
        }}
      >
        <span style={{ fontSize: 12.5, color: palette.ink.faint, minWidth: 0 }}>{meta}</span>
        {action}
      </div>
    </div>
  );
}

/** "$10 a month, from a wallet (USDC on Base)" as its price: "$10 a month" */
function splitPrice(label: string): string {
  const comma = label.indexOf(', ');
  return comma < 0 ? label : label.slice(0, comma);
}

/**
 * Adding a bot, hosting first. Its name and role, what it costs, and Add;
 * then, on a host that charges for it, paying for its first month; then what
 * to tell it to do. The trust it takes is said plainly but small: the host
 * runs the bot's account, so it can read what the bot can read. Running it
 * yourself is a link at the bottom, for those who want to.
 */
function AddBotDialog({
  spaceId,
  host,
  cli,
  running,
  onAutomations,
  onClose,
}: {
  spaceId: string;
  host: SpaceHostingView;
  cli: string;
  running: ReadonlyArray<string>;
  onAutomations: (() => void) | undefined;
  onClose: () => void;
}) {
  const node = useNode();
  const access = useAccess(spaceId);
  const collections = useCollections(spaceId);
  const profiles = collections.some((c) => c.name === profile.name && c.version !== null);
  const mayDefine = roleHolds(access?.role, DEFINE);
  // Roles below one's own, lowest first: what an invite may give. A bot needs no more than it must.
  const mine = access?.roles.findIndex((role) => role.name === access.role?.name) ?? -1;
  const roles = (access?.roles ?? []).slice(mine + 1).reverse();
  const [role, setRole] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<HostedBot | null>(
    () => host.bots.find((bot) => !bot.status.carrying && host.botPlans.length > 0) ?? null,
  );
  const [view, setView] = useState<'add' | 'pay' | 'done' | 'yourself'>(
    started ? 'pay' : running.length ? 'done' : 'add',
  );
  const chosen = role ?? roles[0]?.name ?? null;
  const called = name.trim() || 'Club Bot';
  const price = host.botPlans[0] ? splitPrice(host.botPlans[0].label) : null;

  const add = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const bot = await node.hosting.startBot(spaceId, host.url, {
        name: called,
        ...(chosen ? { role: chosen } : {}),
      });
      setStarted(bot);
      setView(bot.status.carrying || host.botPlans.length === 0 ? 'done' : 'pay');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add an AI helper" onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <FeatureIcon kind="bot" glyph="sparkle" size={44} />
          <div>
            <p style={{ fontSize: 16, fontWeight: 600, color: palette.ink.strong }}>
              {view === 'pay' && started ? `Start ${started.name}` : started ? started.name : called}
            </p>
            <p style={{ fontSize: 13, color: palette.ink.muted }}>
              {view === 'pay'
                ? 'It has joined. It starts working once its first month is paid.'
                : `Runs at ${host.name}${price ? ` · ${price}, AI use included` : ', at no cost'}`}
            </p>
          </div>
        </div>

        {view === 'add' && (
          <>
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Benefit glyph="chat">Answers when someone mentions it</Benefit>
              <Benefit glyph="clock">Posts summaries and reminders on a schedule</Benefit>
              <Benefit glyph="shield">Holds a role like any member, and can do only what it allows</Benefit>
            </ul>
            <div style={{ display: 'flex', gap: 10 }}>
              <label
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontSize: 12.5,
                  color: palette.ink.muted,
                }}
              >
                Name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Club Bot"
                  style={styles.input}
                />
              </label>
              {roles.length > 0 && (
                <label
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    fontSize: 12.5,
                    color: palette.ink.muted,
                  }}
                >
                  Role
                  <select
                    value={chosen ?? ''}
                    onChange={(event) => setRole(event.target.value)}
                    style={{ ...styles.input, width: 'auto' }}
                  >
                    {roles.map((known) => (
                      <option key={known.name} value={known.name}>
                        {known.title ?? known.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button onClick={() => void add()} disabled={busy} data-variant="primary" style={styles.button}>
              {busy ? 'Adding…' : `Add ${called}`}
            </button>
            {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
            <p style={{ display: 'flex', gap: 8, fontSize: 12, color: palette.ink.faint, lineHeight: 1.5 }}>
              <Glyph name="lock" size={12} style={{ marginTop: 2 }} />
              {host.name} runs the bot's account, so it can read what the bot can read. The rest of the
              community stays encrypted to it.
            </p>
            <button
              onClick={() => setView('yourself')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Run it on your own computer instead
            </button>
          </>
        )}

        {view === 'pay' && started && (
          <PayFlow
            plans={host.botPlans}
            start={(plan) => node.hosting.payForBot(spaceId, host.url, started.bot, plan)}
            paid={async () =>
              !!(await node.hosting.space(spaceId))
                .find((known) => known.url === host.url)
                ?.bots.some((bot) => bot.bot === started.bot && bot.status.carrying)
            }
            onDone={() => setView('done')}
          />
        )}

        {view === 'done' && (
          <>
            <p style={{ fontSize: 14, color: palette.ink.body, lineHeight: 1.5 }}>
              {started
                ? `${started.name} is in the community.`
                : `${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} on.`}{' '}
              Tell it what to do in Automations: answer when mentioned, sum up the week every Friday.
            </p>
            {!profiles && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 10,
                  background: palette.surface.sunken,
                  fontSize: 13,
                  color: palette.ink.muted,
                  lineHeight: 1.5,
                }}
              >
                This community keeps no profiles yet, so nobody can see it's a bot or pick it under "Done by".{' '}
                {mayDefine ? (
                  <button
                    onClick={() =>
                      void node.collections
                        .define(spaceId, profile)
                        .catch((error: unknown) =>
                          setProblem(error instanceof Error ? error.message : String(error)),
                        )
                    }
                    style={{ ...styles.linkButton, padding: 0, color: palette.ink.strong }}
                  >
                    Turn on profiles
                  </button>
                ) : (
                  'An admin who may add collections can turn them on.'
                )}
              </div>
            )}
            {onAutomations ? (
              <button onClick={onAutomations} data-variant="primary" style={styles.button}>
                Open Automations
              </button>
            ) : (
              <button onClick={onClose} data-variant="primary" style={styles.button}>
                Done
              </button>
            )}
            <button
              onClick={() => setView('add')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Add another bot
            </button>
          </>
        )}

        {view === 'yourself' && (
          <>
            <RunItYourself spaceId={spaceId} cli={cli} name={called} role={chosen} />
            <button
              onClick={() => setView('add')}
              style={{ ...styles.linkButton, alignSelf: 'center', fontSize: 12 }}
            >
              Let {host.name} run it instead
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * For those who want to run the bot themselves: an invite for its role, and
 * the command that makes its account and joins, on their own computer or a
 * server of theirs, with their own model key.
 */
function RunItYourself({
  spaceId,
  cli,
  name,
  role,
}: {
  spaceId: string;
  cli: string;
  name: string;
  role: string | null;
}) {
  const node = useNode();
  const [invite, setInvite] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Single quotes around what the person typed: nothing in it is read by the shell.
  const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const make = async () => {
    setProblem(null);
    try {
      setInvite(await node.spaces.invite(spaceId, role ? { role } : {}));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>
        Run {name} on your own computer or server, with your own AI key. It works while it runs; to keep it
        on,{' '}
        <a
          href={SERVER_GUIDE}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: palette.ink.strong }}
        >
          run it on a server
        </a>
        .
      </p>
      {invite ? (
        <>
          <Copyable text={`${cli} agent --bot --name ${quoted(name)} --invite ${quoted(invite)}`} secret />
          <p style={{ fontSize: 12, color: palette.ink.faint, lineHeight: 1.5 }}>
            Paste it into a terminal. It asks for a password for the bot and an AI key, then joins. Keep it to
            yourself: whoever has it can join as the bot.
          </p>
        </>
      ) : (
        <button
          onClick={() => void make()}
          data-variant="quiet"
          style={{ ...styles.smallButton, alignSelf: 'flex-start' }}
        >
          Make the command
        </button>
      )}
      {problem && <p style={{ fontSize: 13, color: palette.accent.danger }}>{problem}</p>}
    </div>
  );
}

/** A line to copy, in full or, for a secret, shortened on screen */
function Copyable({ text, secret = false }: { text: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 6px 6px 10px',
        borderRadius: 8,
        border: `1px solid ${palette.surface.line}`,
        background: palette.surface.sunken,
      }}
    >
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: secret ? 'nowrap' : 'normal',
          overflowWrap: 'anywhere',
          color: palette.ink.strong,
        }}
      >
        {text}
      </code>
      <button
        data-variant="quiet"
        style={{ ...styles.smallButton, flexShrink: 0 }}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** The bots holding a role in a space: members whose own profile there says `bot: true` */
async function botsIn(
  node: ReturnType<typeof useNode>,
  spaceId: string,
): Promise<ReadonlyArray<{ did: string; name: string }>> {
  const collections = await node.collections.list(spaceId);
  if (!collections.some((c) => c.name === profile.name && c.version !== null)) return [];
  const members = new Set((await node.spaces.access(spaceId)).members.map((member) => member.did));
  const names = new Map((await node.spaces.profiles(spaceId)).map((known) => [known.did, known.name]));
  const profiles = await node.records.list<{ bot?: unknown }>(spaceId, { collection: profile.name });
  return profiles.flatMap((record) =>
    !record.deleted &&
    record.body?.bot === true &&
    // Their own word: only a profile its own account wrote says it is a bot.
    record.root === record.createdBy &&
    record.root &&
    members.has(record.root)
      ? [{ did: record.root, name: names.get(record.root) ?? 'A bot' }]
      : [],
  );
}

function readHidden(): Record<string, number> {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}');
    if (typeof kept !== 'object' || kept === null || Array.isArray(kept)) return {};
    return Object.fromEntries(
      Object.entries(kept).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
  } catch {
    return {};
  }
}

function writeHidden(hidden: Record<string, number>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  } catch {
    // Hidden for this visit only.
  }
}
