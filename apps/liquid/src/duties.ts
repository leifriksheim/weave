/**
 * What this device does by itself, while Liquid is open: nobody has to close
 * a vote or add it up, so whichever device sees something first writes it.
 *
 * - **Follow.** You haven't voted, and whoever you trust on the topic has:
 *   cast the same vote, signed by you, saying whom it followed (`via`).
 * - **Freeze a party's members** for a new proposal, if you are one of its
 *   stewards.
 * - **Write a party's position** once more than half of its frozen members
 *   voted one way themselves.
 * - **Write the decision** once the count settles the proposal.
 * - **Write a conflict** on finding two different first versions of one
 *   vote or one party roll.
 *
 * Every one of these is final and one per thing, so two devices doing the
 * same at once is harmless: both versions stand, and every device picks the
 * same one (02 §4.3).
 */
import { useEffect, useRef } from 'react';
import { useNode } from '@weaveprotocol/core/react';
import type { P2PNode } from '@weaveprotocol/core';
import type { Assembly, PartyFull, ProposalView, RollView } from './model';
import { conflict, decision, partyBallot, partyRoll, vote, type Choice } from './schema';
import { partyPosition, proof, settled, type Outcome } from './tally';

export type Duty =
  | { readonly kind: 'vote'; readonly proposal: string; readonly choice: Choice; readonly via: string }
  | { readonly kind: 'roll'; readonly proposal: string; readonly party: PartyFull }
  | {
      readonly kind: 'ballot';
      readonly proposal: string;
      readonly party: string;
      readonly roll: RollView;
      readonly choice: Choice;
      readonly votes: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'decision';
      readonly proposal: ProposalView;
      readonly outcome: Outcome;
      readonly votes: ReadonlyArray<string>;
    };

/** Everything this device should write now, in the order to write it */
export function duties(a: Assembly): Duty[] {
  const todo: Duty[] = [];
  for (const p of a.proposals) {
    // Made by an older Liquid, without voters; or settled, or disputed: nothing more to do.
    if (p.voters.length === 0 || p.result !== 'open') continue;

    if (p.voters.includes(a.me) && !p.votes.has(a.me)) {
      const next = a.nextFor(p);
      if (next.kind === 'cast')
        todo.push({ kind: 'vote', proposal: p.key, choice: next.choice, via: next.via });
    }

    for (const party of a.parties) {
      if (!party.stewards.has(a.me) || p.rolls.has(party.key) || party.members.size === 0) continue;
      todo.push({ kind: 'roll', proposal: p.key, party });
    }

    for (const [party, roll] of p.rolls) {
      if (p.stands.get(party)) continue;
      const position = partyPosition(roll.members, p.votes);
      if (position) todo.push({ kind: 'ballot', proposal: p.key, party, roll, ...position });
    }

    const outcome = settled(a.countOf(p));
    const votes = outcome ? proof(p.voters, p.votes, outcome) : null;
    if (outcome && votes) todo.push({ kind: 'decision', proposal: p, outcome, votes });
  }
  return todo;
}

/** Writes one duty */
async function perform(node: P2PNode, a: Assembly, duty: Duty): Promise<void> {
  const about = (proposal: string) => ({ rel: 'about', to: proposal });
  switch (duty.kind) {
    case 'vote':
      await node.records.put(
        a.spaceId,
        vote,
        { choice: duty.choice, via: duty.via },
        { links: [about(duty.proposal)] },
      );
      return;
    case 'roll':
      await node.records.put(
        a.spaceId,
        partyRoll,
        { party: duty.party.version, members: [...duty.party.members].sort() },
        { links: [{ rel: 'party', to: duty.party.key }, about(duty.proposal)] },
      );
      return;
    case 'ballot':
      await node.records.put(
        a.spaceId,
        partyBallot,
        { choice: duty.choice, roll: duty.roll.version, members: duty.roll.members, votes: duty.votes },
        { links: [{ rel: 'party', to: duty.party }, about(duty.proposal)] },
      );
      return;
    case 'decision':
      await node.records.put(
        a.spaceId,
        decision,
        {
          outcome: duty.outcome,
          proposal: duty.proposal.version,
          voters: duty.proposal.voters,
          votes: duty.votes,
        },
        { links: [about(duty.proposal.key)] },
      );
  }
}

/**
 * Two first versions of one vote or roll that say different things, found
 * in what this device holds. Only first versions count: all these records
 * are final.
 */
async function findConflicts(
  node: P2PNode,
  a: Assembly,
): Promise<ReadonlyArray<{ proposal: string; record: string; versions: [string, string] }>> {
  const found: Array<{ proposal: string; record: string; versions: [string, string] }> = [];
  const disputed = new Set(a.proposals.flatMap((p) => p.conflicts.map((c) => c.record)));
  for (const p of a.proposals) {
    if (p.voters.length === 0) continue;
    const keys = [...[...p.votes.values()].map((v) => v.key), ...[...p.rolls.values()].map((r) => r.key)];
    for (const key of keys) {
      if (disputed.has(key)) continue;
      const firsts = (
        await node.records.history<{ choice?: string; members?: unknown }>(a.spaceId, key)
      ).filter((v) => v.seq === 0 && v.body);
      const [one, ...rest] = firsts;
      const other = rest.find(
        (v) =>
          v.body?.choice !== one?.body?.choice ||
          JSON.stringify(v.body?.members ?? null) !== JSON.stringify(one?.body?.members ?? null),
      );
      if (one && other) found.push({ proposal: p.key, record: key, versions: [one.version, other.version] });
    }
  }
  return found;
}

/** How often to look through vote histories for conflicts: reading every vote's history isn't free */
const CONFLICT_SCAN_MS = 30_000;

/**
 * Runs this device's duties whenever the assembly changes, one write at a
 * time. A write that fails (another device was first, or this one may not)
 * is left: the next change tries again from what is here then.
 */
export function useDuties(a: Assembly, writable: boolean): void {
  const node = useNode();
  const running = useRef(false);
  const again = useRef(false);
  const lastScan = useRef(0);
  const latest = useRef(a);
  latest.current = a;

  useEffect(() => {
    if (!writable || !a.ready || !a.current) return;
    const run = async () => {
      if (running.current) {
        again.current = true;
        return;
      }
      running.current = true;
      try {
        do {
          again.current = false;
          const now = latest.current;
          for (const duty of duties(now)) await perform(node, now, duty).catch(() => {});
          if (Date.now() - lastScan.current > CONFLICT_SCAN_MS) {
            lastScan.current = Date.now();
            for (const found of await findConflicts(node, now).catch(() => [])) {
              await node.records
                .put(
                  now.spaceId,
                  conflict,
                  { record: found.record, versions: found.versions },
                  { links: [{ rel: 'about', to: found.proposal }] },
                )
                .catch(() => {});
            }
          }
        } while (again.current);
      } finally {
        running.current = false;
      }
    };
    const timer = setTimeout(() => void run(), 400);
    return () => clearTimeout(timer);
  }, [node, a, writable]);
}
