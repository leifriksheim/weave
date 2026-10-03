/**
 * How a proposal is settled, and how a vote travels. Pure functions over the
 * records, so every device reaches the same answer from the same votes.
 *
 * Every rule here only grows: once true, no vote arriving later makes it
 * false. That is what lets devices agree without anyone closing the vote.
 *
 * - **Who votes** is fixed by the proposal: its voters, N of them, and how
 *   many must vote for it to pass, K (more than half unless it says).
 * - **Votes are final.** Each voter casts one, themselves or by their device
 *   following someone they trust (`via`).
 * - **Passed** once K voted for. **Rejected** once more than N − K voted
 *   against or abstained, so K can no longer be reached. Until then it is
 *   open, however long that takes.
 * - **Disputed** once someone is caught saying two things about it (a
 *   conflict). That sits above passed and rejected: it never goes back.
 *
 * Following: when you haven't voted, your device looks up whom you trust on
 * the proposal's topic (else on everything). Once that person has voted, or
 * that party has taken a position, it casts the same vote for you. Along a
 * chain this happens one device at a time; a loop never casts anything.
 */
import { EVERYTHING, type Choice, type PartyRule } from './schema';

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

/** More than half of `voters`: what a proposal needs when it doesn't say */
export const majority = (voters: number) => Math.floor(voters / 2) + 1;

/** How many of `n` voters, or of a party's members, each share needs; every one is more than half */
export const PARTY_SHARE: Readonly<Record<Exclude<PartyRule, 'representative'>, (n: number) => number>> = {
  majority,
  'two-thirds': (n) => Math.ceil((n * 2) / 3),
  'three-quarters': (n) => Math.ceil((n * 3) / 4),
  everyone: (n) => n,
};

/** Rules to pick from when proposing: how many of `n` voters must vote for */
export const RULES = [
  { id: 'majority', label: 'More than half', toPass: PARTY_SHARE.majority },
  { id: 'two-thirds', label: 'Two-thirds', toPass: PARTY_SHARE['two-thirds'] },
  { id: 'three-quarters', label: 'Three-quarters', toPass: PARTY_SHARE['three-quarters'] },
  { id: 'everyone', label: 'Everyone', toPass: PARTY_SHARE.everyone },
] as const;
export type RuleId = (typeof RULES)[number]['id'];

/** A proposal's rule in words: the first preset that needs as many, or null */
export function ruleName(toPass: number, voters: number): string | null {
  return RULES.find((r) => r.toPass(voters) === toPass)?.label ?? null;
}

/** Whether the count settles it: `toPass` for, or so many not for that `toPass` can't be reached */
export function settled(t: Tally, toPass: number): Outcome | null {
  const n = voterCount(t);
  if (n === 0) return null;
  if (t.for >= toPass) return 'passed';
  if (t.against + t.abstain > n - toPass) return 'rejected';
  return null;
}

/** How many more votes for it needs to pass, and how many not for to fail */
export function needed(t: Tally, toPass: number): { readonly toPass: number; readonly toFail: number } {
  const n = voterCount(t);
  return {
    toPass: Math.max(0, toPass - t.for),
    toFail: Math.max(0, n - toPass + 1 - t.against - t.abstain),
  };
}

/**
 * The votes a decision cites: just enough for its outcome, picked in a fixed
 * order so two devices make the same proof. Null when the count doesn't
 * settle it that way.
 */
export function proof(
  voters: ReadonlyArray<string>,
  votes: Votes,
  outcome: Outcome,
  toPass: number,
): string[] | null {
  const n = new Set(voters).size;
  const enough = outcome === 'passed' ? toPass : n - toPass + 1;
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

/** How a party decides on one proposal, as its roll froze it */
export type PartyDecides =
  | { readonly toTake: number; readonly representative?: undefined }
  | { readonly representative: string; readonly toTake?: undefined };

/** What a roll freezes for a party with this rule and these members */
export function partyDecides(
  rule: PartyRule,
  representative: string | null,
  members: ReadonlyArray<string>,
): PartyDecides | null {
  if (rule !== 'representative') return { toTake: PARTY_SHARE[rule](new Set(members).size) };
  return representative && members.includes(representative) ? { representative } : null;
}

/**
 * A party's position: the choice its representative voted, or the one
 * enough of its frozen members voted themselves, with the votes that prove
 * it. Votes cast by following don't count, so a party never counts its own
 * followers.
 */
export function partyPosition(
  members: ReadonlyArray<string>,
  votes: Votes,
  decides: PartyDecides,
): { readonly choice: Choice; readonly votes: string[] } | null {
  if (decides.representative !== undefined) {
    const theirs = members.includes(decides.representative) ? votes.get(decides.representative) : undefined;
    return theirs && theirs.via === null ? { choice: theirs.choice, votes: [theirs.version] } : null;
  }
  const roll = [...new Set(members)].sort();
  const enough = decides.toTake;
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
