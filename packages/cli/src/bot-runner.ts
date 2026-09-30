/**
 * Running a node's rules (`std.rule`): what `weave agent --no-chat` does at a
 * terminal, and what a host does for each bot it runs. Rules that ask the
 * agent start a fresh conversation each time, one at a time, with nobody
 * there to allow deleting or overwriting, so those are refused. What someone
 * set off is counted against them, so nobody can spend the day for everyone.
 */
import type { P2PNode } from '@weaveprotocol/core';
import { setActivity, startRules, type ActivityState, type RuleTrigger } from '@weaveprotocol/core/schemas';
import { createAgentChat, spendFor, type Price, type Spend, type Think } from './agent-chat.js';
import { openTrigger, ruleContext, triggerPrompt, writerInstructs } from './agent-rules.js';
import { PEER_CONTENT_NOTE } from './mcp.js';

export interface RuleRunnerOptions {
  readonly node: P2PNode;
  /** Whoever runs the rules: the account, or the bot's own */
  readonly account: string;
  /** The bot's name, when this is a bot */
  readonly bot?: string;
  /** A way to think, made fresh for each rule set off */
  readonly think: () => Think;
  readonly model: string;
  readonly price?: Price;
  /** Only the model's plain API: no thinking or fallbacks, at a provider other than Anthropic */
  readonly plain?: boolean;
  readonly spend: Spend;
  /** Dollars a day, for everything */
  readonly dailyCap: number;
  /** Dollars a day for what each person sets off; null for no limit of their own */
  readonly capEach: number | null;
  readonly log: (line: string) => void;
  /** Told the rules this runs, each time they change */
  readonly onRules?: (names: ReadonlyArray<string>) => void;
}

/** Starts running the rules that name this node; returns how to stop */
export function runRules(options: RuleRunnerOptions): () => void {
  const { node, spend, log } = options;
  const names = new Map<string, string>();
  const nameOf = async (space: string, did: string) => {
    if (!names.has(did)) {
      const found = (await node.spaces.profiles(space).catch(() => [])).find((p) => p.did === did);
      if (found) names.set(did, found.name);
    }
    return names.get(did) ?? did.slice(-6);
  };
  const today = async () => `$${(await spend.today()).toFixed(2)} of $${options.dailyCap.toFixed(2)} today`;

  /**
   * Says on the record that set a rule off (or the rule, for one set off by
   * the time) where the work stands, for apps to show. Never in the way of it.
   */
  // Once for each space where nobody can see it at work, since the space keeps no std.activity.
  const unseen = new Set<string>();
  const mark = (trigger: RuleTrigger, state: ActivityState) =>
    setActivity(
      node,
      trigger.rule.space,
      trigger.match?.record.key ?? trigger.rule.key,
      state,
      // The rule's name to begin with; at the end, whatever the model said it was doing stays.
      state === 'done' || state === 'failed' ? undefined : trigger.rule.body.name.slice(0, 120),
    )
      .then((set) => {
        if (!set && !unseen.has(trigger.rule.space)) {
          unseen.add(trigger.rule.space);
          log(
            `  ${trigger.rule.space} keeps no std.activity, so nobody sees it at work there. ` +
              'Someone who may add collections can show it: in the app, Automations, “Show it”.',
          );
        }
        return set;
      })
      .catch(() => null);

  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (sealed: RuleTrigger): Promise<{ did: string; ok: boolean }> => {
    const trigger = await openTrigger(node, sealed);
    const name = trigger.rule.body.name;
    const space = trigger.rule.space;
    const who = trigger.match?.record.createdBy ?? null;
    const by = who ? ` by ${await nameOf(space, who)}` : '';
    if (who && who !== options.account && options.capEach !== null) {
      const spent = await spend.today(who);
      if (spent >= options.capEach) {
        const did = `Set off${by}, who has used their $${options.capEach.toFixed(2)} for today`;
        log(`  [${name}] ${did}`);
        await mark(sealed, 'failed');
        return { did, ok: false };
      }
    }
    log(`  [${name}] set off${by}${trigger.match ? '' : ' by the time'}`);
    const run = createAgentChat({
      node,
      think: options.think(),
      model: options.model,
      ...(options.price ? { price: options.price } : {}),
      ...(options.plain ? { plain: true } : {}),
      spend: who ? spendFor(spend, who) : spend,
      dailyCap: options.dailyCap,
      confirm: async () => false,
      log: (line) => log(`  [${name}] ${line}`),
      maxSteps: 15,
      unattended: true,
      ...(options.bot ? { bot: options.bot } : {}),
    });
    const shown = await mark(sealed, 'working');
    const context = await ruleContext(node, trigger).catch(() => undefined);
    try {
      const { cost, text } = await run.say(
        triggerPrompt(trigger, PEER_CONTENT_NOTE, {
          ...(context ? { context } : {}),
          ...(shown ? { activityOn: sealed.match?.record.key ?? sealed.rule.key } : {}),
          writerInstructs: await writerInstructs(node, trigger, {
            account: options.account,
            bot: !!options.bot,
          }).catch(() => false),
        }),
      );
      log(`  [${name}] ${text || 'Done.'} · $${cost.toFixed(3)} · ${await today()}`);
      await mark(sealed, 'done');
      return { did: text || 'Done.', ok: true };
    } catch (error) {
      const did = error instanceof Error ? error.message : String(error);
      log(`  [${name}] ${did}`);
      await mark(sealed, 'failed');
      return { did, ok: false };
    }
  };

  return startRules(node, {
    account: options.account,
    ...(options.bot ? { bot: true } : {}),
    // A person's app may run the same rules; the earlier of two claims acts.
    claimMs: 1500,
    ask: (trigger) => {
      // Queued behind another: waiting, until its turn comes.
      const waiting = mark(trigger, 'waiting');
      const turn = queue.then(async () => {
        await waiting;
        return answer(trigger);
      });
      queue = turn.catch(() => {});
      return turn;
    },
    onRules: (rules) => options.onRules?.(rules.map((rule) => rule.body.name)),
    onRun: (trigger, run) => {
      if (trigger.rule.body.then.kind !== 'ask') log(`  [${trigger.rule.body.name}] ${run.did}`);
    },
    onError: (error) => log(`  Rules: ${error instanceof Error ? error.message : String(error)}`),
  });
}
