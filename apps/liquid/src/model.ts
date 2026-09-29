/**
 * An assembly, read whole: its topics, proposals, votes, delegations and
 * parties, kept live as records sync in. Every screen reads from this, so
 * they all agree, and the count (`tally.ts`) runs on what they show.
 */
import { useMemo } from 'react';
import { useAccess, useAccount, useCan, useNames, useQuery } from '@weaveprotocol/core/react';
import type { SpaceRole } from '@weaveprotocol/core';
import {
  delegation,
  membership,
  party,
  proposal,
  support,
  topic,
  vote,
  type Choice,
  type Tally,
} from './schema';
import { count, type Count, type DelegationEdge, type PartyView } from './tally';

export interface TopicView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly hue: number;
}

export interface ProposalView {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly topic: string | null;
  readonly closed: boolean;
  /** The count the closer's device made, when closed */
  readonly result: Tally | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly supporters: ReadonlySet<string>;
  /** Votes cast on it by members, by DID */
  readonly votes: ReadonlyMap<string, Choice>;
  /** Your own vote record's key, to take it back */
  readonly myVoteKey: string | null;
  readonly mySupportKey: string | null;
}

export interface PartyFull extends PartyView {
  readonly platform: string;
  readonly hue: number;
  readonly founder: string | null;
  /** On the founder's list */
  readonly listed: ReadonlySet<string>;
  /** Asked to join, by DID, with the record's key */
  readonly asked: ReadonlyMap<string, string>;
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
  /** The count for a proposal, run on what this device holds now */
  readonly countOf: (proposal: ProposalView) => Count;
  /** False until the first records are read */
  readonly ready: boolean;
}

/** A hue from a key, for a topic or party that didn't pick one */
function hueOf(key: string): number {
  let value = 0;
  for (let i = 0; i < key.length; i++) value = (value * 31 + key.charCodeAt(i)) % 360;
  return value;
}

export function useAssembly(spaceId: string): Assembly {
  const { did: me } = useAccount();
  const name = useNames(spaceId);
  const access = useAccess(spaceId);
  const mayModerate = useCan(spaceId, 'create', topic.name);

  const topics = useQuery(spaceId, { collection: topic, sort: { '@createdAt': 'asc' } }).result;
  const proposals = useQuery(spaceId, { collection: proposal, sort: { '@createdAt': 'desc' } }).result;
  const supports = useQuery(spaceId, { collection: support }).result;
  const votes = useQuery(spaceId, { collection: vote }).result;
  const delegations = useQuery(spaceId, { collection: delegation }).result;
  const parties = useQuery(spaceId, { collection: party, sort: { '@createdAt': 'asc' } }).result;
  const memberships = useQuery(spaceId, { collection: membership }).result;

  return useMemo(() => {
    const members = access?.members ?? [];
    const inAssembly = new Set(members.map((m) => m.did));
    /** Written by a member, under their own account */
    const byMember = <R extends { readonly root: string | null }>(r: R): r is R & { root: string } =>
      r.root !== null && inAssembly.has(r.root);
    const aboutOf = (r: { readonly links: ReadonlyArray<{ rel: string; to: string }> }, rel = 'about') =>
      r.links.find((l) => l.rel === rel)?.to ?? null;

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
      const about = aboutOf(r);
      if (!about || !byMember(r)) continue;
      supportersOf.set(about, (supportersOf.get(about) ?? new Set()).add(r.root));
      if (r.root === me) mySupport.set(about, r.key);
    }

    const votesOf = new Map<string, Map<string, Choice>>();
    const myVote = new Map<string, string>();
    for (const r of votes?.records ?? []) {
      const about = aboutOf(r);
      if (!about || !byMember(r)) continue;
      const these = votesOf.get(about) ?? new Map<string, Choice>();
      these.set(r.root, r.body.choice);
      votesOf.set(about, these);
      if (r.root === me) myVote.set(about, r.key);
    }

    const proposalViews: ProposalView[] = (proposals?.records ?? []).map((r) => {
      const linked = aboutOf(r, 'topic');
      return {
        key: r.key,
        title: r.body.title,
        body: r.body.body ?? '',
        topic: linked && topicByKey.has(linked) ? linked : null,
        closed: r.body.closed === true,
        result: r.body.result ?? null,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        supporters: supportersOf.get(r.key) ?? new Set(),
        votes: votesOf.get(r.key) ?? new Map(),
        myVoteKey: myVote.get(r.key) ?? null,
        mySupportKey: mySupport.get(r.key) ?? null,
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
      const about = aboutOf(r);
      if (!about || !byMember(r)) continue;
      askedOf.set(about, (askedOf.get(about) ?? new Map<string, string>()).set(r.root, r.key));
    }
    const partyViews: PartyFull[] = (parties?.records ?? []).map((r) => {
      const listed = new Set(r.body.members ?? []);
      const asked = askedOf.get(r.key) ?? new Map<string, string>();
      const founder = r.createdBy;
      const inParty = new Set([...asked.keys()].filter((did) => listed.has(did) || did === founder));
      if (founder && inAssembly.has(founder)) inParty.add(founder);
      return {
        key: r.key,
        name: r.body.name,
        platform: r.body.platform ?? '',
        hue: r.body.hue ?? hueOf(r.key),
        founder,
        listed,
        asked,
        members: inParty,
      };
    });
    const partyByKey = new Map(partyViews.map((p) => [p.key, p]));

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
      countOf: (p) =>
        count({
          members: members.map((m) => m.did),
          topic: p.topic,
          votes: p.votes,
          delegations: edges,
          parties: partyViews,
        }),
      ready: access !== undefined && proposals !== null && topics !== null,
    };
  }, [
    spaceId,
    me,
    name,
    access,
    mayModerate,
    topics,
    proposals,
    supports,
    votes,
    delegations,
    parties,
    memberships,
  ]);
}
