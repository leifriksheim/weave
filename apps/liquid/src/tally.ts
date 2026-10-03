/**
 * How a proposal is settled, and how a vote travels. Pure functions over the
 * records, so every device reaches the same answer from the same votes.
 *
 * Every rule here only grows: once true, no vote arriving later makes it
 * false. That is what lets devices agree without anyone closing the vote.
 *
 * - **Who votes** is fixed by the proposal: its voters, N of them.
 * - **Votes are final.** Each voter casts one, themselves or by their device
 *   following someone they trust (`via`).
 * - **Passed** once more than N/2 voted for. **Rejected** once at least N/2
 *   voted against or abstained, so for can no longer pass. Until then it is
 *   open, however long that takes.
 * - **Disputed** once someone is caught saying two things about it (a
 *   conflict). That sits above passed and rejected: it never goes back.
 *
 * Following: when you haven't voted, your device looks up whom you trust on
 * the proposal's topic (else on everything). Once that person has voted, or
 * that party has taken a position, it casts the same vote for you. Along a
 * chain this happens one device at a time; a loop never casts anything.
 */
import { EVERYTHING, type Choice } from './schema';

/** A vote as cast */
export interface CastVote {
  readonly choice: Choice;
  /** Whom it followed: a DID or a party's key; null when they voted themselves */
  readonly via: string | null;
  /** The version's id, for a proof to cite */
  readonly version: string;
  /** The vote record's key */
  readonly key: string;
}

/** Votes on one proposal, by voter DID */
export type Votes = ReadonlyMap<string, CastVote>;

export interface Tally {
  readonly for: number;
  readonly against: number;
  readonly abstain: number;
  /** Voters who haven't voted yet */
  readonly uncast: number;
}

export type Outcome = 'passed' | 'rejected';
export type Result = 'open' | Outcome | 'disputed';

/** The count among a proposal's voters; votes from anyone else are left out */
export function tally(voters: ReadonlyArray<string>, votes: Votes): Tally {
  const counted = { for: 0, against: 0, abstain: 0, uncast: 0 };
  for (const did of new Set(voters)) {
    const cast = votes.get(did);
    if (cast) counted[cast.choice]++;
    else counted.uncast++;
  }
  return counted;
}

const voterCount = (t: Tally) => t.for + t.against + t.abstain + t.uncast;

/** Whether the count settles it: more than half for, or at least half not for */
export function settled(t: Tally): Outcome | null {
  const n = voterCount(t);
  if (n === 0) return null;
  if (t.for * 2 > n) return 'passed';
  if ((t.against + t.abstain) * 2 >= n) return 'rejected';
  return null;
}

/** How many more votes for it needs to pass, and how many not for to fail */
export function needed(t: Tally): { readonly toPass: number; readonly toFail: number } {
  const n = voterCount(t);
  return {
    toPass: Math.max(0, Math.floor(n / 2) + 1 - t.for),
    toFail: Math.max(0, Math.ceil(n / 2) - t.against - t.abstain),
  };
}

/**
 * The votes a decision cites: just enough for its outcome, picked in a fixed
 * order so two devices make the same proof. Null when the count doesn't
 * settle it that way.
 */
export function proof(voters: ReadonlyArray<string>, votes: Votes, outcome: Outcome): string[] | null {
  const n = new Set(voters).size;
  const enough = outcome === 'passed' ? Math.floor(n / 2) + 1 : Math.ceil(n / 2);
  const counts = (v: CastVote) => (outcome === 'passed' ? v.choice === 'for' : v.choice !== 'for');
  const cited = [...new Set(voters)]
    .sort()
    .map((did) => votes.get(did))
    .filter((v): v is CastVote => v !== undefined && counts(v))
    .slice(0, enough)
    .map((v) => v.version);
  return cited.length === enough && enough > 0 ? cited : null;
}

/** A proposal's place on the ladder: open, then passed or rejected, then disputed */
export function resultOf(decided: Outcome | null, disputed: boolean): Result {
  return disputed ? 'disputed' : (decided ?? 'open');
}

// ─── Parties ─────────────────────────────────────────────────────────

/**
 * A party's position: the choice more than half of its frozen members voted
 * themselves, with the votes that prove it. Votes cast by following don't
 * count, so a party never counts its own followers.
 */
export function partyPosition(
  members: ReadonlyArray<string>,
  votes: Votes,
): { readonly choice: Choice; readonly votes: string[] } | null {
  const roll = [...new Set(members)].sort();
  const enough = Math.floor(roll.length / 2) + 1;
  const own = roll.map((did) => votes.get(did)).filter((v): v is CastVote => !!v && v.via === null);
  for (const choice of ['for', 'against', 'abstain'] as const) {
    const these = own.filter((v) => v.choice === choice);
    if (these.length >= enough) return { choice, votes: these.slice(0, enough).map((v) => v.version) };
  }
  return null;
}

// ─── Following ───────────────────────────────────────────────────────

export interface DelegationEdge {
  readonly from: string;
  readonly kind: 'person' | 'party';
  readonly to: string;
  readonly topic: string;
}

/** One step a vote takes */
export type Step =
  { readonly kind: 'person'; readonly did: string } | { readonly kind: 'party'; readonly key: string };

/** Where a party stands on one proposal */
export type PartyStand = Choice | 'disputed' | null;

export type Next =
  /** Your device casts this now */
  | { readonly kind: 'cast'; readonly choice: Choice; readonly via: string }
  | {
      readonly kind: 'wait';
      /** Where it would go, after you */
      readonly path: ReadonlyArray<Step>;
      readonly how:
        | 'unset' // you trust nobody on this
        | 'waiting' // whoever you trust hasn't voted yet
        | 'loop' // the chain comes back round, so nobody on it follows anyone
        | 'stopped' // it reaches someone who isn't a voter here
        | 'disputed'; // the party you trust said two things
    };

/** Whom someone trusts on a topic: their delegation for it, else the one for everything */
function delegationFor(
  delegations: ReadonlyArray<DelegationEdge>,
  from: string,
  topic: string | null,
): DelegationEdge | null {
  const theirs = delegations.filter((d) => d.from === from);
  return (
    (topic !== null ? theirs.find((d) => d.topic === topic) : undefined) ??
    theirs.find((d) => d.topic === EVERYTHING) ??
    null
  );
}

export interface FollowInput {
  readonly me: string;
  /** The proposal's topic, by key; null when it has none */
  readonly topic: string | null;
  readonly votes: Votes;
  readonly delegations: ReadonlyArray<DelegationEdge>;
  /** Each party's stand on the proposal, by key */
  readonly parties: ReadonlyMap<string, PartyStand>;
  /** Who may be followed: the proposal's voters */
  readonly voters: ReadonlySet<string>;
}

/**
 * What your device does about a proposal you haven't voted on: cast the vote
 * of whoever you trust, once they have one, or wait, and why.
 */
export function follow({ me, topic, votes, delegations, parties, voters }: FollowInput): Next {
  const first = delegationFor(delegations, me, topic);
  if (!first) return { kind: 'wait', path: [], how: 'unset' };
  const path: Step[] = [];
  const seen = new Set([me]);
  let next: DelegationEdge | null = first;
  while (next) {
    if (next.kind === 'party') {
      path.push({ kind: 'party', key: next.to });
      const stand = parties.get(next.to) ?? null;
      if (stand === 'disputed') return { kind: 'wait', path, how: 'disputed' };
      if (stand && next === first) return { kind: 'cast', choice: stand, via: next.to };
      return { kind: 'wait', path, how: 'waiting' };
    }
    path.push({ kind: 'person', did: next.to });
    if (seen.has(next.to)) return { kind: 'wait', path, how: 'loop' };
    if (!voters.has(next.to)) return { kind: 'wait', path, how: 'stopped' };
    const theirs = votes.get(next.to);
    if (theirs && next === first) return { kind: 'cast', choice: theirs.choice, via: next.to };
    // Further along, it only shows where the vote is headed: each device casts in turn.
    if (theirs) return { kind: 'wait', path, how: 'waiting' };
    seen.add(next.to);
    next = delegationFor(delegations, next.to, topic);
  }
  return { kind: 'wait', path, how: 'waiting' };
}

/** The path a cast vote took, read from the `via` of each vote along it */
export function trail(did: string, votes: Votes): ReadonlyArray<Step> {
  const path: Step[] = [];
  const seen = new Set([did]);
  let via = votes.get(did)?.via ?? null;
  while (via) {
    if (!via.startsWith('did:')) {
      path.push({ kind: 'party', key: via });
      break;
    }
    path.push({ kind: 'person', did: via });
    if (seen.has(via)) break;
    seen.add(via);
    via = votes.get(via)?.via ?? null;
  }
  return path;
}

/**
 * How many voters' devices would cast a vote now, by following, once they
 * are online: the count that's coming, not yet cast.
 */
export function pending(input: Omit<FollowInput, 'me'>): Tally {
  const coming = { for: 0, against: 0, abstain: 0, uncast: 0 };
  for (const did of input.voters) {
    if (input.votes.has(did)) continue;
    const next = follow({ ...input, me: did });
    if (next.kind === 'cast') coming[next.choice]++;
    else coming.uncast++;
  }
  return coming;
}
