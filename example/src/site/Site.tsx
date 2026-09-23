import type { ReactNode } from 'react';
import { parse, render } from 'sugar-high/core';
import * as typescript from 'sugar-high/lang/typescript';
import * as shell from 'sugar-high/lang/shell';
import './site.css';

/** Syntax highlighting: sugar-high's core and just the two languages used here */
const LANGUAGES = { typescript: { ...typescript, typescript: true }, shell } as const;

/**
 * The two landing pages — for people, at `/`, and for developers, at
 * `/developers` — living in the example app for now, so they share its fonts,
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
          <a href="/" aria-current={page === 'users' ? 'page' : undefined} className="hide-sm">
            Overview
          </a>
          <a href="/developers" aria-current={page === 'developers' ? 'page' : undefined}>
            Developers
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
          <a href="/">Overview</a>
          <a href="/developers">Developers</a>
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
          <span className="eyebrow">Local-first · peer-to-peer · yours</span>
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
            <a href="/developers" className="btn btn-secondary">
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
  createLocalRootSigner, indexedDBStores,
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
  name: 'Trip', type: 'shared', visibility: 'private',
});

// A friend calls node.spaces.join(invite)
const invite = await node.spaces.invite(space.id);
`;

const DATA = `
// Describe your data in the space itself,
// so any app (or agent) can read it
await node.collections.define(space.id, {
  name: 'app.poll.vote',
  schema: {
    type: 'object',
    properties: { choice: { type: 'integer' } },
  },
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
});

const poll = await node.records.put(space.id, 'app.poll', {
  question: 'Where?', options: ['Oslo', 'Lisbon'],
});
await node.records.put(space.id, 'app.poll.vote', { choice: 1 }, {
  links: [{ rel: 'about', to: poll.key }],
});

// Edits keep the key: each is a signed new version
await node.records.update(space.id, poll.key, {
  question: 'Where in May?', options: ['Oslo', 'Lisbon'],
});
`;

const QUERY = `
// Plain-data queries: filters, sorting, paging,
// and the records that link here
const { records } = await node.records.query(space.id, {
  collection: 'app.poll',
  where: { question: { $contains: 'may' } },
  sort: { '@createdAt': 'desc' },
  include: {
    votes: { rel: 'about', from: 'app.poll.vote' },
    likes: { rel: 'about', from: 'std.reaction', count: true },
  },
});

// Live: runs again whenever a peer syncs something in
const stop = node.records.watch(space.id, {
  collection: 'app.poll',
}, render);
`;

const RULES = `
await node.collections.define(space.id, {
  name: 'app.poll',
  schema: pollSchema,
  rules: { edit: 'creator', delete: ['creator', 'owner'] },
});
await node.collections.define(space.id, {
  name: 'app.poll.vote',
  schema: voteSchema,
  links: { about: { to: ['app.poll'], cardinality: 'one' } },
  rules: { edit: 'creator', onePer: ['@author', 'link:about'] },
});

// Voting twice is changing your vote
const vote = { links: [{ rel: 'about', to: poll.key }] };
await node.records.put(space.id, 'app.poll.vote', { choice: 0 }, vote);
await node.records.put(space.id, 'app.poll.vote', { choice: 1 }, vote);

await node.records.can(space.id, 'edit', poll.key); // false for others
`;

const SCHEMAS = `
import {
  reaction, comment, useSchemas, type Reaction,
} from 'weave-protocol/schemas';

// Define the shapes this space doesn't know yet
await useSchemas(node, space.id, [reaction, comment]);

// A reaction is a record that points at what it's about
const like: Reaction = { emoji: '👍' };
await node.records.put(space.id, reaction.name, like, {
  links: [{ rel: 'about', to: poll.key }],
});

// Any app that uses std.reaction sees it — and can count it
const { records } = await node.records.query(space.id, {
  collection: 'app.poll',
  include: {
    likes: { rel: 'about', from: reaction.name, count: true },
  },
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

function Layer({ name, what, tags, app }: { name: string; what: string; tags: string[]; app?: boolean }) {
  return (
    <div className={app ? 'layer app' : 'layer'}>
      <span className="name">{name}</span>
      <span className="what">{what}</span>
      <span className="tags">
        {tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </span>
    </div>
  );
}

export function Developers() {
  return (
    <Page page="developers">
      <section className="hero">
        <div className="wrap">
          <span className="eyebrow">weave-protocol · TypeScript · browser, Node, Bun</span>
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
            <div className="kicker">The layers</div>
            <h2>What's underneath, top to bottom.</h2>
            <p>Most apps only touch the top one: a node wires the rest together behind a plain-data API.</p>
          </div>
          <div className="layers">
            <Layer app name="Your app" what="Reads and writes records through a node. Can be a view on data another app made." tags={['createNode', 'NODE_ACTIONS']} />
            <Layer name="Data" what="Spaces hold records. Collections describe themselves with JSON Schema and rules every peer enforces; records link to each other; queries are plain JSON." tags={['spaces', 'collections', 'links', 'query']} />
            <Layer name="Identity & auth" what="An account is a seed → a P-256 did:key. The root key delegates to short-lived session keys with UCAN; passkeys unlock per device." tags={['did:key', 'UCAN', 'passkeys']} />
            <Layer name="Storage" what="Every space is a Merkle Search Tree of signed, versioned records — in IndexedDB, or a pod folder any origin can open." tags={['MST', 'IndexedDB', 'pods']} />
            <Layer name="Privacy" what="Private spaces encrypt each record with the space key before signing. Links are sealed with the body." tags={['AES-GCM']} />
            <Layer name="Network & sync" what="Peers meet through relays, then talk directly. Sync compares trees and ships only what differs." tags={['WebRTC', 'WebSocket', 'anti-entropy']} />
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
                  <code>signer</code>: a local key, or anything that can sign — a wallet, a hardware key
                </li>
              </ul>
            </div>
            <Code file="node.ts">{NODE}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Data that describes itself</h3>
              <p>
                Define a collection once and it lives in the space: its schema, and how its records connect. Another app
                — or an agent — opens the space and knows what's there without your code.
              </p>
              <p>
                Records keep their key across edits. Which version wins is decided by order, never by a clock, so every
                device agrees.
              </p>
            </div>
            <Code file="data.ts">{DATA}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Queries without a query language</h3>
              <p>
                Mongo-style filters, Prisma-style <code>include</code>, and a total sort so paging never skips on any
                peer. Queries are JSON, so the same one works over MCP.
              </p>
            </div>
            <Code file="query.ts">{QUERY}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Rules every peer enforces</h3>
              <p>
                Say who may create, edit and delete a collection's records, what must be unique, and which fields are
                fixed. There's no server to enforce it — every device does, when records arrive.
              </p>
              <p>
                "One per" is by construction: the key is derived from what must be unique, so voting again changes your
                vote. Nobody ever needs to see every vote to stop a second one.
              </p>
              <ul>
                <li>
                  <code>member</code>, <code>owner</code>, <code>creator</code>
                </li>
                <li>
                  <code>node.records.can()</code> to hide what you can't do
                </li>
              </ul>
            </div>
            <Code file="rules.ts">{RULES}</Code>
          </div>

          <div className="split">
            <div>
              <h3>Standard schemas, if you want them</h3>
              <p>
                The protocol has no built-in kinds of record. For the patterns nearly every app needs — reactions,
                comments, tags, attachments, references — there's an optional library of ready-made definitions.
              </p>
              <p>
                They're ordinary collections, nothing privileged. Using the same ones is simply how two apps agree:
                reactions from one show up in the other. Prefer your own shape? Define your own.
              </p>
              <ul>
                <li>
                  <code>reaction</code>, <code>comment</code>, <code>tag</code>, <code>attachment</code>,{' '}
                  <code>reference</code>
                </li>
                <li>
                  <code>useSchemas</code> defines only what a space is missing
                </li>
              </ul>
            </div>
            <Code file="reactions.ts">{SCHEMAS}</Code>
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

      <section className="cta">
        <div className="wrap">
          <h2>Start with the example.</h2>
          <p>A general app for any Weave data — every screen worked out from what a space says about itself.</p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Open the example app
            </a>
            <a href="/" className="btn btn-secondary">
              Why Weave
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
