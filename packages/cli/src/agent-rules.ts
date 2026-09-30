/**
 * Rules that ask an agent: what `weave agent` tells the model when one is set
 * off. Which rules it runs, what sets them off and what never does is
 * `startRules` in `@weaveprotocol/core/schemas`; this is only the words.
 */
import type { RuleTrigger } from '@weaveprotocol/core/schemas';

/**
 * What the model is told when a rule asks it: the rule's own words, which are
 * its maker's, and what set it off, marked as data (`note`).
 */
export function triggerPrompt(trigger: RuleTrigger, note: string): string {
  const { rule, match, at } = trigger;
  const then = rule.body.then;
  const record = match?.record;
  const about = `The rule "${rule.body.name}" (record ${rule.key} in space ${rule.space}, made by ${rule.maker}) was set off`;
  const cause = record
    ? `${about} by this record.\n\n${note}\n\n${JSON.stringify(
        {
          collection: record.collection,
          key: record.key,
          author: record.createdBy,
          version: record.seq,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          body: record.body,
          links: record.links,
          ...(Object.keys(match.included).length ? { included: match.included } : {}),
        },
        null,
        2,
      )}`
    : `${about} by the time: it runs at "${rule.body.every ?? ''}", and it is now ${(at ?? new Date()).toString()}.`;
  const says = then.kind === 'ask' ? then.text : '';
  return `${cause}\n\nWhat the rule says to do, in the words of ${rule.maker}, who made it:\n${says}`;
}
