import { useId, useState, type ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import './site.css';

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/**
 * The two landing pages — for developers, at `/`, and why Weave, for people,
 * at `/why` — living in the example app for now, so they share its fonts,
 * colours and deploy. The app itself is at `/app`.
 */

export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <path d="M2 5 L7 15 L10 8 L13 15 L18 5" fill="none" stroke="#000" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Nav({ page }: { page: 'users' | 'developers' }) {
  return (
    <header className="nav">
      <div className="wrap">
        <a href="/" className="brand">
          <Mark />
          Weave
        </a>
        <nav className="nav-links">
          <a href="/" aria-current={page === 'developers' ? 'page' : undefined} className="hide-sm">
            Developers
          </a>
          <a href="/why" aria-current={page === 'users' ? 'page' : undefined}>
            Why Weave
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
        <span>Weave — your data, every app.</span>
        <span style={{ display: 'flex', gap: 16 }}>
          <a href="/">Developers</a>
          <a href="/why">Why Weave</a>
          <a href="/app">Open app</a>
        </span>
      </div>
    </footer>
  );
}

function Page({ page, children }: { page: 'users' | 'developers'; children: ReactNode }) {
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    </span>
  );
}

function Feature({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="cell">
      <Icon d={icon} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Code({ file, lang = 'typescript', children }: { file: string; lang?: keyof typeof LANGUAGES; children: string }) {
  // Our own code snippets, not user input — safe to render as HTML.
  const html = render(parse(children.trim(), LANGUAGES[lang]));
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

// ─── For people ─────────────────────────────────────────────────────

export function Landing() {
  return (
    <Page page="users">
      <section className="hero">
        <div className="wrap">
          <h1>
            Your data.
            <br />
            Every app.
          </h1>
          <p>
            Weave keeps your data with you — on your devices, in a folder you own — and lets any app you choose work
            with it. No company in the middle, no account to lose, nothing to export.
          </p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Get started
            </a>
            <a href="/" className="btn btn-secondary">
              For developers
            </a>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Why Weave</div>
            <h2>Apps come and go. Your data should stay yours.</h2>
            <p>Most apps keep your things on their servers, behind their login, in their format. Weave turns that around.</p>
          </div>
          <div className="grid">
            <Feature icon="M8 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM2.5 14.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5" title="You own your account">
              No email sign-up, no company holding the keys. Your account is a password you keep — nobody can lock you out,
              and nobody can reset it for someone else.
            </Feature>
            <Feature icon="M2 4.5h4l1.5 1.5H14v7.5H2zM2 4.5V3h4" title="Your data lives with you">
              Keep it in a pod — a folder on your computer you can back up, copy or sync — or just in your browser. Either
              way it's on your devices, not someone's server.
            </Feature>
            <Feature icon="M1.5 4h5v8h-5zM9.5 4h5v8h-5zM6.5 8h3" title="Apps are just views">
              Open the same data in a different app, and it's all there. Switching apps doesn't mean exporting, importing
              or starting over.
            </Feature>
            <Feature icon="M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3z" title="Private by default">
              Private spaces are encrypted on your device before anything leaves it. The relays that help devices find
              each other see only scrambled data.
            </Feature>
            <Feature icon="M6 10l4-4M5 7.5L3.5 9a2.5 2.5 0 0 0 3.5 3.5L8.5 11M11 8.5L12.5 7A2.5 2.5 0 0 0 9 3.5L7.5 5" title="Share without a platform">
              Invite someone with a link. The key to a private space travels inside the link itself — it never passes
              through a server.
            </Feature>
            <Feature icon="M8 2v2M8 12v2M2 8h2M12 8h2M4 4l1.4 1.4M10.6 10.6L12 12M4 12l1.4-1.4M10.6 5.4L12 4" title="Your agent works for you">
              AI assistants can use your data through the apps you open, acting as you — and asking before they hand
              access to anyone else.
            </Feature>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">The difference</div>
            <h2>Who's in charge?</h2>
          </div>
          <div className="compare">
            <div className="col">
              <h3>Usually</h3>
              <ul>
                <li>An account with each company</li>
                <li>Your data on their servers</li>
                <li>Stuck when the app shuts down</li>
                <li>They decide who sees what</li>
                <li>Offline means nothing works</li>
              </ul>
            </div>
            <div className="col us">
              <h3>With Weave</h3>
              <ul>
                <li>One account that works in every Weave app</li>
                <li>Your data on your devices</li>
                <li>Open it in another app instead</li>
                <li>You invite who you want</li>
                <li>Works offline, syncs when your devices meet</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Getting started</div>
            <h2>Three steps, no sign-up form.</h2>
          </div>
          <div className="steps">
            <div className="step">
              <h3>Choose where your data lives</h3>
              <p>A pod on your computer, or just this browser. You can move to a pod later.</p>
            </div>
            <div className="step">
              <h3>Save your password</h3>
              <p>Weave makes a strong one. Keep it in your password manager — it opens your account in any Weave app.</p>
            </div>
            <div className="step">
              <h3>Make a space</h3>
              <p>Keep it to yourself, or share it with a link. Everything in it syncs straight between your devices.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <h2>Take your data back.</h2>
          <p>It takes a minute, and nothing leaves your hands.</p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Open Weave
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}

// ─── For developers ─────────────────────────────────────────────────

const NODE = `
import {
  createNode, createIdentityManager,
  createLocalRootSigner, indexedDBStores, rolePresets,
} from 'weave-protocol';

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

const Poll = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1)).min(2).max(10),
});

await node.collections.define(space.id, {
  name: 'app.poll',
  schema: Poll, // stored in the space as plain JSON Schema
  permissions: ['moderate'],
  rules: {
    edit: 'creator',                     // only the asker edits it
    delete: ['creator', 'can:moderate'], // or a moderator removes it
    fixed: ['options'],                  // votes point at these
  },
});
`;

const STEP_VOTE = `
const Vote = z.object({
  // Which option, by its place in the list. The hint lets any
  // app show "Lisbon" instead of 0, and count the votes.
  choice: z.int().min(0).meta({
    'x-choicesFrom': { rel: 'about', field: 'options' },
  }),
});

await node.collections.define(space.id, {
  name: 'app.poll.vote',
  schema: Vote,
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
  rules: {
    edit: 'creator',
    delete: 'creator',
    onePer: ['@author', 'link:about'], // one per person per poll
  },
});
`;

const STEP_USE = `
const poll = await node.records.put(space.id, 'app.poll', {
  question: 'Where should we go in May?',
  options: ['Lisbon', 'Oslo', 'Rome'],
});

const about = [{ rel: 'about', to: poll.key }];
const vote = await node.records.put(space.id, 'app.poll.vote',
  { choice: 0 }, { links: about });

// Changed your mind? Voting again replaces your vote:
// its key comes from you + the poll, so it's the same record
await node.records.put(space.id, 'app.poll.vote',
  { choice: 2 }, { links: about });

// Or take it back
await node.records.delete(space.id, vote.key);
`;

const STEP_COUNT = `
import type { QueryRecord } from 'weave-protocol';
type Poll = z.infer<typeof Poll>;
type Vote = z.infer<typeof Vote>;

// Every poll with its votes, again whenever a peer syncs a change
const stop = node.records.watch<Poll>(space.id, {
  collection: 'app.poll',
  sort: { '@createdAt': 'desc' },
  include: { votes: { rel: 'about', from: 'app.poll.vote' } },
}, ({ records }) => {
  for (const { body, included } of records) {
    if (!body) continue; // encrypted, and this device has no key
    const votes = included?.votes as QueryRecord<Vote>[];
    const tally = body.options.map((option, i) => ({
      option,
      count: votes.filter((v) => v.body?.choice === i).length,
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
} from 'weave-protocol/schemas';

// The poll above ships ready-made, as std.poll and std.vote
await useSchemas(node, space.id, [poll, vote, reaction]);

const lunch = await node.records.put(space.id, poll.name, {
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

# The same operations as MCP tools for a desktop agent
weave mcp
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

/** One row per question: the question, then an answer for each protocol, in order */
const COMPARISON: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['Built for', 'Private and shared app data', 'Public social media', 'Public messages that can’t be censored', 'Personal data stores'],
  ['Where data lives', 'On the user’s devices, or a folder they own', 'A personal data server, usually hosted', 'Relays the user publishes to', 'A pod server'],
  ['Servers you need', 'None. Relays only introduce devices', 'Data servers, relays and app views', 'Relays, which store and serve everything', 'A pod server per user or provider'],
  ['Private data', 'Encrypted end to end by default', 'Public by design', 'Public, with encrypted direct messages', 'Access control on the server'],
  ['Works offline', 'Yes, local-first', 'No', 'Reading from cache', 'No'],
  ['Several people editing the same data', 'Yes, shared spaces', 'No, each user writes their own', 'No, each user writes their own', 'Yes, through permissions'],
  ['Account', 'A recovery code the user keeps', 'A DID and a handle, with a server holding the keys', 'A key pair, and losing it is final', 'A login with an identity provider'],
  ['Who enforces the rules', 'Every device, and they all agree', 'Each app’s servers and moderation services', 'Each relay and client, separately', 'The pod server'],
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
            Identity, storage, sync and encryption in one library. No backend to run, no database to host — your users
            bring their data, and your app is a view on it.
          </p>
          <div className="actions">
            <span className="install">
              <span>$</span>
              <code>npm install weave-protocol</code>
            </span>
            <a href="/app" className="btn btn-secondary">
              See the example app
            </a>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Rules without a referee</div>
            <h2>Everyone follows the rules. Nobody is in charge.</h2>
            <p>
              Most apps trust a server to decide who may do what. Weave has no server to trust, so every device decides,
              and they all reach the same answer.
            </p>
          </div>
          <div className="points">
            {CONSENSUS.map((point) => (
              <div key={point.title}>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">The layers</div>
            <h2>What's underneath, top to bottom.</h2>
            <p>You only touch the top one. Everything below comes with it.</p>
          </div>
          <div className="layers">
            <Layer
              app
              name="Your app"
              {...toggle('Your app')}
              what='You write the front end. There’s no backend to build, host or pay for.'
              parts={[
                { title: 'No backend to build', body: 'Storage, sync, sign-in and permissions come in one object. Put a record, query it, watch it change. That’s the whole server side.' },
                { title: 'Sign-in you don’t write', body: 'Drop in one element, or use the React hooks. Creating accounts, passkeys and pairing a phone are built in.' },
                { title: 'Never hold anyone’s keys', body: 'Your app can ask for access to a person’s account instead of signing them in. It gets only what they approve, for as long as they approve it, and there’s no master key in your app to leak.' },
                { title: 'Ready for agents', body: 'Every operation is also a CLI command and an MCP tool, so AI agents can work with the same data, with the same permissions as your app.' },
              ]}
            />
            <Layer
              name="Data"
              {...toggle('Data')}
              what='Structured data your users own, that other apps can read too.'
              parts={[
                { title: 'Start with your users’ data', body: 'When someone lets your app into their spaces, their data is already there. No blank slate, no import step.' },
                { title: 'The schema travels with the data', body: 'The shape of your data is stored next to it, so another app, or an agent, can make sense of it without your docs.' },
                { title: 'Collaboration included', body: 'Shared spaces with invite links. Several people edit, and every device lands on the same result, without you writing merge logic.' },
                { title: 'Roles you design', body: 'Owner, moderator, guest, or whatever your app needs. Say what each role may do, and every device enforces it. There’s nothing to host.' },
                { title: 'Queries you already know', body: 'Filters, sorting, paging and related records, in plain JSON. Results update live as changes arrive.' },
              ]}
            />
            <Layer
              name="Identity & auth"
              {...toggle('Identity & auth')}
              what='Accounts your users own. No password database for you to guard.'
              parts={[
                { title: 'No user table', body: 'Accounts aren’t stored with you. There’s no password database to protect, and nothing to leak.' },
                { title: 'One account, every app', body: 'An account comes from a recovery code the person keeps. It works in every Weave app, and no company can shut it off.' },
                { title: 'Everything is signed', body: 'Every change carries the signature of whoever made it, so you always know who did what, on any device, from any app.' },
                { title: 'Familiar on the surface', body: 'Password managers, passkeys and QR codes. Your users never see the cryptography.' },
              ]}
            />
            <Layer
              name="Storage"
              {...toggle('Storage')}
              what='Data lives on your users’ devices, so your app is fast and works offline.'
              parts={[
                { title: 'Fast, because it’s local', body: 'Reads and writes happen on the device. No round trip to a server, no loading spinners.' },
                { title: 'Offline by default', body: 'Your app keeps working on a plane, and catches up when it’s back online.' },
                { title: 'One folder, every app', body: 'People can keep their data in a folder on their own computer. Every app they use, on any website, sees the same data.' },
                { title: 'No database bill', body: 'You don’t store your users’ data, so more users don’t mean a bigger database.' },
              ]}
            />
            <Layer
              name="Privacy"
              {...toggle('Privacy')}
              what='End-to-end encrypted by default. You can’t leak what you never had.'
              parts={[
                { title: 'Encrypted on the device', body: 'Private data is encrypted before it leaves the device. Anything in between, relays or hosts, can’t read what’s inside.' },
                { title: 'Less to be responsible for', body: 'Your users’ private data never sits on your servers, so there’s far less for you to secure.' },
                { title: 'Sharing that stays private', body: 'An invite link carries its own key, so sharing a private space never goes through a server.' },
              ]}
            />
            <Layer
              name="Network & sync"
              {...toggle('Network & sync')}
              what='Devices sync directly. You don’t run the servers in between.'
              parts={[
                { title: 'Live, device to device', body: 'Changes go straight between devices and show up in real time.' },
                { title: 'No servers to scale', body: 'Relays only help devices find each other, and data never passes through them. Anyone can run one, and apps can use several.' },
                { title: 'Sends only what changed', body: 'However big a space gets, syncing costs about as much as the change itself.' },
                { title: 'Online when devices sleep', body: 'An always-on node keeps data available while your users’ devices are off, without taking ownership of it.' },
                { title: 'Nothing bad gets in', body: 'Every change is checked on arrival: who signed it, its shape, and whether they were allowed. The rest is dropped.' },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>A node is the whole stack</h3>
              <p>
                Give it something that signs for the user and somewhere to store things. It handles session keys,
                delegation renewal, encryption, validation and sync.
              </p>
              <ul>
                <li>
                  <code>stores</code>: IndexedDB for one origin, or a pod folder shared by every app
                </li>
                <li>
                  <code>network</code>: relays to meet peers; an always-on node for availability
                </li>
                <li>
                  <code>signer</code>: a local key, or anything that can sign — an account home, a hardware key
                </li>
              </ul>
            </div>
            <Code file="node.ts">{NODE}</Code>
          </div>

        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Guide</div>
            <h2>Build a poll, step by step.</h2>
            <p>
              Questions, options, one vote each, live results, and rules nobody can get around. There's no server
              anywhere: every rule below is checked by every device.
            </p>
          </div>

          <div className="split">
            <div>
              <div className="step-label">Step 1</div>
              <h3>Say what a poll is</h3>
              <p>
                Describe the shape with the validator you already use, and say who may do what. The definition is saved
                in the space itself, so another app, or an agent, opens it and knows what a poll is without your code.
              </p>
              <p>
                The options are fixed once a poll is asked, because votes point at them. Only the asker can edit, and
                moderators can remove it.
              </p>
            </div>
            <Code file="poll.ts">{STEP_POLL}</Code>
          </div>

          <div className="split">
            <div>
              <div className="step-label">Step 2</div>
              <h3>One vote per person</h3>
              <p>
                A vote points at its poll. <code>onePer</code> makes the vote's key out of who voted and which poll,
                so there can only ever be one. Nobody has to look through every vote to stop a second one.
              </p>
              <p>
                The <code>x-choicesFrom</code> hint says the number picks from the poll's options, so a generic app
                shows "Lisbon" and can count the votes without knowing what a poll is.
              </p>
            </div>
            <Code file="vote.ts">{STEP_VOTE}</Code>
          </div>

          <div className="split">
            <div>
              <div className="step-label">Step 3</div>
              <h3>Ask, and vote</h3>
              <p>
                Records are signed and saved on the device first, then synced to everyone in the space. Changing your
                vote is just voting again. Taking it back is a delete.
              </p>
            </div>
            <Code file="ask.ts">{STEP_USE}</Code>
          </div>

          <div className="split">
            <div>
              <div className="step-label">Step 4</div>
              <h3>Count the votes, live</h3>
              <p>
                Queries are plain JSON: Mongo-style filters, Prisma-style <code>include</code> to pull in the votes
                that point at each poll. Watch one, and it runs again whenever a vote arrives from anyone.
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
                checks gets nowhere either: every device checks every record that arrives, and they all reach the same
                verdict.
              </p>
              <ul>
                <li>
                  Rules name <code>member</code>, <code>creator</code>, or <code>can:</code> a permission you declare
                </li>
                <li>
                  Roles live in the space. Start from <code>rolePresets</code>: <code>solo</code>, <code>team</code>,{' '}
                  <code>community</code>
                </li>
              </ul>
            </div>
            <Code file="rules.ts">{STEP_RULES}</Code>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <h3>Or skip to the end</h3>
              <p>
                The protocol has no built-in kinds of record. For the things nearly every app needs, there's an optional
                library of ready-made definitions, including the poll you just built.
              </p>
              <p>
                They're ordinary collections, nothing special. Using the same ones is simply how two apps agree: a poll
                asked in one can be voted on in another. Prefer your own shape? Define your own.
              </p>
              <ul>
                <li>
                  On anything: <code>reaction</code>, <code>comment</code>, <code>tag</code>, <code>attachment</code>,{' '}
                  <code>reference</code>
                </li>
                <li>
                  Things of their own: <code>message</code>, <code>task</code>, <code>column</code>, <code>poll</code>,{' '}
                  <code>vote</code>
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
                Every operation is described once — a name, a sentence, a JSON Schema — and becomes a CLI command, an MCP
                tool and a WebMCP tool in the browser.
              </p>
              <p>An agent acts as the user, with the same permissions as the app it's in.</p>
            </div>
            <Code file="terminal" lang="shell">{AGENTS}</Code>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Compared</div>
            <h2>Where Weave fits.</h2>
            <p>
              Other open protocols give people their data back too. They make different bets. Weave is for apps where data
              is private, shared between a few people, and works offline.
            </p>
          </div>
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
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <h2>Start with the example.</h2>
          <p>A general app for any Weave data — every screen worked out from what a space says about itself.</p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Open the example app
            </a>
            <a href="/why" className="btn btn-secondary">
              Why Weave
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
