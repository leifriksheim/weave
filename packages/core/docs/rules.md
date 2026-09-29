# Rules

"When a channel has more than 100 messages, say so in it." "When a poll has
10 votes, close it." A rule finds records with a query, keeps those a
condition holds for, and does one thing for each, once.

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
  "then": { "kind": "message", "text": "#{title} just passed {messages} messages", "channel": "$it" },
  "since": "2026-09-29T12:00:00Z"
}
```

| Field    | Meaning                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`   | What people call it                                                                                                                              |
| `when`   | `query`: a query in [the query format](query-format.md). `holds`, optional: a condition over each result that must be true.                      |
| `then`   | What it does, below                                                                                                                              |
| `picked` | Optional. How an app's builder showed the rule, so it can show it in words and open it again. Never read to run it.                              |
| `paused` | Optional. Kept, but not run.                                                                                                                     |
| `since`  | Nothing that came to hold before this sets it off: a record whose last change, and the newest record any include found, are older is left alone. |

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

| `then.kind` | Fields                                | Does                                                                                                                               |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `notify`    | `text`                                | Shows a notification on the device that runs it, through the runner's `notify`                                                     |
| `message`   | `text`, `channel`                     | Posts a `std.message` sharing the record. `channel`: a channel's key, or `$it` for the record itself, which then isn't also shared |
| `comment`   | `text`                                | Posts a `std.comment` about the record                                                                                             |
| `task`      | `text`                                | Adds a `std.task` titled so                                                                                                        |
| `set`       | `field`, `value` (text, number, bool) | Sets one field of the record, when its maker may edit it                                                                           |

In `text`, `{title}` is what the record is called (its `title`, `name`,
`question` or `text`, or the runner's `title`), and `{<include>}` how many
that include found: `{messages}` above.

## Running

A rule runs as its maker, on their devices: `runRules(node, space, maker)`
looks at every rule `maker` made in the space and, for each record a rule
newly holds for, first writes a `std.rule-run`, then acts, then says in the
run what it did. A run is one per rule per record (`onePer: ['link:rule',
'link:about']`), which is how a rule acts once for each record however often
it is looked at, and it is the rule's history for anyone in the space.

Whatever a rule writes is written as its maker, so a rule can do nothing its
maker couldn't do by hand. Only its maker, or someone with `moderate`, can
delete one.

A device runs its maker's rules when records change; the example app does
so while it is open. Two devices of one maker open at once may both act
before either's run reaches the other, and nothing runs while every device is
closed. Running rules on one always-on node is
[#109](https://github.com/leifriksheim/weave/issues/109).

_Source: `packages/core/src/schemas/rules.ts` (`rule`, `ruleRun`, `checkRule`, `matching`, `act`, `runRules`, `fillRuleText`, `IT`), `packages/core/src/records/checks.ts` (`checkRecordCondition`, `recordHolds`), `apps/example/src/rules.ts` (`compile`, `useRunRules`). Tests: `packages/core/tests/rule-records.test.ts` (all)._
