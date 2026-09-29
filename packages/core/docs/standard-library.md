# The standard library

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/weave/blob/main/spec/README.md).

An optional library of ordinary definitions (`@weaveprotocol/core/schemas`),
broad enough that most apps need no definitions of their own. The protocol
knows none of them; a space learns one when someone defines it there. All are
`version` 1 when first defined. They are drawn from atproto lexicons, Nostr
NIPs, JSContact (RFC 9553), JSCalendar (RFC 8984) and schema.org; issue
[#36](https://github.com/leifriksheim/weave/issues/36) has the sources.

## What a `std.*` name means

A collection name belongs to the space that defines it. There is no registry,
and two spaces may give one name different shapes. What lets two apps read
each other's records is the definition, not the name, and the library exists
so that apps reach for the same definitions.

`std.*` names are the library's by convention ([spec 02 §6.4](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)); peers do not refuse a
`std.*` definition of another shape. The reference node's agent actions keep
to the convention:

- `collections_standard` lists the library, and gives any of its definitions
  in full ([06](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md), actions).
- `apps_propose` takes a standard collection by name (`"std.event"` in
  `needs`) and stores the library's definition for it.
- `apps_propose` refuses a `std.*` name the library does not have, and a
  `std.*` definition whose `schema`, `links`, `rules`, `permissions` or
  `history` differ from the library's. Its `title`, `description`, `screen`
  and `network` may be the app's own.

Names of an app's own collections should say what they are for
(`carpool.ride`) rather than share a generic prefix (`app.ride`) that another
app may want for something else. Making apps open collections by what they
hold rather than by name is [compatible definitions](apps-as-records.md#compatible-definitions).

_Source: `packages/core/src/schemas/apps.ts` (`standardNeeds`), `packages/core/src/schemas/standard.ts` (`standardDefinition`, `standardGroups`), `packages/core/src/node/actions.ts` (`collections_standard`, `apps_propose`). Tests: `packages/core/tests/agents.test.ts` ("a standard collection by name is exactly the library’s; a look-alike std.\* is refused", "collections_standard lists the library by area, and gives definitions in full")._

## Conventions

- What several people edit is several records, not an array in one body,
  because a record resolves as a whole ([spec 02 §4.3](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)): a list and its items, a
  document and its blocks, an order and the seller's updates to it.
- "One per person" or "one per slot" is `onePer` ([spec 02 §7.3](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), over links and
  scalar fields only (see the known defect there).
- Bodies carry no `createdAt`; the record has one. They carry only the times
  of the thing itself (`start`, `due`, `takenAt`).
- Link roles share one vocabulary: `about` (what an annotation is on),
  `replyTo` and `root` (threads), `parent` (trees), `in` (member of a list,
  album, calendar, document, account), `shares` (quotes).
- What only one person should see — blocks, mutes, reminders, settings — goes
  in that person's own space, not in one others read.

**Fragments.** The dialect has no `$ref` ([spec 02 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), so shared shapes are spelled
out in each definition, built by the library's `fragments` so they are
identical everywhere:

| Fragment   | Shape                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `when`     | string 10–64: RFC 3339 date-time (`2026-03-01T18:30:00+01:00`), or `YYYY-MM-DD` for a whole day                                        |
| `day`      | string of 10: `YYYY-MM-DD`                                                                                                             |
| `timeZone` | string 1–64: an IANA zone, `Europe/Oslo`                                                                                               |
| DID        | string 1–256: an account DID (built by `person`)                                                                                       |
| `money`    | `{ amount, currency }`, both required: `amount` a decimal string 1–32 (`"12.50"`), never a number; `currency` ISO 4217, 3 characters   |
| `address`  | `{ street, locality, region, postcode, country }`, each optional; `country` ISO 3166-1 alpha-2                                         |
| `place`    | `{ name, address, lat, lon }` (built by `placeRef`), each optional; `lat` −90–90, `lon` −180–180, WGS 84                               |
| `blob`     | `{ hash, size, mime, name? }`: `hash` the lower-case hex SHA-256 of the bytes as stored (64 characters), `size` bytes, `mime` required |
| `image`    | `{ blob, alt? }`: `alt` ≤ 2000, what it shows                                                                                          |
| `position` | string 1–200 that sorts where a record goes (Positions, below)                                                                         |

Until the dialect has `format` ([spec 02 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), `when` and `day` are checked only for
length. How a `blob`'s bytes are stored and fetched is planned (A.4); the
reference to them is not.

## The definitions

In the tables, a **bold** field is required; `string 1–200` gives its
`minLength`–`maxLength`, `[]` a list with its `maxItems`, and `a`/`b` an
`enum`. Links read `role` → where it may point, cardinality. Rules not given
are [spec 02 §7.1](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)'s defaults, so "defaults" means anyone in the space may add, change
and remove.

**Annotations**

| Name             | Body                                                                                            | Links                                              | Rules                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `std.reaction`   | **`emoji`** string 1–16                                                                         | `about` → `*`, one                                 | edit, delete: `creator`; `onePer: [@author, link:about, emoji]`                                             |
| `std.comment`    | **`text`** string 1–10000                                                                       | `about` → `*`, one; `replyTo` → `std.comment`, one | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                                  |
| `std.tag`        | **`label`** string 1–100                                                                        | `about` → `*`, many                                | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                                  |
| `std.attachment` | **`name`** string ≥ 1; **`mime`** string ≥ 1; `size` integer ≥ 0; `url` string; `blob` blob     | `about` → `*`, one                                 | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                                  |
| `std.reference`  | `note` string                                                                                   | `about` → `*`, one; `to` → `*`, one                | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                                  |
| `std.bookmark`   | `title` string ≤ 500; `url` string 1–2048; `note` string ≤ 2000                                 | `about` → `*`, one                                 | edit, delete: `creator`                                                                                     |
| `std.rating`     | **`score`** integer 1–5; `review` string ≤ 10000                                                | `about` → `*`, one                                 | edit, delete: `creator`; `onePer: [@author, link:about]`                                                    |
| `std.highlight`  | **`quote`** string 1–10000; `prefix` string ≤ 500; `suffix` string ≤ 500; `note` string ≤ 10000 | `about` → `*`, one                                 | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                                  |
| `std.pin`        | `note` string ≤ 500                                                                             | `about` → `*`, one                                 | create: `can:moderate`; edit: `can:moderate`; `onePer: [link:about]`; permissions `moderate`                |
| `std.report`     | **`reason`** `spam`/`abuse`/`sexual`/`misleading`/`illegal`/`other`; `note` string ≤ 2000       | `about` → `*`, one                                 | edit: `creator`; delete: `creator`, `can:moderate`; `onePer: [@author, link:about]`; permissions `moderate` |
| `std.label`      | **`value`** string 1–64                                                                         | `about` → `*`, one                                 | create: `can:moderate`; edit: `can:moderate`; `onePer: [link:about, value]`; permissions `moderate`         |
| `std.claim`      | `note` string ≤ 500                                                                             | `about` → `*`, one                                 | edit: `creator`; delete: `creator`, `can:moderate`; `onePer: [link:about]`; permissions `moderate`          |

**People**

| Name          | Body                                                                                                                                                                                                                                                                                                                                                                                                                                   | Links | Rules                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------- |
| `std.profile` | `name` string ≤ 100; `bio` string ≤ 2000; `avatar` blob; `banner` blob; `pronouns` string ≤ 50; `links` { `title` string ≤ 100, **`url`** string 1–2048 }[] (≤ 16)                                                                                                                                                                                                                                                                     | —     | edit, delete: `creator`; `onePer: [@author]`      |
| `std.card`    | `name` { `full` string ≤ 200, `given` string ≤ 100, `family` string ≤ 100 }; `emails` { **`address`** string 1–320, `label` string ≤ 50 }[] (≤ 16); `phones` { **`number`** string 1–64, `label` string ≤ 50 }[] (≤ 16); `addresses` { **`address`** address, `label` string ≤ 50 }[] (≤ 16); `organization` string ≤ 200; `jobTitle` string ≤ 200; `birthday` day; `photo` blob; `urls` string 1–2048[] (≤ 16); `note` string ≤ 10000 | —     | defaults                                          |
| `std.follow`  | **`did`** DID; `space` string ≤ 256                                                                                                                                                                                                                                                                                                                                                                                                    | —     | edit, delete: `creator`; `onePer: [@author, did]` |
| `std.block`   | **`did`** DID; `until` when                                                                                                                                                                                                                                                                                                                                                                                                            | —     | edit, delete: `creator`; `onePer: [@author, did]` |
| `std.mute`    | **`did`** DID; `until` when                                                                                                                                                                                                                                                                                                                                                                                                            | —     | edit, delete: `creator`; `onePer: [@author, did]` |
| `std.status`  | `text` string ≤ 280; `emoji` string ≤ 16; `until` when                                                                                                                                                                                                                                                                                                                                                                                 | —     | edit, delete: `creator`; `onePer: [@author]`      |

**Messaging and publishing**

| Name              | Body                                                                                                                                                                                                                          | Links                                                                            | Rules                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `std.message`     | **`text`** string 1–10000; `channel` string ≤ 100; `mentions` DID[] (≤ 64); `replyingTo` DID; topics `channel`, `mentions`, `replyingTo`                                                                                      | `replyTo` → `std.message`, one; `root` → `std.message`, one; `shares` → `*`, one | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate` |
| `std.channel`     | **`name`** string 1–100; `topic` string ≤ 500; `position` string 1–200                                                                                                                                                        | —                                                                                | create: `can:moderate`; edit: `can:moderate`; permissions `moderate`       |
| `std.post`        | `text` string ≤ 10000; `images` image[] (≤ 8); `langs` string 2–35[] (≤ 3)                                                                                                                                                    | `replyTo` → `std.post`, one; `root` → `std.post`, one; `shares` → `*`, one       | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate` |
| `std.repost`      | —                                                                                                                                                                                                                             | `about` → `*`, one                                                               | edit, delete: `creator`; `onePer: [@author, link:about]`                   |
| `std.article`     | **`title`** string 1–300; `summary` string ≤ 1000; `content` string ≤ 200000; `cover` blob; `slug` string 1–200; `publishedAt` when; `draft` boolean                                                                          | `in` → `std.publication`, one                                                    | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate` |
| `std.publication` | **`title`** string 1–200; `description` string ≤ 2000; `icon` blob                                                                                                                                                            | —                                                                                | defaults                                                                   |
| `std.doc`         | **`title`** string 1–500                                                                                                                                                                                                      | —                                                                                | defaults                                                                   |
| `std.doc-block`   | **`type`** `paragraph`/`heading1`/`heading2`/`heading3`/`bullet`/`numbered`/`todo`/`quote`/`code`/`image`/`divider`; `text` string ≤ 20000; `checked` boolean; `language` string ≤ 32; `image` image; `position` string 1–200 | `in` → `std.doc`, one; `parent` → `std.doc-block`, one                           | defaults                                                                   |
| `std.wiki-page`   | **`slug`** string 1–200; **`title`** string 1–300; `content` string ≤ 200000                                                                                                                                                  | —                                                                                | `onePer: [slug]`; history `all`                                            |
| `std.note`        | `title` string ≤ 500; `content` string ≤ 200000; `pinned` boolean; `color` string ≤ 32                                                                                                                                        | —                                                                                | defaults                                                                   |
| `std.call`        | **`status`** `missed`/`ended`; `to` string ≤ 256; **`startedAt`** string ≤ 64; `endedAt` string ≤ 64; `people` string ≤ 256[] (≤ 64)                                                                                          | —                                                                                | edit, delete: `creator`                                                    |

**Lists**

| Name            | Body                                                                                                                    | Links                                      | Rules    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- |
| `std.list`      | **`title`** string 1–200; `description` string ≤ 2000; `icon` string ≤ 16; `kind` string ≤ 32                           | —                                          | defaults |
| `std.list-item` | `text` string ≤ 1000; `url` string 1–2048; `did` DID; `checked` boolean; `quantity` number ≥ 0; `position` string 1–200 | `in` → `std.list`, one; `about` → `*`, one | defaults |

**Files and media**

| Name         | Body                                                                                                                                                                | Links                        | Rules                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------- |
| `std.folder` | **`name`** string 1–255                                                                                                                                             | `parent` → `std.folder`, one | defaults                |
| `std.file`   | **`name`** string 1–255; **`blob`** blob                                                                                                                            | `parent` → `std.folder`, one | defaults                |
| `std.photo`  | **`blob`** blob; `alt` string ≤ 2000; `width` integer ≥ 1; `height` integer ≥ 1; `takenAt` when; `place` place                                                      | `in` → `std.album`, many     | defaults                |
| `std.album`  | **`title`** string 1–200; `description` string ≤ 2000                                                                                                               | `cover` → `std.photo`, one   | defaults                |
| `std.video`  | **`blob`** blob; `thumbnail` blob; `duration` number ≥ 0; `captions` blob; `alt` string ≤ 2000; `title` string ≤ 300                                                | `in` → `*`, many             | defaults                |
| `std.track`  | **`title`** string 1–300; `artists` string 1–200[] (≤ 20); `album` string ≤ 300; `duration` number ≥ 0; `isrc` string ≤ 12; `mbid` string ≤ 36; `blob` blob         | `in` → `std.list`, many      | defaults                |
| `std.play`   | **`title`** string 1–300; `artists` string 1–200[] (≤ 20); `album` string ≤ 300; `duration` number ≥ 0; `isrc` string ≤ 12; `mbid` string ≤ 36; **`playedAt`** when | —                            | edit, delete: `creator` |

**Time and planning**

| Name             | Body                                                                                                                                                                                                                              | Links                                                                                    | Rules                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `std.calendar`   | **`name`** string 1–200; `color` string ≤ 32                                                                                                                                                                                      | —                                                                                        | defaults                                                                                           |
| `std.event`      | **`title`** string 1–500; `description` string ≤ 10000; **`start`** when; `end` when; `tz` string 1–64; `allDay` boolean; `place` place; `url` string 1–2048; `rrule` string 1–1000; `status` `confirmed`/`tentative`/`cancelled` | `in` → `std.calendar`, one                                                               | defaults                                                                                           |
| `std.rsvp`       | **`status`** `going`/`maybe`/`no`; `guests` integer 0–100; `note` string ≤ 500                                                                                                                                                    | `about` → `std.event`, one                                                               | edit, delete: `creator`; `onePer: [@author, link:about]`                                           |
| `std.slot`       | **`start`** when; **`end`** when; `tz` string 1–64; `note` string ≤ 1000                                                                                                                                                          | `in` → `std.calendar`, one                                                               | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate`                         |
| `std.booking`    | `note` string ≤ 1000                                                                                                                                                                                                              | `about` → `std.slot`, one                                                                | edit: `creator`; delete: `creator`, `can:moderate`; `onePer: [link:about]`; permissions `moderate` |
| `std.column`     | **`name`** string 1–200; `position` string 1–200                                                                                                                                                                                  | —                                                                                        | defaults                                                                                           |
| `std.task`       | **`title`** string 1–500; `notes` string ≤ 10000; `position` string 1–200; `due` when; `status` `todo`/`doing`/`done`/`cancelled`; `assignees` DID[] (≤ 20); `priority` integer 0–4                                               | `column` → `std.column`, one; `parent` → `std.task`, one; `project` → `std.project`, one | defaults                                                                                           |
| `std.project`    | **`name`** string 1–200; `description` string ≤ 10000; `status` `planned`/`active`/`paused`/`done`/`cancelled`; `due` when                                                                                                        | —                                                                                        | defaults                                                                                           |
| `std.time-entry` | **`start`** when; `end` when; `note` string ≤ 1000                                                                                                                                                                                | `about` → `*`, one                                                                       | edit, delete: `creator`                                                                            |
| `std.reminder`   | **`at`** when; `note` string ≤ 1000; `done` boolean                                                                                                                                                                               | `about` → `*`, one                                                                       | edit, delete: `creator`                                                                            |
| `std.habit`      | **`name`** string 1–200; `schedule` string ≤ 1000; `target` number ≥ 0; `unit` string ≤ 32; `position` string 1–200                                                                                                               | —                                                                                        | edit, delete: `creator`                                                                            |
| `std.checkin`    | **`date`** day; `value` number; `note` string ≤ 1000                                                                                                                                                                              | `about` → `std.habit`, one                                                               | edit, delete: `creator`; `onePer: [@author, link:about, date]`                                     |

**Places and travel**

| Name           | Body                                                                                                                                 | Links                      | Rules                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------------------------------------- |
| `std.place`    | **`name`** string 1–200; `address` address; `lat` number -90–90; `lon` number -180–180; `category` string ≤ 100; `url` string 1–2048 | —                          | defaults                                     |
| `std.visit`    | **`at`** when; `note` string ≤ 2000                                                                                                  | `about` → `std.place`, one | edit, delete: `creator`                      |
| `std.trip`     | **`title`** string 1–200; `start` day; `end` day; `note` string ≤ 10000                                                              | —                          | defaults                                     |
| `std.location` | **`lat`** number -90–90; **`lon`** number -180–180; `accuracy` number ≥ 0; **`at`** when                                             | —                          | edit, delete: `creator`; `onePer: [@author]` |

**Home and life**

| Name                | Body                                                                                                                                                                                                                                                                                                        | Links                       | Rules                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------- |
| `std.recipe`        | **`title`** string 1–300; `description` string ≤ 2000; `ingredients` { **`text`** string 1–500, `quantity` number ≥ 0, `unit` string ≤ 32 }[] (≤ 200); `steps` string 1–5000[] (≤ 200); `servings` integer ≥ 1; `prepMinutes` integer ≥ 0; `cookMinutes` integer ≥ 0; `image` image; `source` string 1–2048 | —                           | defaults                                                 |
| `std.meal`          | **`date`** day; **`meal`** `breakfast`/`lunch`/`dinner`/`snack`; `note` string ≤ 1000                                                                                                                                                                                                                       | `about` → `std.recipe`, one | `onePer: [date, meal]`                                   |
| `std.journal-entry` | **`date`** day; `content` string ≤ 200000; `mood` string ≤ 32                                                                                                                                                                                                                                               | —                           | edit, delete: `creator`; `onePer: [@author, date]`       |
| `std.measurement`   | **`kind`** string 1–64; **`value`** number; **`unit`** string 1–32; **`at`** when; `note` string ≤ 1000                                                                                                                                                                                                     | —                           | edit, delete: `creator`                                  |
| `std.workout`       | **`type`** string 1–64; **`start`** when; `duration` number ≥ 0; `distance` number ≥ 0; `route` blob; `note` string ≤ 2000                                                                                                                                                                                  | —                           | edit, delete: `creator`                                  |
| `std.work`          | **`kind`** `book`/`film`/`show`/`album`/`game`/`podcast`/`other`; **`title`** string 1–500; `creators` string 1–200[] (≤ 20); `year` integer 0–9999; `ids` { `isbn` string ≤ 17, `imdb` string ≤ 16, `mbid` string ≤ 36, `wikidata` string ≤ 16 }; `cover` blob                                             | —                           | defaults                                                 |
| `std.progress`      | **`status`** `want`/`doing`/`done`/`dropped`; `percent` number 0–100; `finishedAt` when; `note` string ≤ 2000                                                                                                                                                                                               | `about` → `std.work`, one   | edit, delete: `creator`; `onePer: [@author, link:about]` |

**Money and trade**

| Name                | Body                                                                                                                                                       | Links                           | Rules                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `std.expense`       | **`title`** string 1–200; **`amount`** money; **`paidBy`** DID; `split` { **`did`** DID, `share` string 1–32 }[] (≤ 100); `date` day; `note` string ≤ 2000 | —                               | history `all`                                                              |
| `std.settlement`    | **`from`** DID; **`to`** DID; **`amount`** money; `date` day; `note` string ≤ 1000                                                                         | —                               | edit, delete: `creator`; `fixed: [from, to, amount]`                       |
| `std.money-account` | **`name`** string 1–200; **`currency`** string 3–3; `kind` string ≤ 32                                                                                     | —                               | defaults                                                                   |
| `std.transaction`   | **`amount`** money; **`date`** day; `payee` string ≤ 200; `category` string ≤ 100; `note` string ≤ 1000; `cleared` boolean                                 | `in` → `std.money-account`, one | defaults                                                                   |
| `std.listing`       | **`title`** string 1–300; `description` string ≤ 10000; `price` money; `images` image[] (≤ 12); `status` `available`/`reserved`/`sold`; `place` place      | —                               | edit: `creator`; delete: `creator`, `can:moderate`; permissions `moderate` |
| `std.order`         | **`items`** { **`title`** string 1–300, **`quantity`** integer ≥ 1, `price` money }[] (1–100); `total` money; `note` string ≤ 2000                         | `about` → `std.listing`, many   | edit, delete: `creator`                                                    |
| `std.order-update`  | **`status`** `accepted`/`paid`/`shipped`/`delivered`/`cancelled`/`refunded`; `note` string ≤ 2000                                                          | `about` → `std.order`, one      | edit, delete: `creator`                                                    |

**Community and governance**

| Name               | Body                                                                                                                                                                             | Links                                     | Rules                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `std.poll`         | **`question`** string 1–500; **`options`** string 1–200[]; `closed` boolean                                                                                                      | —                                         | edit: `creator`; delete: `creator`, `can:moderate`; `fixed: [options]`; permissions `moderate`      |
| `std.vote`         | **`choice`** integer ≥ 0; `choices` integer ≥ 0[] (≤ 100)                                                                                                                        | `about` → `std.poll`, `std.proposal`, one | edit, delete: `creator`; `onePer: [@author, link:about]`                                            |
| `std.proposal`     | **`title`** string 1–300; `body` string ≤ 20000; **`options`** string 1–200[] (1–20); `closesAt` when; `status` `open`/`passed`/`rejected`/`withdrawn`; `quorum` integer 1–10000 | —                                         | edit: `creator`; delete: `creator`, `can:moderate`; `fixed: [options]`; permissions `moderate`      |
| `std.ballot`       | **`choice`** integer ≥ 0                                                                                                                                                         | `about` → `std.proposal`, one             | edit, delete: `creator`; `onePer: [@author, link:about]`; `fixed: [choice]`                         |
| `std.decision`     | **`outcome`** integer ≥ 0; **`proposal`** string 1–128 (a version id); **`ballots`** string 1–128[] (≤ 256)                                                                      | `about` → `std.proposal`, one             | edit, delete: `creator`; `onePer: [link:about]`; `check` (below)                                    |
| `std.goal`         | **`title`** string 1–300; `body` string ≤ 20000; **`target`** integer 1–10⁹; **`unit`** string 1–50; `closesAt` when                                                             | —                                         | edit: `creator`; delete: `creator`, `can:moderate`; `fixed: [target, unit]`; permissions `moderate` |
| `std.pledge`       | **`amount`** integer 1–10⁹; `note` string ≤ 1000                                                                                                                                 | `about` → `std.goal`, one                 | edit, delete: `creator`; `onePer: [@author, link:about]`; `fixed: [amount]`                         |
| `std.goal-reached` | **`goal`** string 1–128 (a version id); **`pledges`** string 1–128[] (≤ 256)                                                                                                     | `about` → `std.goal`, one                 | edit, delete: `creator`; `onePer: [link:about]`; `check` (below)                                    |
| `std.announcement` | **`title`** string 1–300; `text` string ≤ 20000                                                                                                                                  | —                                         | create: `can:announce`; edit: `creator`; delete: `creator`, `can:announce`; permissions `announce`  |
| `std.badge`        | **`name`** string 1–100; `description` string ≤ 1000; `image` blob                                                                                                               | —                                         | create: `can:award`; edit: `can:award`; permissions `award`                                         |
| `std.award`        | **`did`** DID; `note` string ≤ 1000                                                                                                                                              | `about` → `std.badge`, one                | create: `can:award`; edit: `can:award`; `onePer: [link:about, did]`; permissions `award`            |

**Proven outcomes.** A `std.decision` and a `std.goal-reached` are not
declared by anyone: each cites the records that prove it, by version id, and
every device checks the proof ([spec 02 §7.6](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)). Anyone in the space may write one, once, when the
proof is there:

- `std.decision` cites the proposal's first version (`proposal`) and ballots
  (`ballots`). Its checks: the proposal is the one it is `about`, as first
  put; `outcome` is one of its options; and the ballots cited that are about
  that proposal and chose `outcome` come from at least `quorum` different
  people. A proposal without a `quorum` can't be decided this way.
- `std.goal-reached` cites the goal's first version (`goal`) and pledges
  (`pledges`). Its checks: the goal is the one it is `about`, as first set;
  each person's pledge counts once; and the pledges add up to `target`.

A cited version proves what was signed, so what they count is final: a
ballot's `choice` and a pledge's `amount` are `fixed`, and their first
versions are kept whole (`onePer`), so they can be cited. That is why
`std.ballot` exists beside `std.vote`: a vote can be changed, a ballot can't.

```json
{ "outcome": 0, "proposal": "bay24o4l…", "ballots": ["bq7x…", "b3kd…", "bm2a…"] }
```

_Source: `packages/core/src/schemas/library/community.ts` (`ballot`, `decision`, `goal`, `pledge`, `goalReached`), `apps/example/src/components/apps/Decisions.tsx`. Tests: `packages/core/tests/checks.test.ts` ("std.decision and std.goal-reached")._

**Settings**

| Name          | Body                                                        | Links | Rules                                                  |
| ------------- | ----------------------------------------------------------- | ----- | ------------------------------------------------------ |
| `std.setting` | **`app`** string 1–200; **`key`** string 1–200; `value` any | —     | edit, delete: `creator`; `onePer: [@author, app, key]` |

**Mentions and replies.** A `std.message` names the accounts it calls on
in `mentions` and, when it replies to someone's message, their account in
`replyingTo`. A chat should fill them from what the person picked (an
`@name` they chose, the message they replied to), never from matching text.
They are topics with `channel`, so a subscription can ask for only messages
that mention the account, or reply to it, or are in one channel
([spec 06 §2.11](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md), `topic: { field: "mentions", me: true }`),
and a carrier can match it unread ([spec 02 §8](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)).

```json
{ "text": "@Sam are you coming?", "mentions": ["did:key:zDnae…Sam"], "replyingTo": "did:key:zDnae…Sam" }
```

_Source: `packages/core/src/schemas/library/publishing.ts` (`message`), `apps/example/src/components/apps/Chat.tsx`. Tests: `packages/core/tests/topics.test.ts` ("mentions and replies are tagged, so “mentions me” and “replies to me” match only those")._

**Changes to earlier definitions.** `std.attachment`, `std.task`,
`std.message`, `std.vote` and `std.proposal` existed before the library grew. Each gained
only optional fields and link roles: `std.attachment` a `blob`; `std.task`
`due`, `status`, `assignees`, `priority` and the `parent` and `project` links;
`std.message` a `channel`, the `root` link, `mentions`, `replyingTo`, and its
first topics ([spec 02 §8](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)); `std.vote` `choices` (every
choice, most preferred first, with `choice` the first of them); `std.proposal`
`quorum`, for `std.decision`. A space that
holds an earlier definition keeps it until someone adds an app that needs the
new one, which shows as a change. One of them is not additive in the sense of
[spec 02 §6.5](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md): `std.vote`'s `about` may now also point at a `std.proposal`, so an app
that reads votes may meet one on something that is not a poll.

**Also exported** from the same module (specified with their features):

| Name                  | Body                                                                                                                            | Rules                                                                     | Where                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `std.contact`         | `did` ≤ 256 and `name` ≤ 200, required; `space` ≤ 256; `note` ≤ 2000; `blocked` boolean                                         | `onePer: [did]`                                                           | [03 — Spaces](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)                               |
| `std.contact-request` | `to` ≤ 256 and `sealed` ≤ 16000, required                                                                                       | edit, delete: `creator`                                                   | [03 — Spaces](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)                               |
| `std.app`             | `title` 1–100 and `needs` (1–10 objects), required; `description` ≤ 1000; `from` ≤ 300; `updates` 1–100; `notify` (1–8 objects) | edit: `creator`; delete: `creator`, `can:moderate`; permission `moderate` | [06 — Nodes, sessions and apps](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md) |

**Positions.** `position` is a string that sorts (by plain string comparison)
where a record goes in a hand-made order. Digits are `0–9a–z`; a position
never ends in `0`, so there is always room between two. Equal positions sort by
key. A record without one goes at the end. `positionBetween(before, after)` in
the library makes one; any string that sorts correctly is valid.

_Source: `packages/core/src/schemas/fragments.ts`, `packages/core/src/schemas/library/` (one file per area), `packages/core/src/schemas/standard.ts` (`standardGroups`), `packages/core/src/schemas/index.ts` (`positionBetween`, `useSchemas`), `packages/core/src/schemas/contacts.ts`, `packages/core/src/schemas/apps.ts`. Tests: `packages/core/tests/schemas.test.ts` ("the standard library", "standard nouns"), `packages/core/tests/contacts.test.ts`, `packages/core/tests/agents.test.ts`._

## Planned: what the library still waits on

> **Planned.** Not normative. Issue:
> [#36](https://github.com/leifriksheim/weave/issues/36).
>
> - **File bytes** ([spec 05 §16.6](https://github.com/leifriksheim/weave/blob/main/spec/05-sync-and-storage.md),
>   [#37](https://github.com/leifriksheim/weave/issues/37)). The `blob`
>   fragment names bytes by hash, but a space cannot yet store or send them,
>   so `std.file`, `std.photo`, `std.video` and the images elsewhere point at
>   bytes a reader may not be able to fetch.
> - **References to other spaces** ([spec 02 §5.3](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md),
>   [#38](https://github.com/leifriksheim/weave/issues/38)). `std.follow`'s
>   `space` is a plain space id, and a repost or a list item can point only
>   within its own space.
> - **`format`** ([spec 02 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)), to check `when`, `day` and `url`.

## `std.call`

Calls themselves are kept nowhere. Their history is a `std.call` record in the
space, written only if the space defines `std.call`:

| Field       | Type                            | Meaning                                      |
| ----------- | ------------------------------- | -------------------------------------------- |
| `status`    | `"missed"` \| `"ended"`         | required                                     |
| `to`        | string ≤ 256                    | For a missed call: who was rung.             |
| `startedAt` | string ≤ 64 (ISO date)          | required                                     |
| `endedAt`   | string ≤ 64 (ISO date)          | For an ended call.                           |
| `people`    | string[] ≤ 64 items, each ≤ 256 | For an ended call: every account seen in it. |

Rules: `edit: creator`, `delete: creator` ([02](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)).

```json
{
  "status": "ended",
  "startedAt": "2026-09-26T10:00:00.000Z",
  "endedAt": "2026-09-26T10:14:02.311Z",
  "people": ["did:key:zDnaeSm3…", "did:key:zDnaeXL64…"]
}
```

_Implementation detail:_ the call a device is in is kept in `sessionStorage`
under `weave-call` as `{ space, call }`, so after a reload the page can offer to
rejoin while the call is still going on.

_Source: `packages/core/src/calls/calls.ts`, `packages/core/src/schemas/index.ts` (`call`). Tests: `packages/core/tests/calls.test.ts`._
