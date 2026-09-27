import type { ReactNode } from 'react';
import { EXTERNAL, GITHUB, Page, SPEC } from './Site';

/**
 * How it works, for people who want the design before the code: one section
 * per part of the spec, then what Weave gives up. Every claim here comes from
 * `spec/`; when the two disagree, the spec wins and this page is the bug.
 */

const specPart = (file: string) => `${GITHUB}/blob/main/spec/${file}`;

/** The picture from the top of `spec/README.md` */
const SHAPE = `
 account (seed) ──derives──▶ root key ──signs UCAN──▶ session key ──signs──▶ records
                                                                           │
                                                          stored per space │ synced by Negentropy
                                                                           ▼
 space = { id, visibility, roles & access log, collections, records } ◀── peers in the space
                                                                           ▲
             relays (WebSocket) introduce peers ─▶ WebRTC data channels ───┘
`;

interface Point {
  readonly title: string;
  readonly body: ReactNode;
}

interface Part {
  readonly kicker: string;
  readonly title: string;
  readonly lead: string;
  readonly points: ReadonlyArray<Point>;
  readonly file: string;
}

const PARTS: ReadonlyArray<Part> = [
  {
    kicker: '01 — Identity',
    title: 'Your account is sixteen bytes you keep.',
    lead: 'Nobody hands out accounts. You make one by picking a random number, and you keep it in your password manager.',
    file: '01-identity.md',
    points: [
      {
        title: 'One seed, every key',
        body: 'Every key your account uses is derived from its seed. Type the same code into any device, on any site, and you’re the same person.',
      },
      {
        title: 'Your name is your key',
        body: (
          <>
            Your account’s name is a <code>did:key</code>: its public key, written out. Anyone can check that you signed
            something without asking a server who you are.
          </>
        ),
      },
      {
        title: 'The master key stays home',
        body: 'Your root key never signs your data. It signs hour-long permission slips (UCANs) for a session key, and the session key signs everything else.',
      },
      {
        title: 'Apps get a pass, not your keys',
        body: 'An app or an agent signs with a key of its own, under a note from your account. It can’t pretend to be you, and its access ends when the note does.',
      },
      {
        title: 'Passkeys open the door',
        body: 'A passkey unlocks your account on a device. It isn’t your account: passkeys belong to one site, and your account belongs to every app you use.',
      },
    ],
  },
  {
    kicker: '02 — Records',
    title: 'Everything is signed, and nothing is overwritten.',
    lead: 'Data is JSON, signed by whoever wrote it. An edit is a new version, and every device agrees which version is current.',
    file: '02-records.md',
    points: [
      {
        title: 'The same bytes everywhere',
        body: 'JSON has one canonical form, and every hash and signature is over it. Two implementations in two languages sign the same bytes.',
      },
      {
        title: 'Clocks don’t decide',
        body: (
          <>
            The version with the higher <code>seq</code> wins; a tie goes to the lower id. Replaying an old version
            can’t roll a record back, a delete stays deleted, and two people who edited offline land on the same result.
          </>
        ),
      },
      {
        title: 'Data that explains itself',
        body: 'A collection’s schema, links and rules are stored in the space as records too. An app that has never seen your space can open it and understand it.',
      },
      {
        title: 'Four checks, every time',
        body: 'Shape, signature, permission slip, then the space’s rules. Your own writes, a peer’s and a folder’s all go through the same checks.',
      },
      {
        title: 'Kept, not refused',
        body: 'A record that doesn’t match its schema is kept and flagged. Two devices might know different versions of a schema, and refusing would leave them disagreeing forever.',
      },
    ],
  },
  {
    kicker: '03 — Spaces',
    title: 'Every device is the referee.',
    lead: 'A space holds its own rules: the roles, who has them, and what each kind of record allows. There’s no server to ask.',
    file: '03-spaces.md',
    points: [
      {
        title: 'Membership is data',
        body: 'Roles, members, invites and removals are records in the space. Every record says which of those changes its writer had seen.',
      },
      {
        title: 'Same history, same answer',
        body: 'Every device replays that history the same way. Devices that were offline, or heard things in a different order, reach the same verdict.',
      },
      {
        title: 'Rank decides who manages whom',
        body: 'Managing roles takes the manage permission, and you can only change roles ranked below your own.',
      },
      {
        title: 'Encrypted before it leaves',
        body: 'In a private space every record body is encrypted with the space key (AES-256-GCM). Who wrote it stays visible, so devices that can’t read a record can still check it was allowed.',
      },
      {
        title: 'The invite is the key',
        body: 'An invite link carries the space and, for a private one, its key. Sharing a space never goes through a server.',
      },
      {
        title: 'Remove someone, change the lock',
        body: 'When someone is removed, a manager makes a new key and seals it to everyone who’s left. Nothing written after that is readable to them.',
      },
    ],
  },
  {
    kicker: '04 — Network',
    title: 'Relays introduce. They don’t decide.',
    lead: 'Devices talk to each other directly, over WebRTC in the browser or a WebSocket to an always-on node. Relays only help them meet.',
    file: '04-network.md',
    points: [
      {
        title: 'A phone book, not a boss',
        body: 'A relay holds no data and has no say. The worst a lying relay can do is fail to introduce you, or introduce the wrong peer, and the handshake catches that.',
      },
      {
        title: 'Rooms without names',
        body: 'Devices in a space meet in a room named after a hash of its id. The relay sees who’s in the same room, not which space it is.',
      },
      {
        title: 'Prove it first',
        body: 'Before any data moves, each side signs with the key its name says it has. In a private space, each also proves it can read the space.',
      },
      {
        title: 'Friends of friends',
        body: 'Once you’re connected to one device, it can introduce you to the next, so you only need a relay for the first. Use several relays at once, or the ones a space names.',
      },
    ],
  },
  {
    kicker: '05 — Sync and storage',
    title: 'Syncing costs about as much as what changed.',
    lead: 'Devices compare what they hold, per collection, and send only the difference. No central log, no merge server.',
    file: '05-sync-and-storage.md',
    points: [
      {
        title: 'Find the difference, fast',
        body: 'Devices swap a fingerprint per collection, and Negentropy narrows down exactly what each side is missing. Two copies of 2,000 records that differ by one exchange under 8 KB.',
      },
      {
        title: 'A wrong clock can’t hurt you',
        body: 'Time only helps sort things for comparing. It never decides what wins, so a device with a wrong clock only slows down its own changes.',
      },
      {
        title: 'Keepers hold the whole thing',
        body: 'A space can name keepers that hold every record, like a host or the browser extension. Apps can then keep just what they use, and hold on to their writes until enough keepers have them.',
      },
      {
        title: 'Your own folder',
        body: 'Data lives in the browser for one site, or in a folder on your computer that every app you use shares. Its keys are sealed under your account.',
      },
    ],
  },
  {
    kicker: '06 — Nodes, sessions and apps',
    title: 'One engine, everywhere.',
    lead: 'A node is the whole stack in one object. A browser tab, the command line, an always-on server and an agent all run the same one.',
    file: '06-nodes-and-sessions.md',
    points: [
      {
        title: 'Plain data in and out',
        body: 'Everything a node does takes and returns plain JSON, so each operation is also a CLI command, an MCP tool and a WebMCP tool.',
      },
      {
        title: 'Your account lives at home',
        body: 'Apps never get your seed. They ask your account home, a page you chose, which gives them the spaces you pick, to read or to change, for a week at a time.',
      },
      {
        title: 'Disconnect means disconnect',
        body: 'Disconnecting an app writes a revocation into every space it could change. From then on, nothing it writes counts anywhere.',
      },
      {
        title: 'Always on, never reading',
        body: 'A host keeps your spaces online while your devices sleep. It holds them encrypted, with no key that opens them and no right to sign anything.',
      },
    ],
  },
  {
    kicker: '07 — Doors',
    title: 'Reachable, but only on purpose.',
    lead: 'Your name is on everything you sign, so knowing it shouldn’t be enough to reach you. A door is an address you hand out, and can close.',
    file: '07-doors.md',
    points: [
      {
        title: 'The code doesn’t say who you are',
        body: 'A door code holds two keys made for that door and up to three relays. Your account isn’t in it, and no relay learns it.',
      },
      {
        title: 'Knocks are sealed and signed',
        body: 'Someone with the code leaves a knock in the relays’ mailboxes: an invite to a new space for two, sealed to your door. The relay keeps it for up to two weeks and can’t read it or fake it.',
      },
      {
        title: 'Answering proves it’s you',
        body: 'Accepting joins the space and answers there, signed with the door’s key. Only then does the knocker learn whose door it was.',
      },
      {
        title: 'Hard to shut',
        body: 'A door names its own relays, like Nostr’s outbox model, and it’s a queue you can close rather than an identity, like SimpleX. As long as one of its relays is up, it works.',
      },
    ],
  },
];

/** What it gives up, and what isn't finished */
const LIMITS: ReadonlyArray<Point> = [
  {
    title: 'What a relay sees',
    body: 'Network addresses, the session keys that join each room, and which connections meet. Not which space a room is, and nothing that passes between peers.',
  },
  {
    title: 'What a host sees',
    body: 'Which spaces exist, how big they are, when they change, and the outside of each record: who wrote it, which collection, when. Not what’s inside. Record keys and collection names still say more than they should; hiding them is planned.',
  },
  {
    title: 'Members are visible',
    body: 'Anyone holding a space can see who’s in it, even without the key. That’s how devices that can’t read a space still check who may write.',
  },
  {
    title: 'Lose the seed, lose the account',
    body: 'There’s no server to reset it. And if the seed leaks, it can’t be rotated yet: a new seed is a new identity.',
  },
  {
    title: 'Reading can’t be undone',
    body: 'Whoever had a space’s key keeps what they read. Changing the key protects what comes next. An app you give a private space can read all of it.',
  },
  {
    title: 'You trust your keeper to be complete',
    body: 'A keeper that holds records back still looks up to date. Signed logs per writer, which would show the gap, are planned.',
  },
  {
    title: 'Not for global feeds',
    body: 'Weave is for data that’s private, shared by a few people, and works offline. Public feeds at the scale of a social network are what other protocols are for.',
  },
  {
    title: 'The bugs are written down',
    body: (
      <>
        Where our implementation does something the protocol shouldn’t need, the spec says so. For example: readers
        don’t check <code>prev</code> yet, so someone allowed to edit can skip <code>seq</code> ahead; delegation chains
        longer than one step don’t validate on records yet; and leaving a space only takes effect on your own device.
      </>
    ),
  },
];

function Section({ part }: { part: Part }) {
  return (
    <section className="band">
      <div className="wrap">
        <div className="section-head">
          <div className="kicker">{part.kicker}</div>
          <h2>{part.title}</h2>
          <p>{part.lead}</p>
        </div>
        <div className="points">
          {part.points.map((point) => (
            <div key={point.title}>
              <h3>{point.title}</h3>
              <p>{point.body}</p>
            </div>
          ))}
        </div>
        <a href={specPart(part.file)} {...EXTERNAL} className="spec-link">
          Read {part.kicker} →
        </a>
      </div>
    </section>
  );
}

export function Protocol() {
  return (
    <Page page="protocol">
      <section className="hero">
        <div className="wrap">
          <h1>
            No company in the middle.
            <br />
            Here’s how.
          </h1>
          <p>
            Your account is a key you keep. Your data is signed records. Every device checks the rules for itself. This
            is how each piece works, and what it can’t do.
          </p>
          <div className="actions">
            <a href={SPEC} {...EXTERNAL} className="btn btn-primary">
              Read the spec
            </a>
            <a href="/developers" className="btn btn-secondary">
              Build with it
            </a>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">The shape of it</div>
            <h2>Keys sign. Spaces hold. Devices check.</h2>
            <p>
              Your master key almost never signs data. Records live in spaces, every device in a space checks every
              record, and relays only make introductions. Nothing in the picture is in charge of the rest.
            </p>
          </div>
          <div className="code">
            <div className="bar">
              <span>spec/README.md</span>
            </div>
            <pre>
              <code>{SHAPE.replace(/^\n|\n$/g, '')}</code>
            </pre>
          </div>
        </div>
      </section>

      {PARTS.map((part) => (
        <Section key={part.file} part={part} />
      ))}

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Tradeoffs</div>
            <h2>What Weave doesn’t do.</h2>
            <p>No server means some things are harder, and some aren’t finished. Here they are.</p>
          </div>
          <div className="points">
            {LIMITS.map((point) => (
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
            <div className="kicker">Next</div>
            <h2>Designed, and on the way.</h2>
            <p>
              Permission chains that travel with a record, edit histories anyone can check, sealing with HPKE, signed
              writer logs, handles like @you.bsky.social that lead to a door, and more.
            </p>
          </div>
          <a href={specPart('README.md#planned-work')} {...EXTERNAL} className="spec-link">
            See everything planned →
          </a>
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <h2>Check our work.</h2>
          <p>The spec has every format, every signature and every check a device makes, with the tests behind each rule.</p>
          <div className="actions">
            <a href={SPEC} {...EXTERNAL} className="btn btn-primary">
              Read the spec
            </a>
            <a href="/developers" className="btn btn-secondary">
              For developers
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
