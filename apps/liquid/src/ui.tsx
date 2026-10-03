import type { ReactNode } from 'react';
import { Avatar } from '@weave/app-shared/Avatar';
import type { Choice, PartyRule } from './schema';
import type { Assembly, PartyFull, TopicView } from './model';
import { PARTY_SHARE, type Step, type Tally } from './tally';
import { hue, tone } from './styles';

export const CHOICE_LABEL: Readonly<Record<Choice, string>> = {
  for: 'For',
  against: 'Against',
  abstain: 'Abstain',
};

export const PARTY_RULE_LABEL: Readonly<Record<PartyRule, string>> = {
  majority: 'More than half',
  'two-thirds': 'Two-thirds',
  'three-quarters': 'Three-quarters',
  everyone: 'Everyone',
  representative: 'A representative',
};

/** How a party takes a position, in a few words: "5 of its 7 members vote alike", "Ada votes for it" */
export function decidesText(a: Assembly, party: Pick<PartyFull, 'decides' | 'representative' | 'members'>) {
  if (party.decides === 'representative')
    return party.representative && party.members.has(party.representative)
      ? `${a.name(party.representative)} votes for it`
      : 'Needs a representative who is a member';
  const n = party.members.size;
  return `${PARTY_SHARE[party.decides](n)} of its ${n} ${n === 1 ? 'member' : 'members'} vote alike`;
}

/** "just now", "5m", "3h", "2d", then a date */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function TopicChip({ topic }: { topic: TopicView }) {
  const c = hue(topic.hue);
  return (
    <span className="lq-chip" style={{ background: c.soft, borderColor: c.line, color: c.strong }}>
      <span className="lq-dot" style={{ background: c.strong }} />
      {topic.name}
    </span>
  );
}

/** Topics as chips to pick; `solid` fills the picked one, for a filter */
export function TopicPicker<T extends { name: string; hue: number }>({
  topics,
  on,
  onToggle,
  solid,
}: {
  topics: ReadonlyArray<T>;
  on: (topic: T) => boolean;
  onToggle: (topic: T) => void;
  solid?: boolean;
}) {
  return topics.map((t) => {
    const c = hue(t.hue);
    const picked = on(t);
    const style = solid
      ? { background: c.strong, borderColor: c.strong }
      : { background: c.soft, borderColor: c.strong, color: c.strong };
    return (
      <button
        key={'key' in t && typeof t.key === 'string' ? t.key : t.name}
        type="button"
        className="lq-chip"
        data-filter
        aria-pressed={picked}
        onClick={() => onToggle(t)}
        style={picked ? style : undefined}
      >
        <span className="lq-dot" style={{ background: picked && solid ? '#fff' : c.strong }} />
        {t.name}
      </button>
    );
  });
}

/** A party's mark: its initial on its colour */
export function PartyMark({ party, size = 28 }: { party: Pick<PartyFull, 'name' | 'hue'>; size?: number }) {
  const c = hue(party.hue);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size / 3.5,
        background: c.strong,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.46,
        fontWeight: 700,
        letterSpacing: '-0.02em',
      }}
    >
      {party.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function PartyChip({ party }: { party: PartyFull }) {
  const c = hue(party.hue);
  return (
    <span className="lq-chip" style={{ background: c.soft, borderColor: c.line, color: c.strong }}>
      <PartyMark party={party} size={14} />
      {party.name}
    </span>
  );
}

/** Someone, by face and name */
export function Who({
  did,
  a,
  size = 24,
  children,
}: {
  did: string;
  a: Assembly;
  size?: number;
  children?: ReactNode;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <Avatar did={did} size={size} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {did === a.me ? 'You' : a.name(did)}
      </span>
      {children}
    </span>
  );
}

/** A step on a vote's way: a person or a party */
function StepView({ step, a }: { step: Step; a: Assembly }) {
  if (step.kind === 'person') return <Who did={step.did} a={a} size={18} />;
  const party = a.partyOf(step.key);
  return party ? <PartyChip party={party} /> : <span className="lq-faint">a party that’s gone</span>;
}

/** Where a vote went: You → Ada → Greens */
export function PathView({ path, a, from }: { path: ReadonlyArray<Step>; a: Assembly; from: string }) {
  return (
    <span className="lq-path">
      <Who did={from} a={a} size={18} />
      {path.map((step, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="lq-path-arrow">→</span>
          <StepView step={step} a={a} />
        </span>
      ))}
    </span>
  );
}

/** For, against and abstain along one bar, out of everyone */
export function Meter({ tally, size }: { tally: Tally; size?: 'lg' }) {
  const all = tally.for + tally.against + tally.abstain + tally.uncast || 1;
  const pct = (n: number) => `${(n / all) * 100}%`;
  return (
    <div
      className="lq-meter"
      data-size={size}
      role="img"
      aria-label={`${tally.for} for, ${tally.against} against, ${tally.abstain} abstaining, ${tally.uncast} not cast`}
    >
      <span style={{ width: pct(tally.for), background: tone.for }} />
      <span style={{ width: pct(tally.against), background: tone.against }} />
      <span style={{ width: pct(tally.abstain), background: tone.abstain }} />
    </div>
  );
}

export function Upvote({
  count,
  pressed,
  disabled,
  onToggle,
}: {
  count: number;
  pressed: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="lq-upvote"
      aria-pressed={pressed}
      disabled={disabled}
      aria-label={pressed ? 'Take back your support' : 'Support: help it get seen'}
      title={pressed ? 'You support this' : 'Support this, so more people see it'}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <path d="M7 2.5 12 9H2z" fill="currentColor" />
      </svg>
      {count}
    </button>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" style={{ fontSize: 13, color: tone.against, lineHeight: 1.5 }}>
      {children}
    </p>
  ) : null;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="lq-empty lq-fade">
      <p style={{ fontSize: 15, fontWeight: 600, color: 'inherit' }}>{title}</p>
      {children}
    </div>
  );
}
