/**
 * @module identity/agent-note
 * A note that says its key is an agent's.
 *
 * An agent isn't an identity of its own: it writes for a person, under a note
 * from their account, like any app. What sets it apart is one fact the account
 * signs into that note — so every peer can tell a record was written "via
 * agent", and can refuse what an agent must never do alone: change the space's
 * collections, or who may do what. Those always need a person.
 *
 * The fact is the account's word, carried in a note it signed. A note without
 * it is an ordinary app's; nothing about the key itself says "agent".
 */
import { parseUCAN, type Fact } from './ucan.js';

/** The fact an agent's note carries */
export const AGENT_FACT: Fact = Object.freeze({ weave: 'agent' });

/** Whether a note (an encoded UCAN) was made out to an agent. False for anything unreadable. */
export function isAgentNote(encoded: string | null | undefined): boolean {
  if (!encoded) return false;
  try {
    const facts = parseUCAN(encoded).payload.fct;
    return Array.isArray(facts) && facts.some((fact) => fact?.weave === AGENT_FACT.weave);
  } catch {
    return false;
  }
}
