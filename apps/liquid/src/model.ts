/**
 * An assembly, read whole: its topics, proposals, votes, delegations and
 * parties, kept live as records sync in. Every screen reads from this, so
 * they all agree, and the count (`tally.ts`) runs on what they show.
 */
import { useMemo } from 'react';
import { useAccess, useAccount, useCan, useCollections, useNames, useQuery } from '@weaveprotocol/core/react';
import type { SpaceRole } from '@weaveprotocol/core';
import {
  conflict,
  decision,
  delegation,
  membership,
  party,
  partyBallot,
  partyRoll,
  proposal,
  support,
  topic,
  vote,
} from './schema';
import {
  follow,
  pending,
  resultOf,
  tally,
  type CastVote,
  type DelegationEdge,
  type Next,
  type Outcome,
  type PartyStand,
  type Result,
  type Tally,
} from './tally';

export interface TopicView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly hue: number;
}

/** A party's roll for one proposal: its members, frozen */
export interface RollView {
  readonly key: string;
  readonly version: string;
  readonly members: ReadonlyArray<string>;
}

export interface ProposalView {
  readonly key: string;
  /** The id of the version shown, which a decision cites: any version lists the same voters */
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly topic: string | null;
  /** Who votes on it; empty for one made before proposals listed their voters */
  readonly voters: ReadonlyArray<string>;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly supporters: ReadonlySet<string>;
  /** Votes cast on it, by voter DID */
  readonly votes: ReadonlyMap<string, CastVote>;
  readonly mySupportKey: string | null;
  /** What a decision record says it came to, when one is here */
  readonly decided: Outcome | null;
  /** Records caught saying two things about it: a voter's vote, or a party's roll */
  readonly conflicts: ReadonlyArray<{
    readonly record: string;
    readonly voter: string | null;
    readonly party: string | null;
  }>;
  readonly result: Result;
  /** Each party's roll for it, by party key */
  readonly rolls: ReadonlyMap<string, RollView>;
  /** Each party's stand on it, by party key */
  readonly stands: ReadonlyMap<string, PartyStand>;
}

export interface PartyFull {
  readonly key: string;
  readonly version: string;
  readonly name: string;
  readonly platform: string;
  readonly hue: number;
  readonly stewards: ReadonlySet<string>;
  /** On the stewards' list */
  readonly listed: ReadonlySet<string>;
  /** Asked to join, by DID, with the record's key */
  readonly asked: ReadonlyMap<string, string>;
  /** Who is in it: on the list and asked to join, or a steward */
  readonly members: ReadonlySet<string>;
}

export interface MyDelegation extends DelegationEdge {
  readonly key: string;
}

export interface Assembly {
  readonly spaceId: string;
  readonly me: string;
  readonly name: (did: string | null | undefined) => string;
  readonly members: ReadonlyArray<{ readonly did: string; readonly role: string }>;
  readonly roles: ReadonlyArray<SpaceRole>;
  readonly myRole: SpaceRole | null;
  readonly mayModerate: boolean;
  readonly mayInvite: boolean;
  readonly topics: ReadonlyArray<TopicView>;
  readonly topicOf: (key: string | null) => TopicView | null;
  readonly proposals: ReadonlyArray<ProposalView>;
  readonly delegations: ReadonlyArray<DelegationEdge>;
  readonly mine: ReadonlyArray<MyDelegation>;
  readonly parties: ReadonlyArray<PartyFull>;
  readonly partyOf: (key: string) => PartyFull | null;
  /** The count among a proposal's voters, as cast */
  readonly countOf: (proposal: ProposalView) => Tally;
  /** The votes devices would cast by following, once they are online */
  readonly comingOf: (proposal: ProposalView) => Tally;
  /** What your own device does about a proposal you haven't voted on */
  readonly nextFor: (proposal: ProposalView, did?: string) => Next;
  /** Whether the space holds the collections this Liquid needs: false for one made by an older Liquid */
  readonly current: boolean;
  /** False until the first records are read */
  readonly ready: boolean;
}

/** A hue from a key, for a topic or party that didn't pick one */
function hueOf(key: string): number {
  let value = 0;
  for (let i = 0; i < key.length; i++) value = (value * 31 + key.charCodeAt(i)) % 360;
  return value;
}

const linkOf = (r: { readonly links: ReadonlyArray<{ rel: string; to: string }> }, rel = 'about') =>
  r.links.find((l) => l.rel === rel)?.to ?? null;

export function useAssembly(spaceId: string): Assembly {
  const { did: me } = useAccount();
  const name = useNames(spaceId);
  const access = useAccess(spaceId);
  const mayModerate = useCan(spaceId, 'create', topic.name);
  const collections = useCollections(spaceId);

  const topics = useQuery(spaceId, { collection: topic, sort: { '@createdAt': 'asc' } }).result;
  const proposals = useQuery(spaceId, { collection: proposal, sort: { '@createdAt': 'desc' } }).result;
  const supports = useQuery(spaceId, { collection: support }).result;
  const votes = useQuery(spaceId, { collection: vote }).result;
  const delegations = useQuery(spaceId, { collection: delegation }).result;
  const decisions = useQuery(spaceId, { collection: decision }).result;
  const conflicts = useQuery(spaceId, { collection: conflict }).result;
  const parties = useQuery(spaceId, { collection: party, sort: { '@createdAt': 'asc' } }).result;
  const memberships = useQuery(spaceId, { collection: membership }).result;
  const rolls = useQuery(spaceId, { collection: partyRoll }).result;
  const ballots = useQuery(spaceId, { collection: partyBallot }).result;

  return useMemo(() => {
    const members = access?.members ?? [];
    const inAssembly = new Set(members.map((m) => m.did));
    /** Written by someone, under their own account */
    const signed = <R extends { readonly root: string | null }>(r: R): r is R & { root: string } =>
      r.root !== null;
    const byMember = <R extends { readonly root: string | null }>(r: R): r is R & { root: string } =>
      r.root !== null && inAssembly.has(r.root);

    const topicViews: TopicView[] = (topics?.records ?? []).map((r) => ({
      key: r.key,
      name: r.body.name,
      description: r.body.description ?? '',
      hue: r.body.hue ?? hueOf(r.key),
    }));
    const topicByKey = new Map(topicViews.map((t) => [t.key, t]));

    const supportersOf = new Map<string, Set<string>>();
    const mySupport = new Map<string, string>();
    for (const r of supports?.records ?? []) {
      const about = linkOf(r);
      if (!about || !byMember(r)) continue;
      supportersOf.set(about, (supportersOf.get(about) ?? new Set()).add(r.root));
      if (r.root === me) mySupport.set(about, r.key);
    }

    // Votes count whoever cast them: a voter who left still voted. The
    // proposal's voter list decides whose count.
    const votesOf = new Map<string, Map<string, CastVote>>();
    const voteOwner = new Map<string, string>();
    for (const r of votes?.records ?? []) {
      const about = linkOf(r);
      if (!about || !signed(r) || r.seq !== 0) continue;
      const these = votesOf.get(about) ?? new Map<string, CastVote>();
      these.set(r.root, { choice: r.body.choice, via: r.body.via ?? null, version: r.version, key: r.key });
      votesOf.set(about, these);
      voteOwner.set(r.key, r.root);
    }

    const decidedOf = new Map<string, Outcome>();
    for (const r of decisions?.records ?? []) {
      const about = linkOf(r);
      if (about) decidedOf.set(about, r.body.outcome);
    }
    const conflictsOf = new Map<string, string[]>();
    for (const r of conflicts?.records ?? []) {
      const about = linkOf(r);
      if (about) conflictsOf.set(about, [...(conflictsOf.get(about) ?? []), r.body.record]);
    }

    const rollsOf = new Map<string, Map<string, RollView>>();
    for (const r of rolls?.records ?? []) {
      const about = linkOf(r);
      const of = linkOf(r, 'party');
      if (!about || !of) continue;
      const these = rollsOf.get(about) ?? new Map<string, RollView>();
      these.set(of, { key: r.key, version: r.version, members: r.body.members });
      rollsOf.set(about, these);
    }
    const ballotsOf = new Map<string, Map<string, PartyStand>>();
    for (const r of ballots?.records ?? []) {
      const about = linkOf(r);
      const of = linkOf(r, 'party');
      if (!about || !of) continue;
      ballotsOf.set(about, (ballotsOf.get(about) ?? new Map<string, PartyStand>()).set(of, r.body.choice));
    }

    const proposalViews: ProposalView[] = (proposals?.records ?? []).map((r) => {
      const linked = linkOf(r, 'topic');
      const proposalVotes = votesOf.get(r.key) ?? new Map<string, CastVote>();
      const found = conflictsOf.get(r.key) ?? [];
      const rollsHere = rollsOf.get(r.key) ?? new Map<string, RollView>();
      // Who said two things: the voter whose vote it is, or the party whose roll it is.
      const named = found.map((record) => ({
        record,
        voter: voteOwner.get(record) ?? null,
        party: [...rollsHere].find(([, roll]) => roll.key === record)?.[0] ?? null,
      }));
      const disputedRolls = new Set(named.flatMap((c) => (c.party ? [c.party] : [])));
      const stands = new Map<string, PartyStand>(ballotsOf.get(r.key) ?? []);
      for (const of of disputedRolls) stands.set(of, 'disputed');
      const decided = decidedOf.get(r.key) ?? null;
      return {
        key: r.key,
        version: r.version,
        title: r.body.title,
        body: r.body.body ?? '',
        topic: linked && topicByKey.has(linked) ? linked : null,
        voters: Array.isArray(r.body.voters) ? r.body.voters : [],
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        supporters: supportersOf.get(r.key) ?? new Set(),
        votes: proposalVotes,
        mySupportKey: mySupport.get(r.key) ?? null,
        decided,
        conflicts: named,
        result: resultOf(decided, found.length > 0),
        rolls: rollsHere,
        stands,
      };
    });

    const edges: DelegationEdge[] = [];
    const mine: MyDelegation[] = [];
    for (const r of delegations?.records ?? []) {
      if (!byMember(r)) continue;
      const edge = { from: r.root, kind: r.body.kind, to: r.body.to, topic: r.body.topic };
      edges.push(edge);
      if (r.root === me) mine.push({ ...edge, key: r.key });
    }

    const askedOf = new Map<string, Map<string, string>>();
    for (const r of memberships?.records ?? []) {
      const about = linkOf(r);
      if (!about || !byMember(r)) continue;
      askedOf.set(about, (askedOf.get(about) ?? new Map<string, string>()).set(r.root, r.key));
    }
    const partyViews: PartyFull[] = (parties?.records ?? []).map((r) => {
      const listed = new Set(r.body.members ?? []);
      const stewards = new Set(r.body.stewards ?? (r.createdBy ? [r.createdBy] : []));
      const asked = askedOf.get(r.key) ?? new Map<string, string>();
      const inParty = new Set(
        [...listed].filter((did) => inAssembly.has(did) && (asked.has(did) || stewards.has(did))),
      );
      return {
        key: r.key,
        version: r.version,
        name: r.body.name,
        platform: r.body.platform ?? '',
        hue: r.body.hue ?? hueOf(r.key),
        stewards,
        listed,
        asked,
        members: inParty,
      };
    });
    const partyByKey = new Map(partyViews.map((p) => [p.key, p]));

    const followInput = (p: ProposalView) => ({
      topic: p.topic,
      votes: p.votes,
      delegations: edges,
      parties: p.stands,
      voters: new Set(p.voters),
    });

    return {
      spaceId,
      me,
      name,
      members,
      roles: access?.roles ?? [],
      myRole: access?.role ?? null,
      mayModerate,
      mayInvite: access?.role?.permissions.some((p) => p === '*' || p === 'invite') ?? false,
      topics: topicViews,
      topicOf: (key) => (key ? (topicByKey.get(key) ?? null) : null),
      proposals: proposalViews,
      delegations: edges,
      mine,
      parties: partyViews,
      partyOf: (key) => partyByKey.get(key) ?? null,
      countOf: (p) => tally(p.voters, p.votes),
      comingOf: (p) => pending(followInput(p)),
      nextFor: (p, did = me) => follow({ ...followInput(p), me: did }),
      current: collections.some((c) => c.name === vote.name && c.rules.final === true),
      ready: access !== undefined && proposals !== null && topics !== null,
    };
  }, [
    spaceId,
    me,
    name,
    access,
    mayModerate,
    collections,
    topics,
    proposals,
    supports,
    votes,
    delegations,
    decisions,
    conflicts,
    parties,
    memberships,
    rolls,
    ballots,
  ]);
}
