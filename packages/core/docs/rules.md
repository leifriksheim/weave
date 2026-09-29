# Rules

"When a channel has more than 100 messages, say so in it." "When a poll has
10 votes, close it." "When someone mentions the bot, answer them." A rule
finds records with a query, keeps those a condition holds for, and does one
thing for each, once; or does it at set times.

One kind of record for all of these, whoever runs it: a person's app, their
agent, or a bot a community added.

> Not protocol. A peer that has never heard of rules syncs, stores and judges
> `std.rule` and `std.rule-run` like any other record. These are not the
> `rules` of a definition ([collections.md](collections.md#rules)), which
> every peer enforces and which can only refuse a version; these act.

## A rule

A rule is a `std.rule` record, so everyone in the space sees what runs and
who made it:

```json
{
  "name": "Busy channels",
  "when": {
    "query": {
      "collection": "std.channel",
      "include": { "messages": { "rel": "channel", "from": "std.message", "count": true } }
    },
    "holds": { ">=": [{ "var": "included.messages" }, 100] }
  },
  "then": {
    "kind": "add",
    "collection": "std.message",
    "text": "#{title} just passed {messages} messages",
    "links": [{ "rel": "channel", "to": "$it" }]
  },
  "since": "2026-09-29T12:00:00Z"
}
```

| Field    | Meaning                                                                                                                                                        |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | What people call it                                                                                                                                            |
| `when`   | `query`: a query in [the query format](query-format.md). `holds`, optional: a condition over each result that must be true. `from`, optional: below.           |
| `every`  | Optional. Five cron fields, minute hour day month weekday, in the runner's local time: the rule also runs by itself then. A rule has `when`, `every`, or both. |
| `then`   | What it does, below                                                                                                                                            |
| `by`     | Optional. The DID of the bot that runs it; without it, its maker's own devices and agent do ([Who runs a rule](#who-runs-a-rule))                              |
| `picked` | Optional. How an app's builder showed the rule, so it can show it in words and open it again. Never read to run it.                                            |
| `paused` | Optional. Kept, but not run.                                                                                                                                   |
| `since`  | Nothing that came to hold before this sets it off: a record whose last change, and the newest record any include found, are older is left alone.               |

`"$me"`, anywhere in `query` or `holds`, is whoever runs the rule: its maker,
or the bot in `by`. So "a message mentioning me" is `{ "mentions":
{ "$contains": "$me" } }` for a person and for a bot alike. `from` lists role
names; only records written by someone holding one of them set the rule off,
and `"member"` is anyone holding a role at all.

`every` uses `*`, a number, a range `a-b`, a step `/n` and lists with commas;
weekday 0 or 7 is Sunday; a day and a weekday both given means either. At
those times the rule acts once, about no record: `$it` links nothing and
`{title}` stays as written, so a rule that changes a record needs a `when`.

`holds` is a condition in the language of checks
([spec 02 §7.6](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)),
read as a record condition (`checkRecordCondition`): `body`, `links`, `key`,
`collection`, `author` (the record's creator) and `createdAt`, and also
`included`, what the query's `include` found for the record: a number for an
include with `count`, else the list of records. Asking the space
(`versions`, `can`, `member`) is refused, as in a subscription's `where`.

Anything a query can find, a rule can act on. What points at a record is
counted by following links, so a relation must be a link to be counted
([collections.md](collections.md#links)).

## What it does

| `then.kind` | Fields                                | Does                                                                                     |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `notify`    | `text`                                | Shows a notification on the device that runs it, through the runner's `notify`           |
| `add`       | `collection`, `text`, `links`         | Adds a record to `collection`, made from `text` alone (`quickAddBody`), carrying `links` |
| `set`       | `field`, `value` (text, number, bool) | Sets one field of the record, when its maker may edit it                                 |
| `ask`       | `text`                                | Gives `text`, in the maker's words, to an agent that runs rules, with what set it off    |

`add` works with any collection whose records one line of text can make: its
naming field (`title`, `name`, `text`, …) is filled with `text`, and every
other field must have an empty value, a `default`, `false` or `[]`, or not be
required. A message, a comment and a task are all added this way, and so is a
collection someone defined yesterday. Each of `links` is `{ "rel", "to" }`,
where `to` is a record's key or `"$it"`, the record the rule holds for: a
message posted in a channel the rule is about links `channel` to `"$it"`, one
that shares it links `shares`.

In `text`, `{title}` is what the record is called (its `title`, `name`,
`question` or `text`, or the runner's `title`), and `{<include>}` how many
that include found: `{messages}` above.

`ask` is for an agent: `weave agent`, or a bot. It is told the rule's words
as its maker's, and what set it off as data, never as instructions. A runner
without one leaves rules that ask to one that has.

## Running

For each record a rule newly holds for, the runner first writes a
`std.rule-run`, then acts, then says in the run what it did, and the key of
the record it added (`made`). A run is one per rule per record (`onePer:
['link:rule', 'link:about']`), which is how a rule acts once for each record
however often, and by however many devices, it is looked at; it is the rule's
history for anyone in the space.

Nothing a rule added sets off a rule: a record some run names in `made` is
left alone. Without that, "when a message is added, add a message" would
answer itself forever, and two rules could answer each other. Nor does
anything the runner's agent, or the bot, wrote itself, so an agent asked to
act can't set itself off.

Whatever a rule writes is written as its runner, so a rule can do nothing its
runner couldn't do by hand. Only its maker, or someone with `moderate`, can
delete one.

A bot answering mentions, from anyone holding a role, run by the bot:

```json
{
  "name": "Answer when mentioned",
  "when": {
    "query": { "collection": "std.message", "where": { "mentions": { "$contains": "$me" } } },
    "from": ["member"]
  },
  "then": { "kind": "ask", "text": "Answer them briefly, in the same channel." },
  "by": "did:key:zDnae…",
  "since": "2026-09-29T12:00:00Z"
}
```

### Who runs a rule

- Without `by`, its maker: `runRules(node, space, maker)` once, or
  `startRules(node, { account })`, which runs them in every space the node
  follows, again after each change, and at the times they name. The example
  app runs them while it is open, but not those that ask or run at set times
  (`timed: false`); `weave agent` runs all of them.
- With `by`, only that bot, and only while the maker holds `std.rule/instruct`
  in the space: its roles say who may direct a bot there.
- A rule whose current version an agent wrote (`viaAgent`) runs nowhere: an
  agent may suggest one, and it waits until the person saves it themselves.

Two runners of one account, an app and an agent, may both claim a record
before either hears the other. `startRules` waits `claimMs` after claiming;
the earlier claim acts, and the later is taken back. Nothing runs while every
runner is closed ([#109](https://github.com/leifriksheim/weave/issues/109)).

_Source: `packages/core/src/schemas/rules.ts` (`rule`, `ruleRun`, `checkRule`, `matching`, `act`, `rulesFor`, `runRules`, `startRules`, `fillRuleText`, `IT`, `ME`), `packages/core/src/schemas/cron.ts`, `packages/core/src/schema/quick-add.ts` (`quickAddBody`), `packages/core/src/records/checks.ts` (`checkRecordCondition`, `recordHolds`), `packages/cli/src/main.ts` (`runAgent`), `packages/cli/src/agent-rules.ts` (`triggerPrompt`), `apps/example/src/rules.ts` (`compile`, `useRunRules`). Tests: `packages/core/tests/rule-records.test.ts`, `packages/core/tests/rule-runners.test.ts` (all)._
