import { useEffect, useState } from 'react';

/**
 * Under the front page's headline: a community's space, filling up with tools
 * its members asked for. Each one is asked for, proposed, then added by the
 * group, and when the space is full the next kind of group takes its turn.
 * It is the headline shown rather than told.
 */

interface Arrival {
  readonly tool: string;
  readonly who: string;
  readonly ask: string;
}

interface Group {
  readonly name: string;
  readonly people: string;
  readonly arrivals: readonly [Arrival, Arrival, Arrival, Arrival];
}

const BUILT_IN = ['Chat', 'Polls', 'Kanban', 'Calls'] as const;

const GROUPS: readonly Group[] = [
  {
    name: 'Riverside FC',
    people: '34 members',
    arrivals: [
      { tool: 'Carpool', who: 'Maya', ask: 'Can we sort out lifts to away games?' },
      { tool: 'Kit rota', who: 'Joe', ask: 'Whose turn is it to wash the kit?' },
      { tool: 'Availability', who: 'Sam', ask: 'Who can play on Saturday?' },
      { tool: 'Subs', who: 'Anna', ask: 'Who has paid this season’s subs?' },
    ],
  },
  {
    name: 'Elm Street',
    people: '61 neighbours',
    arrivals: [
      { tool: 'Tool library', who: 'Priya', ask: 'Could we lend each other tools?' },
      { tool: 'Bin rota', who: 'Tom', ask: 'Who’s putting the bins out this week?' },
      { tool: 'Street party', who: 'Lena', ask: 'Let’s plan the summer party.' },
      { tool: 'Lost and found', who: 'Ali', ask: 'Has anyone seen a grey cat?' },
    ],
  },
  {
    name: 'Thursday Book Club',
    people: '12 readers',
    arrivals: [
      { tool: 'Next picks', who: 'Ruth', ask: 'What should we read next?' },
      { tool: 'Host rota', who: 'Ben', ask: 'Whose place is it this month?' },
      { tool: 'Book loans', who: 'Iris', ask: 'Who has my copy of Middlemarch?' },
      { tool: 'Quotes', who: 'Kofi', ask: 'Somewhere to keep our favourite lines.' },
    ],
  },
];

const BEAT = 1700; // ms per step: asked, then added
const STEPS = 11; // four arrivals of two steps each, then a pause on the full space

export function HeroSpace() {
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const [tick, setTick] = useState(still ? STEPS - 1 : 0);

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setTick((t) => t + 1), BEAT);
    return () => clearInterval(timer);
  }, [still]);

  const group = GROUPS[Math.floor(tick / STEPS) % GROUPS.length] ?? GROUPS[0]!;
  const step = tick % STEPS;
  const current = step < 8 ? group.arrivals[Math.floor(step / 2)] : undefined;
  const asking = step < 8 && step % 2 === 0;

  return (
    <div className="space-demo" aria-hidden>
      <div className="space-head">
        <b>{group.name}</b>
        <span>{group.people}</span>
      </div>
      <div className="space-tiles">
        {BUILT_IN.map((tool) => (
          <div key={tool} className="space-tile">
            {tool}
          </div>
        ))}
        {group.arrivals.map((arrival, i) => {
          const state = step > 2 * i ? 'added' : step === 2 * i ? 'proposed' : 'empty';
          return (
            <div key={`${group.name}-${arrival.tool}`} className={`space-tile ${state}`}>
              {state === 'empty' ? '' : arrival.tool}
              {state === 'proposed' && <small>Proposed</small>}
            </div>
          );
        })}
      </div>
      <div className="space-caption" key={`${group.name}-${step}`}>
        {current ? (
          asking ? (
            <>
              <b>{current.who}</b> asked their AI: “{current.ask}”
            </>
          ) : (
            <>
              The group added <b>{current.tool}</b>. Everyone has it now.
            </>
          )
        ) : (
          <>Four new tools, and nobody had to build or host any of them.</>
        )}
      </div>
    </div>
  );
}
