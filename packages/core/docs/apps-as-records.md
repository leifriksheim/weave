# Apps as records

An app can live in a space as one `std.app` record: a title, and the
collections it needs, each as a full definition. Someone proposes it, often an
agent (`apps_propose`); nothing is defined until a person who may define
collections adds it (`addApp`), and from then on every app that draws a space
from its definitions shows it. The record's fields are in the
[standard library](standard-library.md).

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/weave/blob/main/spec/README.md).

## The app review

`reviewApp` works out what adding an app would do in a space: each collection
it needs is `new`, the `same` as the space has it, or a `change`, with what it
allows worked out from its rules ([describing a collection](#describing-a-collection))
and, for a change, what would be different and which apps in use need the
collection as it is. A person reads that before adding; an app is `added`
once every collection it needs is the same.

A space that holds the library's current definition of a standard
collection meets an app made against an earlier one: a `std.*` need is **the
same** as what the space holds when the space's schema, history, links,
permissions, rules and topics are the library's, and its screen and network
are the need's. The review never offers an earlier standard definition as a
change to a space that holds the current one, since adding it would only take
the additions away.

_Source: `packages/core/src/schemas/apps.ts` (`reviewApp`, `metByLibrary`). Tests: `packages/core/tests/agents.test.ts` ("an app made against an earlier standard definition is met by the library's current one, not offered as a change back")._

## Updates

An app is changed by proposing a new `std.app` whose
`updates` is the key of the app, in the same space, that it is a new version
of. It is a body member rather than a link so that spaces which already hold
a `std.app` definition without it accept it unchanged.

```json
{ "title": "Carpool", "needs": [ … ], "updates": "5vcfnlfrf7qnql2jhyl7erfqva" }
```

An app is **superseded** when an app that names it in `updates` is added
(every collection it needs is in the space as it says), or is itself
superseded. A superseded app would only undo its update:

- `addApp` never adds a superseded app.
- An app should not offer a superseded app to be added or opened; it is
  history, which its proposer or a moderator may delete.
- `updates` should name an app that is in the space; `proposeApp` and the
  `apps_propose` action refuse one that is not. One that names nothing
  supersedes nothing.

Until its update is added, the app it names is still the one in use.
Without `updates`, two apps that need the same collections differently each
show as a change that undoes the other. So a review names the apps in use
that need a collection it would change (`reviewApp`, `usedBy`), and
`apps_propose` warns an agent whose proposal changes one without `updates`.

> **Planned (open question):** with [`compare`](#compatible-definitions), an update's review would list
> its breaks.

_Source: `packages/core/src/schemas/apps.ts` (`supersededApps`, `reviewApp`, `proposeApp`, `addApp`), `packages/core/src/node/actions.ts` (`apps_propose`, `apps_list`), `apps/example/src/components/apps/AppsView.tsx`, `apps/example/src/components/apps/MadeApps.tsx`. Tests: `packages/core/tests/agents.test.ts` ("an update replaces the app it names: once added, the old version is not offered again", "a change to a collection another app uses names that app, and warns the agent")._

## What an app notifies about

An app may say what in it is worth hearing
about, in `notify`: 1 to 8 entries of `{ label, collection, topic?, others? }`,
each an `AppNotify`. They have the meaning of a `NotifyProposal`
([spec 06 §2.11](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)) without `spaces` and `open`, which
belong to whichever app shows it, and `collection` must be one of the app's
`needs`. An app that shows it offers them to the person as a proposal of its
own, for the space it is in, when the person asks; nothing is turned on for
anyone by adding the app. Like `updates`, it is a body member so that spaces
which already hold a `std.app` definition without it accept it unchanged.

- `checkApp` refuses an entry that is malformed, that names `spaces` or
  `open`, or whose `collection` is not a need, so `proposeApp`, `apps_propose`
  and `addApp` refuse such an app.
- `copyApp` carries `notify` along.

```json
{
  "title": "Carpool",
  "needs": [ … ],
  "notify": [
    { "label": "New trip", "collection": "carpool.trip" },
    { "label": "A seat on my trip", "collection": "carpool.seat", "topic": { "field": "driver", "me": true } }
  ]
}
```

_Source: `packages/core/src/schemas/apps.ts` (`checkApp`, `copyApp`), `packages/core/src/space/notify.ts` (`AppNotify`, `checkAppNotify`), `packages/core/src/node/actions.ts` (`apps_propose`), `apps/example/src/notifications.ts`. Tests: `packages/core/tests/agents.test.ts` ("an app says what is worth hearing about, only in its own collections")._

## Describing a collection

A definition's `title` and `description` are its author's words and may say
anything. What a collection actually allows is worked out from its rules, as
fixed sentences, so a person deciding whether to add a collection reads what
every peer will enforce.

`describe(definition)` returns, in this order:

1. Who may add: "Anyone in the space can add a vote." / "Only … can add …".
2. Who may change and remove — one sentence when `edit` and effective `delete`
   are the same set, else one each: "Only whoever added a vote can change or
   remove it."
3. `onePer`: "One vote per person per poll — adding another changes the
   first." (with `@author`); otherwise "… — anyone adding another replaces the
   first." when `edit` includes `member`, else "… — whoever adds it first holds
   it."
4. `fixed`: "Once a poll is added, its “options” can't be changed."
5. One per declared link: "Each vote points at one thing: a poll (“about”)." or
   "A comment can point at anything in the space (“about”)."
6. `permissions`: "Roles in the space can be given permission to “moderate”."
7. `history: "all"`: "Every earlier version of a … is kept."

Nouns come from `title`, else the last segment of `name`; field labels from
the schema's `title`s, else the field name in words. A rule the describer does
not know must make it fail rather than stay silent.

The wording can change; that every rule produces a sentence doesn't.

_Source: `packages/core/src/records/describe.ts`. Tests: `packages/core/tests/agents.test.ts` ("what a collection allows, in words")._

## Compatible definitions

An app decides it can open a space by finding a collection with the right
**name**. Chat opens any `std.message`, whatever its fields and whoever its
rules let edit it. And a space whose definition is a little older than the
app's (a `std.message` without the `shares` link) stays that way, because the
library skips a collection the space already has. Whether an app can use a
definition it did not write is a question for the app, not for peers: a peer
stores and judges every record the same way whatever the answer.

> **Planned.** Not built. Issues:
> [#11](https://github.com/leifriksheim/weave/issues/11),
> [#12](https://github.com/leifriksheim/weave/issues/12). The parts peers
> would check, content-addressed definitions and additive-only changes, are
> planned in [spec 02 §6.5](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md).

### The check: `compare(held, wanted)`

`held` is the definition the space has; `wanted` the one the app was built
with. The result is two lists of breaks, each a path and a plain sentence:

```ts
interface Compatibility {
  read: Break[]; // why the app might meet a record it can't read; empty: it can read them all
  write: Break[]; // why a record the app writes might not fit, or be refused; empty: it can write
}
interface Break {
  path: string;
  message: string;
} // 'rules.edit', "Anyone can edit anyone's messages here; this app assumes only their author"
```

An app that only shows records needs `read` empty; one that writes needs both.
Anything the checker cannot decide is a break.

- **Fields.** Reading needs every body the space accepts to be one the app
  accepts (held ⊆ wanted); writing needs wanted ⊆ held. Over the schema
  keywords a definition may use ([spec 02 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md))
  this is a walk of both schemas: `type` sets contained (`integer` inside
  `number`); a field one side relies on is `required` on the other; numeric
  and length ranges contained; `enum`, `const` and `oneOf` value sets
  contained; recurse into `properties` and `items`. `title`, `description`
  and `x-choicesFrom` are ignored. A field only one side mentions is ignored,
  unless that side requires it or closes the schema
  (`additionalProperties: false`).
- **Links.** A link role the app uses is declared in the space; where it may
  point is contained (`["app.poll"]` is inside `"*"` for reading, not for
  writing); `"one"` is inside `"many"`. Roles the app does not know are
  ignored when reading.
- **Rules: never looser.** Stricter rules are never a safety problem (at worst
  the app cannot write, which `can` already reports), so rules are checked one
  way: the space's rule must be an **attenuation** of the app's, as in UCAN.
  For `create`, `edit`, `delete`, every who in the space's list is covered by
  one in the app's (`member` covers everyone; `creator` and `can:<p>` cover
  themselves; defaults count). `onePer`: the space promises at least the
  uniqueness the app relies on (fewer parts is a stronger promise). `fixed`:
  the space keeps at least the fields the app expects fixed. `permissions`: a
  permission the app's rules name is declared.

### What uses it

1. **Apps open by compatibility**, not by name. A collection that exists but
   is not compatible is shown with its breaks instead of opened.
2. **Harmless updates apply themselves.** When the library's definition is
   newer and `compare(held, library)` finds no break in either direction and
   the rules are no looser, a writer allowed to change the definition writes
   it at the next version without asking. (Adding `shares` to an older
   `std.message` is this case.)
3. **Anything else asks a person.** The app review shows the breaks ("lets
   anyone edit messages; now only their author"), not only "changes who may do
   what".

An app should not define a `std.*` name that is not compatible with the
standard library's. Peers don't refuse one on arrival (refusing depends on
what each peer knows, and would leave peers disagreeing), so an app treats an
incompatible `std.message` as not a message.

Built so far: `apps_propose` refuses a `std.*` definition that is not exactly
the library's ([what a `std.*` name means](standard-library.md#what-a-std-name-means)).
Typed handles in the library (`node.use(space, Poll)`) would run the same check.

The plans differ in one place: this check stays on the app's side and lets a
person approve a breaking change, while #12 makes "additive" a rule peers
enforce. `compare` is the check "additive" needs, in both directions, and
identical content-addressed definitions (#11) are trivially compatible, so it
would run only on a real change.

### What "additive" means

Spec 02 §6.5 plans the rule; this is why it draws the line where it does.
Changes are classified as **oasdiff** classifies OpenAPI changes, treating a
collection's schema as a request body and a response body at once: apps write
records (a request) and apps read them (a response).

- **As a request**, a change must not **tighten**: a new required field, a
  narrower type, a smaller range or length, fewer `enum`/`const`/`oneOf`
  values, a link that may point at less. Apps on the old definition could no
  longer write.
- **As a response**, a change must not **loosen**: a field no longer
  required, a wider type, a larger range, more `enum` values, a link that may
  point at more. Apps on the old definition would meet records they misread
  (a status they don't switch on).

A change under the same name is additive when oasdiff would report no
error-level break for it on either side. Findings oasdiff reports as warnings
or information stay that. The catalogue of checks is oasdiff's, mapped onto
the schema keywords and links; a keyword it has no check for is a break.

Rules are not shape. `create`, `edit`, `delete`, `onePer`, `fixed` and
`permissions` are the space's governance: a space may tighten them under the
same name (at worst an app can't write, which `can` reports), and may never
loosen them past what an app relies on ("never looser", above).

### Open questions

- **Rules only apply from now on.** A space that was loose last month and
  strict today holds records written under the loose rules. Either `compare`
  looks at every definition the collection has had, or "compatible" is stated
  to describe records written from now on. Probably the second.
- **Translating instead of refusing** (lenses between versions, as in
  Cambria), so an app can read a definition it is not compatible with. Later.

## Screens

A collection definition may carry a `screen`, one HTML document, and a
`network`, the exact origins that screen may reach ([spec 02 §6.1](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)). Agents propose them in `std.app` records; only a person who may define
collections adds them. An app that shows a screen:

- must run it in a frame with an opaque origin that may run scripts and
  submit forms and nothing else (the reference:
  `sandbox="allow-scripts allow-forms"`), and hand it the records only
  through a message port it answers as the person looking, under the
  collection's rules;
- must put this policy in front of everything the screen says, so it is in
  force before any script runs:

  ```
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob: <each https origin>; connect-src <each origin, or 'none'>;
  font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'
  ```

  Any other policy on the frame may only allow more, never less, since a page
  under two policies gets what both allow. With no `network`, or before the
  person agrees, the lists are empty and the screen is sealed:
  `connect-src 'none'` and images from `data:` and `blob:` only;

- must ask the person looking before giving a screen its `network`, naming
  each origin, and run it sealed if they decline. The screen runs as them, so
  what it can send is what they can see. The answer holds for that exact list;
  a definition that names a new origin asks again. How an app remembers the
  answer is its own.

The app review names each origin, from the definition itself (`describeCollection`:
"Its screen can connect to api.open-meteo.com, and send there anything the
person looking can see in it. Each person is asked first."), and a proposal
that adds an origin to a collection the space has is a change someone must
approve ("lets its screen reach https://api.open-meteo.com").

Example: a carpool ride's screen shows the weather at departure.

```json
{ "name": "app.carpool.ride", "screen": "<!doctype html>…", "network": ["https://api.open-meteo.com"], … }
```

A person who allows it gets `connect-src https://api.open-meteo.com` and
`img-src data: blob: https://api.open-meteo.com`; one who declines gets the
sealed policy, and the screen must still work, without the weather.

> Rationale for forms: without `allow-forms` a browser drops a form's
> submission before its `submit` event fires, so a screen's handler never
> runs and the form silently does nothing. `form-action 'none'` already
> sends every submission nowhere, so allowing forms lets a screen use them
> and lets nothing out. Popups, modals (`alert`, `confirm`, `prompt`, which
> a screen could dress up as the app asking for a password) and top-level
> navigation stay off.

> Rationale: whoever adds an app decides to trust its author, but the screen
> reads, as each viewer, records only that viewer can open. So the network is
> each viewer's to give. Exact origins keep what leaves visible: a screen
> given `https://api.open-meteo.com` can't also reach a server its author
> controls.

_Source: `packages/core/src/schema/collection-def.ts` (`checkScreenNetwork`, `MAX_SCREEN_ORIGINS`), `packages/core/src/schemas/screens.ts` (`screenPolicy`, `screenDocument`, `SCREEN_GUIDE`), `packages/core/src/schemas/apps.ts` (`differences`, `appScreen`), `packages/core/src/records/describe.ts` (`describeCollection`), `apps/example/src/components/apps/ScreenFrame.tsx`, `apps/example/public/screen.html`. Tests: `packages/core/tests/agents.test.ts` ("a screen reaches only the exact origins its definition names, and the review says so"; "a definition carries its screen to every peer; one too large is refused")._

## Planned: meaning-level hints

A definition says what a record may hold and who may change it, not what it
means to a screen. Screens derived from definitions (the app review, apps
without a screen of their own; [06](https://github.com/leifriksheim/weave/blob/main/spec/06-nodes-and-sessions.md)) have to guess
which field is the title or that votes are shown as counts. The plan adds
optional hints to a definition:

- which field is the record's **title**;
- a field's **role** (a date, a person, an amount);
- **tallies**: "show as a count" of records linking here, the way
  `x-choicesFrom` already makes vote-style counts possible;
- values **worked out on read**: "voting closes Friday", "who hasn't
  answered". Each reader computes them from the records and its own clock, so
  nothing has to run anywhere.

Like `x-choicesFrom`, hints are display only and never checked when
validating, and [`compare`](#compatible-definitions) ignores them. They would go in a new
top-level definition member rather than as schema keywords: unknown
top-level members are ignored by today's peers, while an unknown schema
keyword makes the definition invalid ([spec 02 §6.2](https://github.com/leifriksheim/weave/blob/main/spec/02-records.md)). Added when a real agent-made app
shows the derived screen falling short. _Open:_ the format.
