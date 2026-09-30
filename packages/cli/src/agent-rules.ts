/**
 * Rules that ask an agent: what `weave agent` tells the model when one is set
 * off. Which rules it runs, what sets them off and what never does is
 * `startRules` in `@weaveprotocol/core/schemas`; this is only the words.
 */
import type { P2PNode } from '@weaveprotocol/core';
import type { RuleTrigger } from '@weaveprotocol/core/schemas';

/**
 * What the model is told when a rule asks it: the rule's own words, which are
 * its maker's, and what set it off, marked as data (`note`).
 */
export function triggerPrompt(trigger: RuleTrigger, note: string, context?: string): string {
  const { rule, match, at } = trigger;
  const then = rule.body.then;
  const record = match?.record;
  const about = `The rule "${rule.body.name}" (record ${rule.key} in space ${rule.space}, made by ${rule.maker}) was set off`;
  // Members wrote the collections' titles and descriptions too, so they go after the note, with the record.
  const looked = context
    ? `\n\nLooked up already, so there is no need to call spaces_list, collections_list or records_can for this space: what it holds, and the collections you may create records in.\n\n${context}`
    : '';
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
      )}${looked}`
    : `${about} by the time: it runs at "${rule.body.every ?? ''}", and it is now ${(at ?? new Date()).toString()}.${
        looked ? `\n\n${note}${looked}` : ''
      }`;
  const says = then.kind === 'ask' ? then.text : '';
  return `${cause}\n\nWhat the rule says to do, in the words of ${rule.maker}, who made it:\n${says}`;
}

/**
 * What a model would otherwise spend its first turns asking for, each a round
 * trip: the collections of the rule's space, and those it may create records
 * in. Read from the node itself, which costs nothing.
 */
export async function ruleContext(node: P2PNode, trigger: RuleTrigger): Promise<string> {
  const space = trigger.rule.space;
  const collections = await node.collections.list(space);
  const mayCreate = await Promise.all(
    collections.map(async (c) =>
      (await node.records.can(space, 'create', c.name).catch(() => false)) ? c.name : null,
    ),
  );
  return JSON.stringify({ collections, mayCreateIn: mayCreate.filter(Boolean) }, null, 2);
}
