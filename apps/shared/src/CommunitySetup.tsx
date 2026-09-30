import { useCallback, useEffect, useState } from 'react';
import { DEFINE, MANAGE, roleHolds } from '@weaveprotocol/core';
import type { SpaceHostingView } from '@weaveprotocol/core';
import { useAccess, useCollections, useNode } from '@weaveprotocol/core/react';
import { profile } from '@weaveprotocol/core/schemas';
import { SpaceHosting } from './SpaceHosting';
import { Payment } from './Payment';
import { styles, palette } from './styles';

/** Where running a bot on a server is explained */
const SERVER_GUIDE =
  'https://github.com/leifriksheim/weave/blob/main/packages/cli/README.md#always-on-on-a-server';
const HIDDEN_KEY = 'weave-community-setup-hidden';
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
 * What an admin sets a community up with, at the top of its screen: keeping
 * it online (a host the space pays for together) and adding a bot (an AI
 * helper with an account of its own, holding a role here like any member),
 * which that host runs.
 * Each step says when it is done. Only those who may manage the space see it.
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
  const [open, setOpen] = useState<'hosting' | 'bot' | null>(null);
  const [hosts, setHosts] = useState<ReadonlyArray<SpaceHostingView>>([]);
  const [bots, setBots] = useState<ReadonlyArray<{ did: string; name: string }>>([]);
  const [hidden, setHidden] = useState(() => readHidden().includes(spaceId));
  const mayManage = writable && roleHolds(access?.role, MANAGE);

  const look = useCallback(() => {
    void node.hosting.space(spaceId).then(setHosts, () => setHosts([]));
    void botsIn(node, spaceId).then(setBots, () => setBots([]));
  }, [node, spaceId]);
  useEffect(() => {
    if (!mayManage) return;
    look();
    // Waiting on a bot to join, or a payment to land: look again now and then.
    const timer = setInterval(look, 10_000);
    return () => clearInterval(timer);
  }, [look, mayManage]);

  if (!mayManage) return null;
  const online = hosts.find(
    (host) => host.status?.carrying && (host.status.state === 'active' || host.status.state === 'grace'),
  );
  // The bots the community's host runs here, as it says; and what the step says of them.
  const hosted = online?.bots ?? [];
  const done = !!online && (bots.length > 0 || hosted.some((bot) => bot.status.carrying));
  const waiting = hosted.filter((bot) => !bot.status.carrying);
  const botDetail = !online
    ? 'An AI helper with its own account, holding a role like any member. It runs at the host that keeps the community online, so keep it online first.'
    : hosted.length || bots.length
      ? [
          ...hosted.map(
            (bot) => `${bot.name} ${bot.status.carrying ? `runs at ${online.name}` : 'waits to be paid for'}`,
          ),
          ...bots.filter((bot) => !hosted.some((h) => h.bot === bot.did)).map((bot) => `${bot.name} is here`),
        ].join(' · ') + (waiting.length ? '' : '. Tell it what to do in automations.')
      : `An AI helper with its own account: it answers, sums up and keeps things tidy. ${online.name} runs it, and it holds a role like any member, so it can do only what the role allows.`;
  if (hidden && done) return null;

  const until = online?.status?.paidUntil
    ? new Date(online.status.paidUntil * 1000).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
      })
    : null;

  return (
    <section
      aria-label="Set up this community"
      style={{
        border: `1px solid ${palette.surface.line}`,
        borderRadius: 12,
        padding: 16,
        marginBottom: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        background: palette.surface.card,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <h2 style={{ ...styles.sectionTitle, fontSize: 16 }}>Set up this community</h2>
        {done && (
          <button
            data-variant="quiet"
            style={styles.smallButton}
            onClick={() => {
              writeHidden([...readHidden(), spaceId]);
              setHidden(true);
            }}
          >
            Hide
          </button>
        )}
      </div>

      <Step
        done={!!online}
        title="Keep it online"
        detail={
          online
            ? `${online.name} keeps it online${until ? `, funded until ${until}` : ''}. Anyone here can chip in.`
            : 'A host keeps the community reachable when nobody has it open, without being able to read it. Everyone can chip in.'
        }
        action={open === 'hosting' ? 'Close' : online ? 'Manage' : 'Keep it online'}
        onAction={() => setOpen(open === 'hosting' ? null : 'hosting')}
      />
      {open === 'hosting' && (
        <div style={{ paddingLeft: 32 }}>
          <SpaceHosting spaceId={spaceId} writable={writable} />
        </div>
      )}

      <Step
        done={bots.length > 0 || hosted.some((bot) => bot.status.carrying)}
        title="Add a bot"
        detail={botDetail}
        action={
          !online
            ? 'Keep it online first'
            : open === 'bot'
              ? 'Close'
              : bots.length || hosted.length
                ? 'Manage'
                : 'Add a bot'
        }
        onAction={() => (!online ? setOpen('hosting') : setOpen(open === 'bot' ? null : 'bot'))}
      />
      {open === 'bot' && online && (
        <div style={{ paddingLeft: 32 }}>
          <AddBot
            spaceId={spaceId}
            host={online}
            cli={cli}
            onAutomations={onAutomations}
            joined={bots.length > 0}
            onChange={look}
          />
        </div>
      )}
    </section>
  );
}

function Step({
  done,
  title,
  detail,
  action,
  onAction,
}: {
  done: boolean;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          flexShrink: 0,
          marginTop: 1,
          display: 'grid',
          placeItems: 'center',
          fontSize: 12,
          color: done ? '#fff' : palette.ink.faint,
          background: done ? palette.accent.good : 'transparent',
          border: done ? 'none' : `1.5px solid ${palette.surface.line}`,
        }}
      >
        {done ? '✓' : ''}
      </span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <p style={{ fontSize: 14, fontWeight: 600, color: palette.ink.strong }}>{title}</p>
        <p style={{ fontSize: 13, color: palette.ink.muted, lineHeight: 1.5 }}>{detail}</p>
      </div>
      <button
        onClick={onAction}
        data-variant={done ? 'quiet' : undefined}
        style={done ? styles.smallButton : styles.addButton}
      >
        {action}
      </button>
    </div>
  );
}

/**
 * Adding a bot, hosting first: its name and the role it should hold, and the
 * community's host makes its account, joins and runs it, paid for like the
 * hosting (anyone may chip in). The host holds the bot's account, so it reads
 * what the bot may read, and the card says so. Running it yourself is folded
 * away, for those who want to: the one command that does the same on their
 * own computer or server.
 */
function AddBot({
  spaceId,
  host,
  cli,
  onAutomations,
  joined,
  onChange,
}: {
  spaceId: string;
  host: SpaceHostingView;
  cli: string;
  onAutomations: (() => void) | undefined;
  joined: boolean;
  onChange: () => void;
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
  const [yourself, setYourself] = useState(!host.runsBots);
  const chosen = role ?? roles[0]?.name ?? null;
  const called = name.trim() || 'Club Bot';
  const price = host.botPlans.map((plan) => plan.label).join(', or ');

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await node.hosting.startBot(spaceId, host.url, { name: called, ...(chosen ? { role: chosen } : {}) });
      setName('');
      onChange();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const paidSince = (bot: string) => async () => {
    const now = await node.hosting.space(spaceId);
    const running = now
      .find((known) => known.url === host.url)
      ?.bots.some((b) => b.bot === bot && b.status.carrying);
    if (running) onChange();
    return !!running;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {host.bots
        .filter((bot) => !bot.status.carrying && host.botPlans.length > 0)
        .map((bot) => (
          <div key={bot.bot} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ fontSize: 14, color: palette.ink.strong }}>
              {bot.name} has joined, and starts once it is paid for. Anyone here can chip in.
            </p>
            <Payment
              plans={host.botPlans}
              start={(plan) => node.hosting.payForBot(spaceId, host.url, bot.bot, plan)}
              paid={paidSince(bot.bot)}
            />
          </div>
        ))}

      {host.runsBots ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 13,
                color: palette.ink.muted,
              }}
            >
              Its name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Club Bot"
                aria-label="The bot's name"
                style={{ ...styles.input, width: 180 }}
              />
            </label>
            {roles.length > 0 && (
              <label
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  fontSize: 13,
                  color: palette.ink.muted,
                }}
              >
                Its role
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
          <p style={{ ...styles.errorHint, marginTop: 0 }}>
            {host.name} runs it{price ? ` for ${price}` : ', at no cost'}, AI use included. It holds the bot's
            account, so it can read what the bot can read. Give it the lowest role that can do its job: a
            misled bot can still do only what its role allows.
          </p>
          <button onClick={() => void start()} disabled={busy} style={styles.addButton}>
            {busy ? 'Starting…' : `Start ${called} at ${host.name}`}
          </button>
          {problem && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{problem}</p>}
        </div>
      ) : (
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          {host.name} doesn't run bots. You can run one yourself.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p style={{ fontSize: 14, color: palette.ink.strong }}>Tell it what to do</p>
        <p style={{ ...styles.errorHint, marginTop: 0 }}>
          {joined ? 'It has joined. ' : 'Once it has joined, it shows here. '}
          Automations say what it does: answer when mentioned, post a plan every morning.
        </p>
        {onAutomations && (
          <button
            onClick={onAutomations}
            data-variant="quiet"
            style={{ ...styles.smallButton, alignSelf: 'flex-start' }}
          >
            Open automations
          </button>
        )}
        {!profiles && (
          <p style={{ ...styles.errorHint, marginTop: 4 }}>
            This space keeps no profiles yet, so it can't tell the bot is one, and nobody can pick it under
            "Done by".{' '}
            {mayDefine ? (
              <button
                data-variant="quiet"
                style={styles.smallButton}
                onClick={() =>
                  void node.collections
                    .define(spaceId, profile)
                    .catch((error: unknown) =>
                      setProblem(error instanceof Error ? error.message : String(error)),
                    )
                }
              >
                Keep profiles here
              </button>
            ) : (
              'Someone who may add collections here can add them.'
            )}
          </p>
        )}
      </div>

      <div>
        <button data-variant="quiet" style={styles.smallButton} onClick={() => setYourself(!yourself)}>
          {yourself ? 'Hide' : 'Run it yourself instead'}
        </button>
        {yourself && <RunItYourself spaceId={spaceId} cli={cli} name={called} role={chosen} />}
      </div>
    </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <p style={{ ...styles.errorHint, marginTop: 0 }}>
        On your own computer or server, with your own model key. It works while it runs; to keep it on, run it
        on a server:{' '}
        <a href={SERVER_GUIDE} target="_blank" rel="noopener noreferrer">
          how to run a bot on Fly
        </a>
        .
      </p>
      {invite ? (
        <>
          <Copyable text={`${cli} agent --bot --name ${quoted(name)} --invite ${quoted(invite)}`} secret />
          <p style={{ ...styles.errorHint, marginTop: 0 }}>
            Run it in a terminal. It makes {name}'s account in a folder of its own, asks for a password for it
            and a model's API key, and joins. Keep the command to yourself: whoever has it can join as the
            bot's role.
          </p>
        </>
      ) : (
        <button
          data-variant="quiet"
          style={{ ...styles.smallButton, alignSelf: 'flex-start' }}
          onClick={() => void make()}
        >
          Make the command
        </button>
      )}
      {problem && <p style={{ ...styles.errorHint, color: palette.accent.danger }}>{problem}</p>}
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
        marginTop: 6,
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

/** The bots holding a role in a space: members whose profile there says `bot: true` */
async function botsIn(
  node: ReturnType<typeof useNode>,
  spaceId: string,
): Promise<ReadonlyArray<{ did: string; name: string }>> {
  const collections = await node.collections.list(spaceId);
  if (!collections.some((c) => c.name === 'std.profile' && c.version !== null)) return [];
  const members = new Set((await node.spaces.access(spaceId)).members.map((member) => member.did));
  const names = new Map((await node.spaces.profiles(spaceId)).map((profile) => [profile.did, profile.name]));
  const profiles = await node.records.list<{ bot?: unknown }>(spaceId, { collection: 'std.profile' });
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

function readHidden(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeHidden(ids: ReadonlyArray<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    // Hidden for this visit only.
  }
}
