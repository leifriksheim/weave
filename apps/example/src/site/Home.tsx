import type { ReactNode } from 'react';
import { Feature, Page } from './Site';
import { HeroMesh } from './HeroMesh';

/**
 * The front page, for communities. Its story is the one thing no platform
 * offers: a member asks an agent for a tool, the agent proposes it into the
 * space (`apps_propose`), and someone whose role allows it adds it. The mock-ups
 * are drawn in HTML after what the app shows
 * (`apps/example/src/components/apps/MadeApps.tsx`), so the page needs no images.
 */

/** One step of the story: a number, a title, a line, and a small mock-up of the app */
function Moment({ n, title, children, mock }: { n: number; title: string; children: ReactNode; mock: ReactNode }) {
  return (
    <div className="moment">
      <div className="moment-text">
        <div className="step-label">Step {n}</div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
      <div className="mock" aria-hidden>
        {mock}
      </div>
    </div>
  );
}

const ASK = (
  <div className="chat">
    <div className="bubble me">Our team needs a carpool for Saturday’s away game. Can you add one to the club’s space?</div>
    <div className="bubble agent">
      I’ve proposed <b>Carpool</b> in Riverside FC: rides for each match, and seats people can take. An admin can add it
      from Apps.
    </div>
  </div>
);

const REVIEW = (
  <div className="proposal">
    <div className="proposal-head">
      <b>Carpool</b>
      <span className="tag">Proposal</span>
    </div>
    <div className="by">Maya · via agent</div>
    <div className="allows">What it allows</div>
    <ul>
      <li>Any member can offer a ride</li>
      <li>Only the driver changes their ride</li>
      <li>One seat per person on each ride</li>
    </ul>
    <div className="sealed">Has its own screen. It can’t reach the internet or store anything.</div>
    <div className="proposal-actions">
      <span className="mini-btn primary">Add to space</span>
      <span className="mini-btn">Read the code</span>
    </div>
  </div>
);

const ADDED = (
  <div className="tiles">
    {['Chat', 'Polls', 'Kanban', 'Calls'].map((name) => (
      <div key={name} className="tile">
        {name}
      </div>
    ))}
    <div className="tile new">
      Carpool
      <span>New</span>
    </div>
  </div>
);

const USE = (
  <div className="carpool">
    <div className="carpool-head">Sat · away at Northside</div>
    {[
      { driver: 'Anna', seats: 3, taken: 2, mine: true },
      { driver: 'Joe', seats: 4, taken: 1, mine: false },
    ].map((ride) => (
      <div key={ride.driver} className="ride">
        <div>
          <b>{ride.driver}</b>
          <div className="seats">
            {Array.from({ length: ride.seats }, (_, i) => (
              <span key={i} className={i < ride.taken ? 'seat taken' : 'seat'} />
            ))}
          </div>
        </div>
        <span className={ride.mine ? 'mini-btn' : 'mini-btn primary'}>{ride.mine ? 'Your seat' : 'Take a seat'}</span>
      </div>
    ))}
  </div>
);

/** Tools too small for any company to make, and exactly right for one group */
const IDEAS = [
  'Carpool',
  'Volunteer rota',
  'Tool library',
  'Potluck sign-up',
  'Decision log',
  'Lost and found',
  'Match availability',
  'Book club picks',
  'Chore wheel',
  'Event RSVPs',
  'Shared budget',
  'Garden plot map',
];

export function Home() {
  return (
    <Page page="home">
      <section className="hero has-mesh">
        <HeroMesh />
        <div className="wrap">
          <h1>
            Every tool your group needs,
            <br />
            made by your group.
          </h1>
          <p>
            A shared space for your community, with chat and polls to begin with. When you need something else, describe
            it to your AI assistant. The group says yes, and everyone has it. No servers, and no platform in charge.
          </p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Start a community
            </a>
            <a href="#how" className="btn btn-secondary">
              See how a tool arrives
            </a>
          </div>
        </div>
      </section>

      <section className="band" id="how">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">How a new tool arrives</div>
            <h2>From “we need a carpool” to everyone using one, in minutes.</h2>
            <p>
              Nobody writes a line of code, and nothing is deployed. The tool lives in your community’s space, next to
              everything else.
            </p>
          </div>
          <div className="moments">
            <Moment n={1} title="Someone asks their AI" mock={ASK}>
              Any member with Claude, Cursor or another assistant connected describes what the group needs. The
              assistant can’t add anything by itself. It proposes.
            </Moment>
            <Moment n={2} title="Everyone sees the proposal" mock={REVIEW}>
              What it allows is worked out from its rules, not from what the assistant says about it. If it brings its
              own screen, the code is there to read.
            </Moment>
            <Moment n={3} title="The group says yes" mock={ADDED}>
              Whoever your roles allow adds it: the admins, to begin with. It sits beside the chat and the polls, for
              everyone in the space.
            </Moment>
            <Moment n={4} title="Everyone uses it" mock={USE}>
              On laptops and phones, live, and offline too. Every seat taken is checked against the rules on every
              device, so one seat each means one seat each.
            </Moment>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">What changed</div>
            <h2>Making software is almost free now. Running it isn’t.</h2>
            <p>
              A group can have exactly the tool it needs in an afternoon. What stops it is everything around the tool,
              and that’s why communities end up renting space on someone else’s platform.
            </p>
          </div>
          <div className="points">
            <div>
              <h3>Your community lives on their platform</h3>
              <p>
                The members, the history and the rules sit with a company that can change its terms, its prices or its
                mind. Leaving means starting over.
              </p>
            </div>
            <div>
              <h3>The tools you need are too small to exist</h3>
              <p>
                Nobody builds a carpool for one football club or a rota for one food bank. So it ends up in a
                spreadsheet, and someone chases everyone by message.
              </p>
            </div>
            <div>
              <h3>Bots see everything</h3>
              <p>
                Adding an integration usually means handing a stranger’s server access to every message. Most groups
                either don’t, or stop asking.
              </p>
            </div>
            <div>
              <h3>Weave takes the running away</h3>
              <p>
                Accounts, storage, sharing and permissions are built in, and nobody has to host anything. So a tool can
                be just the part that’s about your group.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Your rules</div>
            <h2>Run by your group. Enforced by everyone’s device.</h2>
            <p>
              On a platform, the rules are whatever its servers do. In Weave there’s no server to decide, so every device
              checks every change against the rules your group set.
            </p>
          </div>
          <div className="grid">
            <Feature icon="M8 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM2.5 14.5c.6-2.8 2.8-4.5 5.5-4.5s4.9 1.7 5.5 4.5" title="Roles you design">
              Start with admins, moderators and members, or make your own. Each role has a rank and a list of what it
              may do, and it lives in your space, not in anyone’s code.
            </Feature>
            <Feature icon="M3 8.5l3 3 7-7" title="New tools are a decision">
              A proposal changes nothing until someone whose role allows it says yes. What each tool may do is written
              in its rules, where everyone can see it.
            </Feature>
            <Feature icon="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" title="Moderation that holds">
              Moderators keep order in every tool at once, including ones added later. Whatever they remove is gone for
              everyone, whichever app it’s opened in.
            </Feature>
            <Feature icon="M4 4l8 8M12 4l-8 8" title="Removal that sticks">
              Remove someone, and from then on their changes stop counting on every device. Backdating a change doesn’t
              get around it.
            </Feature>
            <Feature icon="M2 4h12M2 8h12M2 12h8" title="No terms to change overnight">
              No ads, no one reading along, no feed deciding what members see. The only rules are the ones your group
              wrote down.
            </Feature>
            <Feature icon="M1.5 4h5v8h-5zM9.5 4h5v8h-5zM6.5 8h3" title="Share what works">
              Made a great rota? Propose it in another community you’re part of. The people there decide for themselves.
            </Feature>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="split">
            <div>
              <div className="kicker-inline">Safe to say yes to</div>
              <h3>A tool can only touch its own part of your space.</h3>
              <p>
                A tool your group adds runs sealed off. It can read and write its own records, as the person using it,
                and every write is checked against its rules. That’s all it can do.
              </p>
              <ul>
                <li>No internet: it can’t send your data anywhere</li>
                <li>No storage of its own: everything it keeps is a record in the space</li>
                <li>No way around the rules: other devices refuse what breaks them</li>
                <li>Private spaces are encrypted on your device before anything leaves it</li>
              </ul>
            </div>
            <div className="compare compare-one">
              <div className="col">
                <h3>A typical bot</h3>
                <ul>
                  <li>Runs on a stranger’s server</li>
                  <li>Reads every message it’s allowed near</li>
                  <li>Does whatever its code does</li>
                  <li>Gone when its maker stops paying</li>
                </ul>
              </div>
              <div className="col us">
                <h3>A Weave tool</h3>
                <ul>
                  <li>Runs sealed, on members’ own devices</li>
                  <li>Reads only its own records</li>
                  <li>Can only do what its rules allow</li>
                  <li>Lives in your space for as long as you keep it</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">What groups make</div>
            <h2>Tools too small for any company, and just right for you.</h2>
            <p>
              Chat, polls, a kanban board and calls come built in. Everything else is one conversation with an assistant
              away.
            </p>
          </div>
          <div className="ideas">
            {IDEAS.map((idea) => (
              <span key={idea}>{idea}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Three ways in</div>
            <h2>Start wherever you are.</h2>
          </div>
          <div className="doors">
            <a href="/app" className="door">
              <h3>I run a community</h3>
              <p>
                Make a space, invite people with a link, and start with chat and polls. Nobody in your group needs an AI
                to take part.
              </p>
              <span>Start a community →</span>
            </a>
            <a href="/app" className="door">
              <h3>I make things with AI</h3>
              <p>
                Connect Claude Code, Claude Desktop or Cursor from the app with one command, and propose tools into any
                space you’re in.
              </p>
              <span>Connect an assistant →</span>
            </a>
            <a href="/developers" className="door">
              <h3>I’m a developer</h3>
              <p>
                Identity, storage, sync, encryption and permissions in one library, with no backend. There’s an open
                spec as well.
              </p>
              <span>Build on Weave →</span>
            </a>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="section-head">
            <div className="kicker">Fair questions</div>
            <h2>Before you move your group.</h2>
          </div>
          <div className="points">
            <div>
              <h3>Is it ready?</h3>
              <p>
                It’s early. The app works and the protocol is written down, but it’s version 0.2 and will still change.
                Try it with a group that’s up for it, not with the one thing you can’t lose.
              </p>
            </div>
            <div>
              <h3>Does everyone need an AI assistant?</h3>
              <p>
                No. Only whoever makes a new tool does. Everyone else opens the invite link and uses what the group has
                added.
              </p>
            </div>
            <div>
              <h3>Who runs the servers?</h3>
              <p>
                Nobody has to. Data goes straight between members’ devices. Relays help them find each other and can’t
                read what passes through. An always-on node keeps things reachable while everyone’s laptop is shut.
              </p>
            </div>
            <div>
              <h3>What if I lose my password?</h3>
              <p>
                Your account is yours, which cuts both ways. Keep the password Weave makes for you in a password manager,
                and you can restore it on any device. Without it, or a device that’s still signed in, nobody can get it
                back for you, including us.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <h2>Give your group a home of its own.</h2>
          <p>It takes a minute. Invite people with a link.</p>
          <div className="actions">
            <a href="/app" className="btn btn-primary">
              Start a community
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
