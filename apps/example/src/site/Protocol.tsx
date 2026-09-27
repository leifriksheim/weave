import type { ReactNode } from 'react';
import { EXTERNAL, GITHUB, Page, SPEC } from './Site';

/**
 * How it works, for people who want the design before the code: one section
 * per part of the spec, what it does and why, then where it stops. Every claim
 * here is a summary of `spec/`; when the two disagree, the spec wins and this
 * page is the bug.
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
    title: 'An account is sixteen bytes.',
    lead: 'No server issues identities. An account is a random seed, and everything else about it is worked out from that seed.',
    file: '01-identity.md',
    points: [
      {
        title: 'Everything is derived',
        body: 'Every key an account uses comes from its 16-byte seed through HKDF. The same seed gives the same identity on any device and any site. Written down, the seed is the recovery code.',
      },
      {
        title: 'The name is a public key',
        body: (
          <>
            An account is named by a <code>did:key</code> of its P-256 root key. Anyone can check a signature against
            that name without asking anyone else.
          </>
        ),
      },
      {
        title: 'The root key signs one thing',
        body: 'It signs short-lived delegations (UCANs) to session keys, and never records. Session keys sign records. A node asks for a fresh delegation before the old one runs out, by default about once an hour.',
      },
      {
        title: 'Apps and agents get a note, not the seed',
        body: 'An app or an agent signs with a key of its own, under a note from the account. It can’t sign in as the account, and its access ends when the note does. A note marked as an agent’s can never change who may do what.',
      },
      {
        title: 'Passkeys are a gate',
        body: 'A passkey unlocks the seed stored on a device. It isn’t the identity: a passkey is bound to one site, and support for getting a secret out of one is uneven.',
      },
    ],
  },
  {
    kicker: '02 — Records',
    title: 'Signed JSON, and edits are versions.',
    lead: 'A record is a signed, versioned JSON document in a collection of a space. What a peer checks before it keeps one is written down exactly.',
    file: '02-records.md',
    points: [
      {
        title: 'One canonical form',
        body: 'Every hash and every signature is over one canonical encoding of the JSON, so two implementations agree on the bytes.',
      },
      {
        title: 'The winner is never the clock',
        body: (
          <>
            Of two versions of a record, the higher <code>seq</code> wins, then the lower id. A replayed old version
            loses, a delete stays deleted, and two devices that edited apart pick the same winner, in any order.
          </>
        ),
      },
      {
        title: 'Definitions travel with the data',
        body: 'A collection’s schema, links and rules are themselves records in the space. An app or agent that has never seen the space can read what it holds and what’s allowed.',
      },
      {
        title: 'Four gates, one pipeline',
        body: 'Shape, signature, delegation, then standing against the space’s rules. A version written here, synced from a peer or read from a folder passes the same checks.',
      },
      {
        title: 'What a peer never refuses',
        body: 'A body that doesn’t fit its schema, or a collection nobody defined, is kept and flagged, not refused. Those depend on which definition a peer happens to hold, and refusing would leave peers disagreeing forever.',
      },
    ],
  },
  {
    kicker: '03 — Spaces',
    title: 'Every peer is the referee.',
    lead: 'A space carries its own rules: roles, who holds them, what each collection accepts. There is no server to ask who may write.',
    file: '03-spaces.md',
    points: [
      {
        title: 'Access is recorded in the space',
        body: 'Roles, members, invites and revocations are records in the space itself. Every record names the access history its writer had seen when it was written.',
      },
      {
        title: 'Same history, same verdict',
        body: 'Every peer replays the history with the same pure function, in the same order, with the same tie-breaks. Devices that were offline, or saw changes in a different order, reach the same answer.',
      },
      {
        title: 'Rank decides who manages whom',
        body: 'Managing roles takes the manage permission, and a role can only create or change roles ranked below its own.',
      },
      {
        title: 'Private means encrypted before signing',
        body: 'In a private space every record body is encrypted with the space key (AES-256-GCM). The envelope and the access records stay in the clear, so a peer that can’t read still judges who may write.',
      },
      {
        title: 'The invite carries the key',
        body: 'An invite holds the space and, for a private one, its key. A role invite also holds a secret that matches an open invite record. Sharing a private space never goes through a server.',
      },
      {
        title: 'Removal changes the key',
        body: 'When someone loses their place, a manager makes a new space key and seals it to each remaining member. A removed member reads nothing written afterwards.',
      },
    ],
  },
  {
    kicker: '04 — Network',
    title: 'Relays introduce. They decide nothing.',
    lead: 'Peers talk directly, over WebRTC data channels between browsers or a WebSocket to an always-on node. Relays only help them meet.',
    file: '04-network.md',
    points: [
      {
        title: 'A phone book, not an authority',
        body: 'A relay holds no data and has no say. A relay that lies can at worst fail to introduce, or introduce the wrong peer, and the handshake catches that.',
      },
      {
        title: 'Rooms that don’t name the space',
        body: 'Peers of a space meet in a room named by a hash of its id. The relay learns which connections belong together, not which space they are.',
      },
      {
        title: 'Every connection proves who’s there',
        body: 'Before a byte of a space crosses a connection, each side signs with the key its DID names. In a private space, each also proves it holds the space’s read key.',
      },
      {
        title: 'Peers introduce peers',
        body: 'Once connected to one peer, that connection arranges the next, so a relay is needed only to meet the first. A client can use several relays at once, and a space names its own.',
      },
    ],
  },
  {
    kicker: '05 — Sync and storage',
    title: 'The cost follows the difference.',
    lead: 'Sync works per space and per collection, by comparing sets of version ids. There is no tree and no other sync state on disk.',
    file: '05-sync-and-storage.md',
    points: [
      {
        title: 'Set reconciliation',
        body: 'Peers swap one fingerprint per collection. Where they differ, Negentropy narrows down exactly which versions each side lacks. Two stores of 2,000 versions that differ by one exchange under 8 KB.',
      },
      {
        title: 'Clocks only order',
        body: 'A version’s time only places it for comparison. It never decides which version wins, so a writer with a wrong clock only makes its own versions slower to find.',
      },
      {
        title: 'Keepers hold it whole',
        body: 'A space can name keepers that hold every record. An app can then keep only the collections it uses, and its writes stay pending until enough keepers confirm them.',
      },
      {
        title: 'Storage you can point at',
        body: 'Versions live in IndexedDB for one site, or in a data folder that every app on the machine shares. The folder’s space keys are sealed under the account’s vault key.',
      },
    ],
  },
  {
    kicker: '06 — Nodes, sessions and apps',
    title: 'One node, and many ways to hold one.',
    lead: 'The node is the object every front end is a thin layer over: a browser tab, the command line, the always-on daemon, an agent.',
    file: '06-nodes-and-sessions.md',
    points: [
      {
        title: 'Plain data in and out',
        body: 'A node acts for one account with one session key. Every value it returns is plain JSON, so the same operations become CLI commands, MCP tools and WebMCP tools.',
      },
      {
        title: 'The account home',
        body: 'An app never holds the seed. It asks an account home, a page the person chose, which signs a note to the app’s key: these spaces, read or write, for a set number of days (seven unless someone picks otherwise).',
      },
      {
        title: 'Disconnecting revokes',
        body: 'Disconnecting an app writes a revocation into each space it could write in. From then on nothing written under its note counts, apart from versions the revoker had already seen.',
      },
      {
        title: 'Carriers can’t read what they carry',
        body: 'A carrier, or a host that carries for many accounts, keeps spaces online. It holds records as they travel and a read key that only proves it may take part. No seed, no space key, no note: it signs nothing.',
      },
    ],
  },
  {
    kicker: '07 — Doors',
    title: 'Reachable, but only on purpose.',
    lead: 'A DID is on everything an account signs, so knowing it must not be enough to reach someone. A door is an address you hand out, and can close.',
    file: '07-doors.md',
    points: [
      {
        title: 'The code doesn’t name you',
        body: 'A door code holds two public keys derived for that door and one to three relays. The account behind it isn’t in the code, or in anything a relay holds.',
      },
      {
        title: 'Knocks are sealed and signed',
        body: 'Someone with the code leaves a knock in the relays’ mailboxes: an invite to a new space for two, sealed to the door. The relay holds it for up to 14 days and can’t read it, forge it or change it.',
      },
      {
        title: 'The answer proves who opened',
        body: 'Accepting joins the space and answers there, signed with the door’s own key. The knocker learns whose door it was only then.',
      },
      {
        title: 'Borrowed ideas',
        body: 'The address names its own relays, as in Nostr’s outbox model, and is a revocable queue rather than an identity, as in SimpleX. No relay can take a door down while another it names is up.',
      },
    ],
  },
];

/** Where it stops, each one said in the spec where it applies */
const LIMITS: ReadonlyArray<Point> = [
  {
    title: 'What a relay sees',
    body: 'The network addresses of sockets, the session DIDs that join each room, and which connections meet in the same room. Not which space a room is, and nothing that crosses a peer connection.',
  },
  {
    title: 'What a carrier or host sees',
    body: 'Which spaces exist, how big they are and when they change, and every record’s outside: author, collection, times, topic tags. Not bodies or links. Record keys and collection names still give away more than they need to; hiding them is planned.',
  },
  {
    title: 'Membership is visible to anyone holding the space',
    body: 'Member records name each account in the clear, by design, so a peer that can’t read the space can still judge who may write in it.',
  },
  {
    title: 'Lose the seed, lose the account',
    body: 'An account is its seed. There is no server to reset it. A leaked seed can’t be rotated either: a new seed is a new identity. Rotation is proposed, not designed.',
  },
  {
    title: 'Reading can’t be taken back',
    body: 'Whoever held a private space’s key keeps what they read, and the earlier keys. A key change protects what comes after. Grants are per space, so an app given a private space can read all of it.',
  },
  {
    title: 'Completeness rests on trust',
    body: 'A keeper that withholds versions still looks up to date, and a reader can’t tell. Signed writer logs that would let it tell are planned.',
  },
  {
    title: 'Not a global public feed',
    body: 'Weave is for data that is private, shared between a few people, and works offline. Public feeds at the scale of a social network are what other protocols are built for.',
  },
  {
    title: 'Known defects are written down',
    body: (
      <>
        Where the reference implementation does something the protocol shouldn’t require, the spec says so in place,
        with its issue. For example: readers don’t yet check <code>prev</code>, so a writer allowed to edit can skip{' '}
        <code>seq</code> ahead; delegation chains deeper than one link don’t yet validate on records; and leaving a
        space is still local only.
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
          <h1>How Weave works.</h1>
          <p>
            The design on one page: what each piece does, why, and where it stops. Every section links to the part of
            the specification it summarises, which says exactly what a peer must produce and check.
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
            <h2>Keys sign records. Spaces hold them. Peers check them.</h2>
            <p>
              The root key almost never signs data. Records live in spaces, every peer in a space checks every record,
              and relays only introduce. Nothing in the picture has authority over the rest.
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
            <div className="kicker">Limits</div>
            <h2>What Weave doesn’t do.</h2>
            <p>What the protocol hides, what it can’t, and what isn’t built yet, said plainly.</p>
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
            <div className="kicker">Planned</div>
            <h2>Designed, not built yet.</h2>
            <p>
              Work that’s designed lives in the spec as a Planned section, next to what it changes, and is listed in one
              table with its issue: proof chains that travel, versions whose history can be checked, sealing with HPKE,
              signed writer logs, handles that lead to a door, and more. Planned text isn’t normative until it’s built.
            </p>
          </div>
          <a href={specPart('README.md#planned-work')} {...EXTERNAL} className="spec-link">
            See the Planned table →
          </a>
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <h2>Read the spec.</h2>
          <p>Seven parts: exact formats, what’s signed, what every peer checks, and the tests that pin each rule.</p>
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
