/**
 * How a vote travels. Every device runs this over the same records and gets
 * the same count; nobody is trusted to add up.
 *
 * For each member of the assembly, on one proposal:
 *
 * 1. Their own vote, if they cast one. It always wins.
 * 2. Otherwise their delegation for the proposal's topic, else their
 *    delegation for everything.
 * 3. A delegation to a person follows that person the same way, as far as it
 *    goes. One that comes back round to someone already on the path, or ends
 *    with someone who neither voted nor delegated, casts nothing.
 * 4. A delegation to a party takes the party's vote: what most of its members
 *    voted themselves. A tie, or no member voting, casts nothing. A party
 *    never passes a vote on further.
 *
 * Only people who hold a role in the space count, as voters and as
 * delegates.
 */
import { EVERYTHING, type Choice, type Tally } from './schema';

export interface DelegationEdge {
  readonly from: string;
  readonly kind: 'person' | 'party';
  readonly to: string;
  readonly topic: string;
}

export interface PartyView {
  readonly key: string;
  readonly name: string;
  /** Who is in it: on the founder's list and asked to join, or the founder */
  readonly members: ReadonlySet<string>;
}

/** One step a vote took */
export type Step =
  { readonly kind: 'person'; readonly did: string } | { readonly kind: 'party'; readonly key: string };

export interface Outcome {
  readonly choice: Choice | null;
  /** Where it went, starting after the member themselves; empty for their own vote */
  readonly path: ReadonlyArray<Step>;
  readonly how:
    | 'own' // voted themselves
    | 'followed' // a delegation reached someone who voted, or a party that decided
    | 'unset' // no vote and no delegation
    | 'loop' // the delegations come back round
    | 'stopped' // someone on the way neither voted nor delegated, or left
    | 'undecided'; // the party's members are tied, or none voted
}

export interface Count {
  readonly totals: Tally;
  /** Each member's vote, and how it got there */
  readonly outcomes: ReadonlyMap<string, Outcome>;
  /** How many members' votes each person or party cast, their own included: by DID or party key */
  readonly carried: ReadonlyMap<string, number>;
  /** How each party voted, when it did */
  readonly parties: ReadonlyMap<string, Choice | null>;
}

export interface CountInput {
  readonly members: ReadonlyArray<string>;
  /** The proposal's topic, by key; null when it has none */
  readonly topic: string | null;
  /** Votes cast on the proposal, by DID */
  readonly votes: ReadonlyMap<string, Choice>;
  readonly delegations: ReadonlyArray<DelegationEdge>;
  readonly parties: ReadonlyArray<PartyView>;
}

/** Who someone's vote goes to on a topic: the topic's delegation, else the one for everything */
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

/** What most members who voted themselves chose, or null on a tie or no votes */
function majority(votes: ReadonlyArray<Choice>): Choice | null {
  const counts = new Map<Choice, number>();
  for (const choice of votes) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || (second && second[1] === first[1])) return null;
  return first[0];
}

export function count({ members, topic, votes, delegations, parties }: CountInput): Count {
  const inAssembly = new Set(members);
  const partyVotes = new Map<string, Choice | null>();
  for (const party of parties) {
    const cast = [...party.members]
      .filter((did) => inAssembly.has(did))
      .map((did) => votes.get(did))
      .filter((choice) => choice !== undefined);
    partyVotes.set(party.key, majority(cast));
  }

  const resolve = (did: string): Outcome => {
    const own = votes.get(did);
    if (own) return { choice: own, path: [], how: 'own' };
    const path: Step[] = [];
    const seen = new Set([did]);
    let at = did;
    for (;;) {
      const next = delegationFor(delegations, at, topic);
      if (!next) return { choice: null, path, how: at === did ? 'unset' : 'stopped' };
      if (next.kind === 'party') {
        path.push({ kind: 'party', key: next.to });
        if (!partyVotes.has(next.to)) return { choice: null, path, how: 'stopped' };
        const choice = partyVotes.get(next.to) ?? null;
        return { choice, path, how: choice ? 'followed' : 'undecided' };
      }
      path.push({ kind: 'person', did: next.to });
      if (seen.has(next.to)) return { choice: null, path, how: 'loop' };
      if (!inAssembly.has(next.to)) return { choice: null, path, how: 'stopped' };
      const theirs = votes.get(next.to);
      if (theirs) return { choice: theirs, path, how: 'followed' };
      seen.add(next.to);
      at = next.to;
    }
  };

  const outcomes = new Map<string, Outcome>();
  const carried = new Map<string, number>();
  const totals = { for: 0, against: 0, abstain: 0, uncast: 0 };
  for (const did of inAssembly) {
    const outcome = resolve(did);
    outcomes.set(did, outcome);
    if (!outcome.choice) {
      totals.uncast++;
      continue;
    }
    totals[outcome.choice]++;
    const last = outcome.path.at(-1);
    const by = !last ? did : last.kind === 'person' ? last.did : last.key;
    carried.set(by, (carried.get(by) ?? 0) + 1);
  }
  return { totals, outcomes, carried, parties: partyVotes };
}

/** Accepted when more votes are for than against; abstaining counts toward turnout only */
export const accepted = (tally: Tally): boolean => tally.for > tally.against;

/** The share of members whose vote was cast, one way or another, 0 to 1 */
export const turnout = (tally: Tally): number => {
  const all = tally.for + tally.against + tally.abstain + tally.uncast;
  return all ? (all - tally.uncast) / all : 0;
};
