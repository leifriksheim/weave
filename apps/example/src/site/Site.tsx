import { useId, useState, type ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import { Walkthrough } from './Walkthrough';
import './site.css';

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/**
 * The site's pages — the front page, for communities, at `/` (in `Home.tsx`),
 * for developers at `/developers`, and how the protocol works at `/protocol`
 * (in `Protocol.tsx`), and the Chrome extension at `/extension` (in
 * `Extension.tsx`) — living in the example app for now, so they share its
 * fonts, colours and deploy. The app itself is at `/app`.
 */

export const GITHUB = 'https://github.com/leifriksheim/weave';
export const SPEC = `${GITHUB}/tree/main/spec`;
/** Links off the site open in a tab of their own */
export const EXTERNAL = { target: '_blank', rel: 'noreferrer' } as const;

function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <path
        d="M2 5 L7 15 L10 8 L13 15 L18 5"
        fill="none"
        stroke="#000"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

type PageName = 'home' | 'developers' | 'protocol' | 'extension';

function Nav({ page }: { page: PageName }) {
  return (
    <header className="nav">
      <div className="wrap">
        <a href="/" className="brand">
          <Mark />
          Weave
        </a>
        <nav className="nav-links">
          <a href="/developers" aria-current={page === 'developers' ? 'page' : undefined}>
            Developers
          </a>
          <a href="/protocol" aria-current={page === 'protocol' ? 'page' : undefined}>
            Protocol
          </a>
          <a href="/extension" aria-current={page === 'extension' ? 'page' : undefined} className="hide-sm">
            Extension
          </a>
          <a href={GITHUB} {...EXTERNAL} className="hide-sm">
            GitHub
          </a>
          <a href="/app" className="btn btn-primary" style={{ color: '#fff', marginLeft: 8 }}>
            Open app
          </a>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <span>Weave — the internet, owned by its people.</span>
        <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <a href="/">Communities</a>
          <a href="/developers">Developers</a>
          <a href="/protocol">Protocol</a>
          <a href="/extension">Chrome extension</a>
          <a href={SPEC} {...EXTERNAL}>
            Spec
          </a>
          <a href={GITHUB} {...EXTERNAL}>
            GitHub
          </a>
          <a href="/app">Open app</a>
        </span>
      </div>
    </footer>
  );
}

export function Page({ page, children }: { page: PageName; children: ReactNode }) {
  return (
    <div className="site">
      <Nav page={page} />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

/** A small line icon, drawn the same way as the mark */
function Icon({ d }: { d: string }) {
  return (
    <span className="icon">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="#000"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={d} />
      </svg>
    </span>
  );
}

/** A band of a page: a kicker, a heading and a line or two on what it is about, then the band itself */
export function Band({
  id,
  kicker,
  title,
  intro,
  children,
}: {
  id?: string;
  kicker: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="band" id={id}>
      <div className="wrap">
        <div className="section-head">
          <div className="kicker">{kicker}</div>
          <h2>{title}</h2>
          {intro}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Short points side by side, each a heading and a sentence or two */
export function Points({ points }: { points: ReadonlyArray<{ title: string; body: ReactNode }> }) {
  return (
    <div className="points">
      {points.map((point) => (
        <div key={point.title}>
          <h3>{point.title}</h3>
          <p>{point.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Feature({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="cell">
      <Icon d={icon} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/**
 * The highlighter calls `define` in `node.collections.define(…)` a property,
 * like `records`. A name right before `(` is a call; mark it as one, so calls
 * stand out the way they do in an editor.
 */
function markCalls<P extends ReturnType<typeof parse>>(parsed: P): P {
  for (const line of parsed.lines) {
    const tokens = line.tokens;
    tokens.forEach((token, i) => {
      const next = tokens[i + 1];
      if (
        (token.type === 'identifier' || token.type === 'property') &&
        next?.type === 'sign' &&
        next.value.startsWith('(')
      )
        token.type = 'entity';
    });
  }
  return parsed;
}

function Code({
  file,
  lang = 'typescript',
  children,
}: {
  file: string;
  lang?: keyof typeof LANGUAGES;
  children: string;
}) {
  // Our own code snippets, not user input — safe to render as HTML.
  const html = render(markCalls(parse(children.trim(), LANGUAGES[lang])));
  return (
    <div className="code">
      <div className="bar">
        <span>{file}</span>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

// ─── For developers ─────────────────────────────────────────────────

const NODE = `
import {
  createNode, createIdentityManager,
  createLocalRootSigner, indexedDBStores, rolePresets,
} from '@weaveprotocol/core';

// Someone's account, from the password they keep
const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(password);

const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()),
  stores: indexedDBStores('my-app'), // or a pod: folderStores(dir)
  network: { relays: ['wss://p2p-web-relay.fly.dev'] },
});

const space = await node.spaces.create({
  name: 'Trip', visibility: 'private',
  ...rolePresets.team, // an owner, and editors for whoever's invited
});

// A friend calls node.spaces.join(invite)
const invite = await node.spaces.invite(space.id);
`;

const STEP_POLL = `
import * as z from 'zod'; // or Valibot, ArkType: any Standard Schema
import { collection } from '@weaveprotocol/core';

const Poll = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1)).min(2).max(10),
});

const polls = collection({
  name: 'app.poll',
  schema: Poll, // stored in the space as plain JSON Schema
  permissions: ['moderate'],
  rules: {
    edit: 'creator',                     // only the asker edits it
    delete: ['creator', 'can:moderate'], // or a moderator removes it
    fixed: ['options'],                  // votes point at these
  },
});
await node.collections.define(space.id, polls);
`;

const STEP_VOTE = `
const Vote = z.object({
  // Which option, by its place in the list. The hint lets any
  // app show "Lisbon" instead of 0, and count the votes.
  choice: z.int().min(0).meta({
    'x-choicesFrom': { rel: 'about', field: 'options' },
  }),
});

const votes = collection({
  name: 'app.poll.vote',
  schema: Vote,
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
  rules: {
    edit: 'creator',
    delete: 'creator',
    onePer: ['@author', 'link:about'], // one per person per poll
  },
});
await node.collections.define(space.id, votes);
`;

const CHECK_DECIDED = `
import { proposal, ballot, decision }
  from '@weaveprotocol/core/schemas';

const vote = await node.records.put(space.id, proposal, {
  title: 'Paint the clubhouse?',
  options: ['Yes', 'No'],
  quorum: 5, // five ballots for one option decide it
});

// Once five people have cast "Yes", anyone can record it.
// The decision cites the ballots; every device checks them.
await node.records.put(space.id, decision, {
  outcome: 0,
  proposal: vote.version,
  ballots: yes.map((ballot) => ballot.version),
}, { links: [{ rel: 'about', to: vote.key }] });
// Four ballots, or someone's twice: refused, everywhere.
`;

const CHECK_OWN = `
// Or write your own. A score only goes up by one:
rules: {
  check: [{
    that: { '==': [
      { var: 'body.score' },
      { '+': [{ var: 'prev.body.score' }, 1] },
    ] },
    else: 'The score goes up by one',
  }],
}
`;

const STEP_USE = `
// Typed from the schema: leave out the options, and it won't compile
const poll = await node.records.put(space.id, polls, {
  question: 'Where should we go in May?',
  options: ['Lisbon', 'Oslo', 'Rome'],
});

const about = [{ rel: 'about', to: poll.key }];
const vote = await node.records.put(space.id, votes,
  { choice: 0 }, { links: about });

// Changed your mind? Voting again replaces your vote:
// its key comes from you + the poll, so it's the same record
await node.records.put(space.id, votes, { choice: 2 }, { links: about });

// Or take it back
await node.records.delete(space.id, vote.key);
`;

const STEP_COUNT = `
// Every poll with its votes, again whenever a peer syncs a change
const stop = node.records.watch(space.id, {
  collection: polls,
  sort: { '@createdAt': 'desc' },
  include: { votes: { rel: 'about', from: votes } },
}, ({ records }) => {
  // Typed all the way down: body is a Poll, each vote a Vote
  for (const { body, included } of records) {
    const tally = body.options.map((option, i) => ({
      option,
      count: included.votes.filter((v) => v.body.choice === i).length,
    }));
    render(body.question, tally);
  }
});
`;

const STEP_RULES = `
// Bob tries to reword Anna's question
await node.records.update(space.id, poll.key, { ...poll.body,
  question: 'Pizza or tacos?' });
// ✗ Only whoever created it can edit this app.poll record

// Anna tries to swap the options after people voted
await node.records.update(space.id, poll.key, { ...poll.body,
  options: ['Paris', 'Rome'] });
// ✗ "options" is fixed once a app.poll record is created

// A modified app skips the checks and sends a second vote.
// Every other device refuses it on arrival:
// ✗ app.poll.vote allows one per @author + link:about

// Moderators are a role in the space, not code in your app
await node.spaces.putRole(space.id, {
  name: 'host', title: 'Host', rank: 50,
  permissions: ['invite', 'app.poll/moderate'],
});

// Hide the button, rather than show the error
const mayEdit = await node.records.can(space.id, 'edit', poll.key);
`;

const SCHEMAS = `
import {
  poll, vote, reaction, useSchemas,
} from '@weaveprotocol/core/schemas';

// The poll above ships ready-made, as std.poll and std.vote
await useSchemas(node, space.id, [poll, vote, reaction]);

const lunch = await node.records.put(space.id, poll, {
  question: 'Pizza or tacos?', options: ['Pizza', 'Tacos'],
});

// Any app that knows std.poll can show it and count it,
// and a reaction from any app lands on it too
await node.records.put(space.id, reaction.name, { emoji: '🍕' }, {
  links: [{ rel: 'about', to: lunch.key }],
});
`;

const AGENTS = `
# Every node operation, from a terminal
weave spaces list
weave records query --space <id> \\
  --collection app.poll \\
  --where '{"question":{"$contains":"may"}}'

# An always-on node: keeps your spaces
# available, and relays for your devices
weave run

# Connect an agent (Claude Code, Claude Desktop, Cursor) with the
# code from "Connect an agent" in an app; it then serves MCP by itself
weave connect wv_…
`;

const PROTOCOLS = ['Weave', 'AT Protocol (Bluesky)', 'Nostr', 'Solid'] as const;

/** The case for rules without a referee, in four points */
const CONSENSUS: ReadonlyArray<Part> = [
  {
    title: 'Roles you design',
    body: 'Owner, moderator, guest, or whatever your app needs. Each role has a rank and a list of what it may do, and it lives in the space, not in your code.',
  },
  {
    title: 'Every device is the referee',
    body: 'When a change arrives, each device checks who made it and whether their role allowed it. Anything that breaks the rules is refused, everywhere.',
  },
  {
    title: 'The same answer, everywhere',
    body: 'Devices that were offline, or saw changes in a different order, replay the same history and reach the same verdict. No leader, no server, no vote to wait for.',
  },
  {
    title: 'Access you can take back',
    body: 'Remove someone or disconnect an app, and from then on their changes stop counting on every device. Backdating a change doesn’t get around it.',
  },
];

/** What checks with evidence make possible, without a server or a chain */
const CHECKS: ReadonlyArray<Part> = [
  {
    title: 'Unlock when enough agree',
    body: 'A proposal passes, a role is granted or a reward is released only with enough signed approvals behind it. Three of five admins, ten members, whatever the space decides.',
  },
  {
    title: 'Moves that must be legal',
    body: 'Each version is checked against the one before, so a game, a workflow or an order can only move the way its rules allow.',
  },
  {
    title: 'Points that add up',
    body: 'Credits, badges and balances that cite the records they came from. Every device checks the sums.',
  },
  {
    title: 'Fair dice, sealed bids',
    body: 'Commit to a hidden value, reveal it later, and every device checks it matches. Randomness and auctions with nobody to trust.',
  },
];

/** One row per question: the question, then an answer for each protocol, in order */
const COMPARISON: ReadonlyArray<readonly [string, string, string, string, string]> = [
  [
    'Built for',
    'Private and shared app data',
    'Public social media',
    'Public messages that can’t be censored',
    'Personal data stores',
  ],
  [
    'Where data lives',
    'On the user’s devices, or a folder they own',
    'A personal data server, usually hosted',
    'Relays the user publishes to',
    'A pod server',
  ],
  [
    'Servers you need',
    'None. Relays only introduce devices',
    'Data servers, relays and app views',
    'Relays, which store and serve everything',
    'A pod server per user or provider',
  ],
  [
    'Private data',
    'Encrypted end to end by default',
    'Public by design',
    'Public, with encrypted direct messages',
    'Access control on the server',
  ],
  ['Works offline', 'Yes, local-first', 'No', 'Reading from cache', 'No'],
  [
    'Several people editing the same data',
    'Yes, shared spaces',
    'No, each user writes their own',
    'No, each user writes their own',
    'Yes, through permissions',
  ],
  [
    'Account',
    'A password or passkey the user keeps',
    'A DID and a handle, with a server holding the keys',
    'A key pair, and losing it is final',
    'A login with an identity provider',
  ],
  [
    'Who enforces the rules',
    'Every device, and they all agree',
    'Each app’s servers and moderation services',
    'Each relay and client, separately',
    'The pod server',
  ],
  ['Public feeds at global scale', 'Not the goal', 'Yes, that’s its strength', 'Yes, across relays', 'No'],
];

/** One piece of a layer, told at a high level */
interface Part {
  readonly title: string;
  readonly body: ReactNode;
}

/**
 * A layer of the stack: a line on what it does, and its parts underneath. The
 * whole line opens it; the page keeps one open at a time.
 */
function Layer({
  name,
  what,
  parts,
  app,
  open,
  onToggle,
}: {
  name: string;
  what: string;
  parts: ReadonlyArray<Part>;
  app?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <div className={app ? 'layer app' : 'layer'}>
      <button type="button" className="layer-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="name">{name}</span>
        <span className="what">{what}</span>
        <span className="more">{open ? 'Show less' : 'Read more'}</span>
      </button>
      <div id={id} className="parts" hidden={!open}>
        {parts.map((part) => (
          <div key={part.title} className="part">
            <h4>{part.title}</h4>
            <p>{part.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Developers() {
  const [openLayer, setOpenLayer] = useState<string | null>(null);
  const toggle = (name: string) => ({
    open: openLayer === name,
    onToggle: () => setOpenLayer(openLayer === name ? null : name),
  });
  return (
    <Page page="developers">
      <section className="hero">
        <div className="wrap">
          <h1>
            Build apps on data
            <br />
            people own.
          </h1>
          <p>
            Identity, storage, sync and encryption in one library. No backend to run, no database to host —
            your users bring their data, and your app is a view on it.
          </p>
          <div className="actions">
            <span className="install">
              <span>$</span>
              <code>npm install @weaveprotocol/core</code>
            </span>
            <a href="/app" className="btn btn-secondary">
              See the example app
            </a>
          </div>
        </div>
      </section>

      <Band
        kicker="How it works"
        title="From a password to a shared space."
        intro={<p>The whole idea in six steps. Nothing along the way puts a server in charge.</p>}
      >
        <Walkthrough />
      </Band>

      <Band
        kicker="Rules without a referee"
        title="Everyone follows the rules. Nobody is in charge."
        intro={
          <p>
            Most apps trust a server to decide who may do what. Weave has no server to trust, so every device
            decides, and they all reach the same answer.
          </p>
        }
      >
        <Points points={CONSENSUS} />
      </Band>

      <Band
        kicker="Checks with evidence"
        title="Contracts, without a chain."
        intro={
          <p>
            Some rules need proof: enough votes, a legal move, a balance that covers it. A record can cite the
            records that prove it, and every device checks the proof before it counts. No server decides, and
            no blockchain has to agree on an order.
          </p>
        }
      >
        <Points points={CHECKS} />
        <div className="split">
          <div>
            <h3>The app proves it, every device checks</h3>
            <p>
              A check never goes looking for records. The app that writes does the work: it finds the ballots
              and cites them. Every other device only checks that what was cited proves it, so they all reach
              the same verdict, whenever they see it.
            </p>
            <p>
              Checks are JSON stored with the collection, so they travel with the data and every app and agent
              sees the same rule. They always finish and read no clock.
            </p>
            <ul>
              <li>
                Ready-made: <code>std.decision</code> for proposals, <code>std.goal-reached</code> for pledges
              </li>
              <li>
                Or your own <code>check</code>, over the record, the version before it, and what it cites
              </li>
            </ul>
          </div>
          <div className="stack">
            <Code file="decide.ts">{CHECK_DECIDED}</Code>
            <Code file="rules.ts">{CHECK_OWN}</Code>
          </div>
        </div>
      </Band>

      <Band
        kicker="The layers"
        title="What's underneath, top to bottom."
        intro={
          <p>
            Follow one vote down the stack. Your app writes it. It's checked against its schema and the
            space's rules, encrypted, signed, saved on the device, and synced to everyone else. You only touch
            the top layer, and you can swap the pieces underneath.
          </p>
        }
      >
        <div className="layers">
          <Layer
            app
            name="Your app"
            {...toggle('Your app')}
            what="You write the front end. There's no backend to build, host or pay for."
            parts={[
              {
                title: 'No backend to build',
                body: 'Storage, sync, sign-in and permissions come in one object. Put a record, query it, watch it change. That’s the whole server side.',
              },
              {
                title: 'Bring your own stack',
                body: 'Plain TypeScript, with React hooks if you want them. Describe your data with Zod, Valibot, ArkType or plain JSON Schema.',
              },
              {
                title: 'Sign-in you don’t write',
                body: 'One element or one hook. Accounts, passkeys and pairing a phone are built in. Your app gets a limited, expiring pass to someone’s account, never their keys.',
              },
              {
                title: 'Ready for agents',
                body: 'Every operation is also a CLI command and an MCP tool, so AI agents can work with the same data, with the same permissions as your app.',
              },
            ]}
          />
          <Layer
            name="Data"
            {...toggle('Data')}
            what="A database that ships with the data: schemas, queries, live updates and permissions."
            parts={[
              {
                title: 'Start with your users’ data',
                body: 'When someone lets your app into their spaces, their data is already there. No blank slate, no import step.',
              },
              {
                title: 'The schema travels with the data',
                body: 'The shape of your data is stored next to it, so another app, or an agent, can make sense of it without your docs.',
              },
              {
                title: 'Apps that work together',
                body: 'Use the standard schemas, and a poll asked in one app can be voted on in another. No integration to build, no partnership to sign.',
              },
              {
                title: 'Queries you already know',
                body: 'Filters, sorting, paging and related records, in plain JSON. Results update live as changes arrive.',
              },
              {
                title: 'Rules instead of an API',
                body: 'Say who may create, edit and delete, what must be unique, which fields are fixed, and what a record must prove. Every device enforces it, so there’s no permission server to write.',
              },
              {
                title: 'Collaboration included',
                body: 'Shared spaces with invite links. Several people edit, and every device lands on the same result, without you writing merge logic.',
              },
            ]}
          />
          <Layer
            name="Privacy"
            {...toggle('Privacy')}
            what="Encrypted before it's saved or sent. You can't leak what you never had."
            parts={[
              {
                title: 'Encrypted first',
                body: 'Private data is encrypted on the device before it’s stored or sent. Relays, and always-on nodes that hold no keys, pass it along without being able to read it.',
              },
              {
                title: 'Less to be responsible for',
                body: 'Your users’ private data never sits readable on your servers, so there’s far less for you to secure.',
              },
              {
                title: 'Sharing that stays private',
                body: 'An invite link carries its own key, so sharing a private space never goes through a server.',
              },
              {
                title: 'Private or public, per space',
                body: 'Spaces are private by default. Make one public when anyone with the link should be able to read it.',
              },
            ]}
          />
          <Layer
            name="Identity & auth"
            {...toggle('Identity & auth')}
            what="Every change is signed by whoever made it. No user table for you to guard."
            parts={[
              {
                title: 'No user table',
                body: 'Accounts aren’t stored with you. There’s no password database to protect, and nothing to leak.',
              },
              {
                title: 'One account, every app',
                body: 'People make an account once, kept in their password manager or a passkey, and use it in every Weave app. No company can shut it off.',
              },
              {
                title: 'Everything is signed',
                body: 'Every change carries the signature of whoever made it, even when it’s encrypted. So any device can check who did what, even ones that can’t read it.',
              },
              {
                title: 'Any signer',
                body: 'A key in the browser, an account home, or anything else that can sign. Nothing above this layer needs to know which.',
              },
            ]}
          />
          <Layer
            name="Storage"
            {...toggle('Storage')}
            what="Kept on your users' devices, so your app is fast, works offline, and isn't on your bill."
            parts={[
              {
                title: 'Fast, because it’s local',
                body: 'Reads and writes happen on the device. No round trip to a server, no loading spinners.',
              },
              {
                title: 'Offline by default',
                body: 'Your app keeps working on a plane, and catches up when it’s back online.',
              },
              {
                title: 'One folder, every app',
                body: 'Keep data in the browser, or in a folder on the person’s own computer. Every app they use, on any website, sees the same folder.',
              },
              {
                title: 'No database bill',
                body: 'You don’t store your users’ data, so more users don’t mean a bigger database.',
              },
            ]}
          />
          <Layer
            name="Network & sync"
            {...toggle('Network & sync')}
            what="Devices sync directly. You don't run the servers in between."
            parts={[
              {
                title: 'Live, device to device',
                body: 'Changes go straight between devices and show up in real time.',
              },
              {
                title: 'Relays you choose',
                body: 'Relays help devices find each other, and can’t read what passes through them. Use a public one, run your own, or several at once.',
              },
              {
                title: 'Sends only what changed',
                body: 'However big a space gets, syncing costs about as much as the change itself.',
              },
              {
                title: 'Online when devices sleep',
                body: 'An always-on node keeps data available while your users’ devices are off. It can be one that holds no keys, passing data along without reading it.',
              },
              {
                title: 'Nothing bad gets in',
                body: 'Every change is checked on arrival: who signed it, its shape, and whether they were allowed. The rest is dropped.',
              },
            ]}
          />
        </div>
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>A node is the whole stack</h3>
              <p>
                Give it something that signs for the user and somewhere to store things. It handles session
                keys, delegation renewal, encryption, validation and sync.
              </p>
              <ul>
                <li>
                  <code>stores</code>: IndexedDB for one origin, or a pod folder shared by every app
                </li>
                <li>
                  <code>network</code>: relays to meet peers; an always-on node for availability
                </li>
                <li>
                  <code>signer</code>: a local key, or anything that can sign — an account home, a hardware
                  key
                </li>
              </ul>
            </div>
            <Code file="node.ts">{NODE}</Code>
          </div>
        </div>
      </section>

      <Band
        kicker="Guide"
        title="Build a poll, step by step."
        intro={
          <p>
            Questions, options, one vote each, live results, and rules nobody can get around. There's no
            server anywhere: every rule below is checked by every device.
          </p>
        }
      >
        <div className="split">
          <div>
            <div className="step-label">Step 1</div>
            <h3>Say what a poll is</h3>
            <p>
              Describe the shape with the validator you already use, and say who may do what. The definition
              is saved in the space itself, so another app, or an agent, opens it and knows what a poll is
              without your code.
            </p>
            <p>
              The options are fixed once a poll is asked, because votes point at them. Only the asker can
              edit, and moderators can remove it.
            </p>
          </div>
          <Code file="poll.ts">{STEP_POLL}</Code>
        </div>

        <div className="split">
          <div>
            <div className="step-label">Step 2</div>
            <h3>One vote per person</h3>
            <p>
              A vote points at its poll. <code>onePer</code> makes the vote's key out of who voted and which
              poll, so there can only ever be one. Nobody has to look through every vote to stop a second one.
            </p>
            <p>
              The <code>x-choicesFrom</code> hint says the number picks from the poll's options, so a generic
              app shows "Lisbon" and can count the votes without knowing what a poll is.
            </p>
          </div>
          <Code file="vote.ts">{STEP_VOTE}</Code>
        </div>

        <div className="split">
          <div>
            <div className="step-label">Step 3</div>
            <h3>Ask, and vote</h3>
            <p>
              Records are signed and saved on the device first, then synced to everyone in the space. Changing
              your vote is just voting again. Taking it back is a delete.
            </p>
          </div>
          <Code file="ask.ts">{STEP_USE}</Code>
        </div>

        <div className="split">
          <div>
            <div className="step-label">Step 4</div>
            <h3>Count the votes, live</h3>
            <p>
              Queries are plain JSON: Mongo-style filters, Prisma-style <code>include</code> to pull in the
              votes that point at each poll. Name collections by their definitions, and the results are typed
              from your schemas, votes included. Watch one, and it runs again whenever a vote arrives from
              anyone.
            </p>
          </div>
          <Code file="results.ts">{STEP_COUNT}</Code>
        </div>

        <div className="split">
          <div>
            <div className="step-label">Step 5</div>
            <h3>Try to cheat</h3>
            <p>
              Your app refuses a broken rule before anything is signed, with the reason. An app that skips the
              checks gets nowhere either: every device checks every record that arrives, and they all reach
              the same verdict.
            </p>
            <ul>
              <li>
                Rules name <code>member</code>, <code>creator</code>, or <code>can:</code> a permission you
                declare
              </li>
              <li>
                Roles live in the space. Start from <code>rolePresets</code>: <code>solo</code>,{' '}
                <code>team</code>, <code>community</code>
              </li>
            </ul>
          </div>
          <Code file="rules.ts">{STEP_RULES}</Code>
        </div>
      </Band>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>Or skip to the end</h3>
              <p>
                The protocol has no built-in kinds of record. For the things nearly every app needs, there's
                an optional library of ready-made definitions, including the poll you just built.
              </p>
              <p>
                They're ordinary collections, nothing special. Using the same ones is simply how two apps
                agree: a poll asked in one can be voted on in another. Prefer your own shape? Define your own.
              </p>
              <ul>
                <li>
                  On anything: <code>reaction</code>, <code>comment</code>, <code>tag</code>,{' '}
                  <code>attachment</code>, <code>reference</code>
                </li>
                <li>
                  Things of their own: <code>message</code>, <code>task</code>, <code>column</code>,{' '}
                  <code>poll</code>, <code>vote</code>
                </li>
                <li>
                  <code>useSchemas</code> defines only what a space is missing
                </li>
              </ul>
            </div>
            <Code file="standard.ts">{SCHEMAS}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Built for agents, too</h3>
              <p>
                Every operation is described once — a name, a sentence, a JSON Schema — and becomes a CLI
                command, an MCP tool and a WebMCP tool in the browser.
              </p>
              <p>An agent acts as the user, with the same permissions as the app it's in.</p>
            </div>
            <Code file="terminal" lang="shell">
              {AGENTS}
            </Code>
          </div>
        </div>
      </section>

      <Band
        kicker="Compared"
        title="Where Weave fits."
        intro={
          <p>
            Other open protocols give people their data back too. They make different bets. Weave is for apps
            where data is private, shared between a few people, and works offline.
          </p>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th />
                {PROTOCOLS.map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map(([row, ...cells]) => (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  {cells.map((cell, i) => (
                    <td key={PROTOCOLS[i]}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Band>

      <section className="cta">
        <div className="wrap">
          <h2>Start with the example.</h2>
          <p>
            A general app for any Weave data — every screen worked out from what a space says about itself.
          </p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Open the example app
            </a>
            <a href="/protocol" className="btn btn-secondary">
              How it works
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
