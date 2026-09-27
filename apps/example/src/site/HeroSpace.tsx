import { useEffect, useState, type ReactNode } from 'react';

/**
 * Under the front page's headline: a group's space, and one tool arriving in
 * it the way tools do in Weave. A member asks their AI, the proposal shows
 * what it would allow, someone whose role allows it adds it, and then people
 * use it. Four groups take turns, each with a tool drawn as a tiny working app.
 */

type Phase = 'ask' | 'proposal' | 'added' | 'open' | 'used';

const PHASES: ReadonlyArray<readonly [Phase, number]> = [
  ['ask', 2800],
  ['proposal', 2400],
  ['added', 1100],
  ['open', 1500],
  ['used', 2600],
];

interface Scene {
  readonly group: string;
  readonly people: string;
  /** The tools the group already made, beside chat and polls */
  readonly has: readonly string[];
  readonly tool: string;
  readonly who: string;
  readonly ask: string;
  readonly admin: string;
  readonly allows: readonly [string, string, string];
  /** What happens once it's in use, for the caption */
  readonly use: string;
  readonly app: (used: boolean) => ReactNode;
}

function Initial({ name, dim }: { name: string; dim?: boolean }) {
  return <span className={dim ? 'demo-initial dim' : 'demo-initial'}>{name[0]}</span>;
}

const SCENES: readonly Scene[] = [
  {
    group: 'Riverside FC',
    people: '34 members',
    has: ['Kit rota'],
    tool: 'Carpool',
    who: 'Maya',
    ask: 'Can we sort out lifts to away games?',
    admin: 'Anna',
    allows: ['Any member can offer a ride', 'Only the driver changes their ride', 'One seat per person on each ride'],
    use: 'Sam takes the last seat in Joe’s car.',
    app: (used) => (
      <div className="demo-app">
        <div className="demo-app-head">
          Saturday · away at Northside<span>2 rides</span>
        </div>
        {[
          { driver: 'Anna', seats: ['Maya', 'Leo', ''] },
          { driver: 'Joe', seats: ['Kai', 'Ola', used ? 'Sam' : ''] },
        ].map((ride) => (
          <div key={ride.driver} className="demo-row">
            <span>
              <b>{ride.driver}</b> is driving
            </span>
            <span className="demo-seats">
              {ride.seats.map((name, i) =>
                name ? (
                  <Initial key={i} name={name} />
                ) : (
                  <span key={i} className="demo-seat" />
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    group: 'Elm Street',
    people: '61 neighbours',
    has: ['Bin rota'],
    tool: 'Tool library',
    who: 'Priya',
    ask: 'Could we lend each other tools instead of all buying drills?',
    admin: 'Tom',
    allows: ['Anyone on the street can list a tool', 'Only its owner edits it', 'One borrower at a time'],
    use: 'Ben borrows Ali’s ladder.',
    app: (used) => (
      <div className="demo-app">
        <div className="demo-app-head">
          Tools on the street<span>3 listed</span>
        </div>
        {[
          { tool: 'Drill', owner: 'Tom', borrower: 'Lena' },
          { tool: 'Ladder', owner: 'Ali', borrower: used ? 'Ben' : '' },
          { tool: 'Pressure washer', owner: 'Priya', borrower: '' },
        ].map((item) => (
          <div key={item.tool} className="demo-row">
            <span>
              <b>{item.tool}</b> · {item.owner}
            </span>
            {item.borrower ? (
              <span className="demo-pill">With {item.borrower}</span>
            ) : (
              <span className="demo-pill free">Borrow</span>
            )}
          </div>
        ))}
      </div>
    ),
  },
  {
    group: 'Maple Court Tenants',
    people: '80 households',
    has: ['Meetings'],
    tool: 'Repairs',
    who: 'Dev',
    ask: 'We need one list of everything the landlord hasn’t fixed.',
    admin: 'Rosa',
    allows: ['Any household can report a repair', 'One “us too” per household', 'Only the committee changes the status'],
    use: 'Another household adds “us too”.',
    app: (used) => (
      <div className="demo-app">
        <div className="demo-app-head">
          Open repairs<span>3 open</span>
        </div>
        {[
          { issue: 'Lift out of order', count: used ? 15 : 14, status: 'Sent to landlord' },
          { issue: 'Damp in stairwell B', count: 9, status: 'Reported' },
          { issue: 'Broken entry buzzer', count: 6, status: 'Reported' },
        ].map((item) => (
          <div key={item.issue} className="demo-row">
            <span>
              <b>{item.issue}</b>
              <small>{item.status}</small>
            </span>
            <span className={used && item.count === 15 ? 'demo-pill bump' : 'demo-pill'}>{item.count} households</span>
          </div>
        ))}
      </div>
    ),
  },
  {
    group: 'Northside Food Bank',
    people: '25 volunteers',
    has: ['Stock count'],
    tool: 'Volunteer rota',
    who: 'Kofi',
    ask: 'A rota where people can grab a shift themselves?',
    admin: 'Iris',
    allows: ['Anyone can take an empty shift', 'One person per shift', 'Only you can drop your shift'],
    use: 'Ruth takes Thursday afternoon.',
    app: (used) => (
      <div className="demo-app">
        <div className="demo-app-head">
          This week<span>{used ? 'All covered' : '1 shift open'}</span>
        </div>
        <div className="demo-rota">
          <span />
          <span className="demo-rota-label">Morning</span>
          <span className="demo-rota-label">Afternoon</span>
          {[
            ['Mon', 'Kofi', 'Iris'],
            ['Wed', 'Ben', 'Ola'],
            ['Thu', 'Sam', used ? 'Ruth' : ''],
          ].map(([day, morning, afternoon]) => (
            <Rota key={day} day={day ?? ''} slots={[morning ?? '', afternoon ?? '']} />
          ))}
        </div>
      </div>
    ),
  },
];

function Rota({ day, slots }: { day: string; slots: readonly string[] }) {
  return (
    <>
      <span className="demo-rota-label">{day}</span>
      {slots.map((name, i) =>
        name ? (
          <span key={i} className="demo-shift">
            <Initial name={name} /> {name}
          </span>
        ) : (
          <span key={i} className="demo-shift open">
            Take it
          </span>
        ),
      )}
    </>
  );
}

const CHAT = 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z';
const POLL = 'M3 13V8M8 13V3M13 13V6';

function AppIcon({ name }: { name: string }) {
  const d = name === 'Chat' ? CHAT : name === 'Polls' ? POLL : null;
  return d ? (
    <svg className="demo-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  ) : (
    <span className="demo-icon letter">{name[0]}</span>
  );
}

function caption(scene: Scene, phase: Phase): ReactNode {
  switch (phase) {
    case 'ask':
      return (
        <>
          <b>{scene.who}</b> asks an AI for a {scene.tool.toLowerCase()}.
        </>
      );
    case 'proposal':
      return <>It arrives as a proposal. Everyone can see what it would allow.</>;
    case 'added':
      return (
        <>
          <b>{scene.admin}</b>, an admin, adds it.
        </>
      );
    default:
      return (
        <>
          Everyone in {scene.group} has it now. {phase === 'used' ? scene.use : ''}
        </>
      );
  }
}

export function HeroSpace() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [at, setAt] = useState({ scene: 0, phase: still ? PHASES.length - 1 : 0 });

  useEffect(() => {
    if (still) return;
    const timer = setTimeout(
      () =>
        setAt(({ scene, phase }) =>
          phase + 1 < PHASES.length ? { scene, phase: phase + 1 } : { scene: (scene + 1) % SCENES.length, phase: 0 },
        ),
      PHASES[at.phase]?.[1] ?? 2000,
    );
    return () => clearTimeout(timer);
  }, [at, still]);

  const scene = SCENES[at.scene] ?? SCENES[0]!;
  const phase = PHASES[at.phase]?.[0] ?? 'used';
  const inSpace = phase === 'open' || phase === 'used';
  const apps = ['Chat', 'Polls', ...scene.has, ...(phase === 'ask' || phase === 'proposal' ? [] : [scene.tool])];

  return (
    <div className="demo" aria-hidden>
      <div className="demo-side">
        <div className="demo-group">
          <b>{scene.group}</b>
          <span>{scene.people}</span>
        </div>
        <div className="demo-apps">
          {apps.map((name) => (
            <div
              key={`${scene.group}-${name}`}
              className={['demo-app-link', name === scene.tool ? 'new' : '', name === scene.tool && inSpace ? 'current' : ''].join(' ')}
            >
              <AppIcon name={name} />
              {name}
            </div>
          ))}
        </div>
      </div>

      <div className="demo-main">
        <div className="demo-stage" key={`stage-${at.scene}-${inSpace ? 'app' : phase === 'ask' ? 'ask' : 'proposal'}`}>
          {phase === 'ask' ? (
            <div className="demo-assistant">
              <div className="demo-assistant-head">{scene.who}’s AI assistant</div>
              <div className="demo-bubble me">{scene.ask}</div>
              <div className="demo-bubble ai">
                I’ve proposed <b>{scene.tool}</b> to {scene.group}. Someone who can add apps there will see it.
              </div>
            </div>
          ) : !inSpace ? (
            <div className="demo-proposal">
              <div className="demo-proposal-head">
                <b>{scene.tool}</b>
                <span className="demo-tag">{phase === 'added' ? 'Added' : 'Proposal'}</span>
              </div>
              <div className="demo-by">
                {scene.who} · via AI
              </div>
              <div className="demo-allows">What it allows</div>
              <ul>
                {scene.allows.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
              <div className="demo-actions">
                <span className={phase === 'added' ? 'demo-btn primary pressed' : 'demo-btn primary'}>
                  {phase === 'added' ? `Added by ${scene.admin}` : 'Add to space'}
                </span>
                <span className="demo-btn">Read the code</span>
              </div>
            </div>
          ) : (
            <div className="demo-app-frame">
              <div className="demo-app-title">{scene.tool}</div>
              {scene.app(phase === 'used')}
            </div>
          )}
        </div>
        <div className="demo-caption" key={`caption-${at.scene}-${phase}`}>
          {caption(scene, phase)}
        </div>
      </div>
    </div>
  );
}
