# BLOCK-18 — Apps an agent makes, that a group can use straight away

> **Status (2026-09-24):** built on branch `agent-made-apps`, all four parts.
> Where the build differs from the plan below, it says **Built:**. What's left
> is under "Still open" at the end.

## What this delivers

Someone in a space asks their agent for a new way to work together, and it's
there for everyone, with nothing deployed and nothing hosted:

1. In a climbing group's space, Anna asks Claude (in Chrome, with the Weave
   tab open): *"Make us a way to sort out who drives on Saturday."*
2. Claude designs two collections, a trip and a seat (one seat per person per
   trip, only the driver can cancel), and **proposes** them as an app.
3. Everyone in the space sees a card in the Apps tab: **"Carpool — proposed
   by Anna, via her agent"**, with a plain summary the app itself can't fake:
   *"Anyone can offer a trip. Anyone can take one seat per trip. Only whoever
   offered a trip can change or cancel it."*
4. Someone allowed to add collections clicks **Add**. The app shows up for
   everyone on their next sync, offline included, with a screen derived from
   its definitions. Nobody wrote UI.
5. Another group likes it: **Copy to…** puts the same proposal in their space.

The idea underneath: **an app is data.** Its definitions and rules are records
in the space, so they sync like messages, and every client builds the screen
from them. Making an app costs about as much as sending a message.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export const NODE_ACTIONS' src/node/actions.ts && \
grep -q "name: 'collections_define'" src/node/actions.ts && \
grep -q 'export function exposeToAgents' example/src/webmcp.ts && \
grep -q 'export function mcpTools' cli/src/mcp.ts && \
grep -q 'export function describeWho' src/records/rules.ts && \
grep -q "REVOKE_COLLECTION = 'sys.revoke'" src/space/roles.ts && \
grep -q 'export const APPS' example/src/components/apps/index.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the node actions, WebMCP tools, MCP server, rules, revocation or the Apps tab is missing, or the project does not typecheck"
```

**Depends on** BLOCK-15 (roles, the `define` permission, `sys.revoke`), which
is built. Nothing else.

---

## What already works

More than it sounds like. Worth knowing before building anything:

- **An agent in the browser can already use Weave.** `example/src/webmcp.ts`
  registers every `NODE_ACTIONS` operation as a WebMCP tool when the page
  loads. An agent that reads a page's WebMCP tools (Claude in Chrome, or any
  extension that does) can list spaces, define collections and write records
  in whatever tab is signed in.
- **A desktop agent can too.** `cli/src/mcp.ts` serves the same actions over
  MCP for Claude Desktop or Claude Code. The example can also reach desktop
  agents through a local relay, off unless the person turns it on.
- **Whatever it defines is usable at once.** The Collections tab derives forms,
  tables and "vote on this poll" buttons from the definition alone
  (`example/src/derive/`).
- **Guards exist.** Anything destructive or that hands out access asks the
  person first, and results containing other people's writing come with a note
  telling the model to treat them as data.

So an agent can make a working collection today. What's missing:

| | Today | After |
|---|---|---|
| Who wrote it | The agent signs as the tab, so it looks exactly like you | "Anna, via her agent", a key of its own you can disconnect |
| Adding collections | The agent defines them directly if you're allowed to | The agent proposes; a person adds |
| Knowing what it does | Read the JSON | A summary worked out from the rules, never by the model |
| An app | Only code in the example (Chat, Kanban, Polls) | Also a record in the space: title, and the definitions it needs |
| Sharing it with another group | Copy JSON by hand | **Copy to…** |

### Why a browser extension, and which one

The agent's side and Weave's side are two different extensions, and only one
of them is ours:

- **The agent** is any browser agent that reads WebMCP tools: Claude in Chrome,
  say. It needs a Weave tab open and signed in, because that tab is where the
  keys are.
- **Our extension (BLOCK-17) can't serve these tools, and shouldn't.** It's a
  carrier: it holds records without being able to read private ones, and it
  has no key that can sign for you. Giving it one would make it the "identity
  origin" we decided against. It stays a peer.

The one real limit: the tab has to be open while the agent works. For work
that runs while no tab is open, the desktop path (`cli/src/mcp.ts`) is the
answer. Nothing here changes that.

---

## 1. The agent gets its own key

Today the agent signs with the tab's own key, so its writes can't be told
apart from yours and it can't be disconnected without disconnecting the tab.

**Build:** when the person turns agents on in the example, the example asks
the account home for a **second note** for a second key, the agent key. It
goes through the same connect flow as any app, with a new `agent: true` on the
`ConnectRequest`, the same spaces or fewer, and a shorter expiry (a day,
renewed while the tab is open). The home writes the label into the note
itself, as a UCAN fact (`fct: { weave: { agent: true } }`). Notes carry no
facts today, so this is the one addition to how notes are made and read.

**Built:** the fact is `{ weave: 'agent' }` (`AGENT_FACT`,
`src/identity/agent-note.ts`). The note lasts 7 days like an app's: renewing
means opening the home, which needs a click, so a day would mean asking every
day. An agent gets chosen spaces only: the home refuses an agent request for
the whole account or for new spaces. `node.asAgent({ keys, note })` is the node
acting as the agent: it signs with the agent key, reads and writes only the
spaces the note names, and refuses joining, leaving, inviting, roles and the
account. The home keeps the agent's connection apart from the app's (same
origin); disconnecting the app disconnects its agent too.
Every WebMCP and desktop-relay tool call signs with the agent key. The person's
own clicks keep signing with the tab's key.

- Peers only resolve one-link chains, so the home signs **root → agent key**
  directly, not tab → agent.
- Records written with the agent key show as **"Anna, via agent"**. The note
  carries the label, so every client can tell, not only ours.
- **Disconnect agent** in the home writes `sys.revoke` for that note, which is
  already how app notes are taken back.
- This replaces the "Agent sessions" line in [README](README.md): the agent
  isn't its own identity, it signs for you with a labelled, narrower note.

**Attacks to close:** a record signed by the agent key after its note is
revoked is refused by peers. A record claiming the `agent` label without a
note that says so shows as a plain record from that key, not as "via agent"
of someone else.

**Built, stronger than planned:** the limit above is closed at peers, not only
in the tab. Every peer ignores any change to the access history (definitions,
roles, members, invites, revokes) signed under an agent's note, the same way
it ignores a malformed one (`buildEvent` in `space-runtime.ts`). So an agent
can never add a collection or change who may do what, whichever tool it
reaches, even one it signs by hand. Tests in `tests/agents.test.ts` forge both
and fail without the rule.

## 2. Propose, don't define

**Build `std.app`**, an ordinary schema in the std library. This isn't a
protocol change:

```ts
export const app = typed<App>()({
  name: 'std.app',
  title: 'App',
  description: 'A way of working together: what it is called, and the collections it needs.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000 },
      // Full definitions, as collections_define takes them — not yet in force
      needs: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object' } },
      // Where it was copied from: a space id and record key, for "based on…"
      from: { type: 'string' },
    },
    required: ['title', 'needs'],
  },
  rules: { edit: 'creator', delete: 'creator' },
});
```

- **Proposing** writes one `std.app` record. Any member can, and so can an
  agent key. Nothing is defined yet, so a proposal can't break anything.
- **Adding** is a person with `define` clicking **Add**: their tab calls
  `collections.define` for each definition in `needs`. The definitions are
  signed by them, not by the agent, and the existing checks apply unchanged.
- **The tools:** new actions `apps_propose` and `apps_list` in `NODE_ACTIONS`,
  so WebMCP, the CLI and the MCP server all get them. When the agent key is
  the signer, `collections_define` and `collections_delete` answer *"propose
  it with apps_propose; a person adds it"* instead of running.
- A proposal naming a `sys.*` collection is refused when proposed and
  refused again when added.
- A proposal naming a collection the space **already has** is shown as a
  change ("changes Trip: adds a field, `seats`"), never as something new.

## 3. A summary the model can't write

The riskiest thing an agent can do here isn't writing bad code. It's
**describing an app wrongly**: "a friendly poll" whose rules let anyone
delete anyone's vote.

**Build `describeCollection(definition)`** in the protocol
(`src/records/describe.ts`, next to `describeWho`). It's a pure function that
turns rules, links and fields into short sentences:

- *"Anyone in the space can offer a trip."* (`create`, default `member`)
- *"Only whoever offered it can change or cancel it."* (`edit`/`delete: creator`)
- *"One seat per person per trip."* (`onePer: ['@author', 'link:trip']`)
- *"Once taken, a seat's trip can't be changed."* (`fixed`)
- *"Those allowed to moderate can also remove it."* (`can:moderate`)
- *"Every version is kept."* (`history: 'all'`)

Proposal cards show these sentences, and **not** the proposal's own
`description` in their place (that shows below, as "what they say about it").
`collections_define` and `apps_propose` return them too, so the agent can
repeat them to the person accurately.

**Test to add:** every rule key and every `Who` value produces a sentence, and
a rule the function doesn't recognise makes it throw rather than say nothing.
When a rule is added to `checkRules` without a sentence here, the test fails.

## 4. The Apps tab lists records too

`APPS` stays: coded apps are still the best screens. Next to them, the Apps
tab lists the space's `std.app` records:

- **Proposed:** the card from part 3, who proposed it (and "via agent"), and
  **Add** for those allowed to define, or *"Ask someone who can add
  collections"* for everyone else.
- **Added:** opens a screen built from the existing derive helpers: the
  collection the others link to is the main list, and each of its records
  opens with its linked collections underneath, with add buttons and counts
  (`x-choicesFrom` already makes vote-style tallies possible). No new UI
  concepts, just the Collections tab narrowed to one app.
  **Built:** the app's collections, each as the Collections tab draws it,
  the one nothing else points at first (`MadeApps.tsx`).
- **Copy to…:** writes the same `std.app` into another space you're in, with
  `from` set, as a proposal there.

When a coded app and a `std.app` need the same collections, the coded app
wins. It's the better screen for the same data. **Not built yet:** both show.

## 5. Added after: a nested screen, and screens of their own

**Built on 2026-09-24**, after the first four parts.

**Drawn from the rules (`AppBoard.tsx`).** An added app with no screen of its
own is no longer a stack of lists. What nothing else in the app points at is
the main list (trips, polls, games); what points at one of them is drawn
inside it (seats in a trip, votes on a poll). A field that picks from the thing
it points at (`x-choicesFrom`) becomes buttons with counts. Nothing to fill in
plus one per person becomes "Add your seat" / "Remove your seat". Anything
else gets a form.

**Screens.** For what lists can't show (a chess board, a calendar), a
collection definition may carry `screen`: one HTML document, at most 48 KB.
Because it's on the definition:

- only a person allowed to define collections puts one in a space (every peer
  ignores an agent doing it), and
- what they approved is exactly what runs: later edits to the proposal change
  nothing.

The app runs it in `<iframe sandbox="allow-scripts">` loading `/screen.html`,
whose own policy takes the network away (no fetch, no outside images or
fonts, no forms). The frame has an opaque origin, so it can't touch the app's
storage, keys or page. Its only way out is a message port to
`createScreenBridge` (`src/schemas/screens.ts`): the app's collections, in one
space, as whoever is looking, under the rules. The port is handed over once,
so a page the frame navigates to hears nothing. `window.weave` inside the
screen is `list / get / put / update / remove / people / onChange / me`;
`apps_screen_guide` tells an agent how to write one.

The site's policy moved from a header into the app's own HTML (added at
build), because one site-wide header would also apply to `/screen.html` and
block the screen. Only `frame-ancestors 'self'` stays a header.

**Proof:** an agent (through the same tools) built chess, with game, seat and
move collections plus a screen (`docs/screens/chess.html`, 14 KB). The rules do
the multiplayer work:

- one seat per colour per game: the first to take it holds it;
- one move per turn number: a clash resolves the same way on every device;
- moves can't be changed once made.

The screen checks legality and skips any move that breaks the rules, or that
wasn't made by the player in that seat. Two people in two browsers played it
over real peer connections.

**Honest limits:**

- A screen can still send data out by navigating its own frame to a web
  address. The app stops it at once, but can't stop that first request. It
  can only carry what the app's collections hold in this space, which
  everyone there can already read. It matters most for an app copied in from
  elsewhere, and the proposal card says to add a screen only when you trust
  who proposed it.
- Code can't be summed up in sentences the way rules can. The card shows the
  code, and what the frame lets it do, but not what it will show.

---

## Not in this block, on purpose

In rough order of when they're likely to matter:

- **Meaning hints on definitions** (which field is the title, "show as a
  count"), added when a real agent-made app shows the derived screen falling
  short. Already on the README list.
- ~~Screens made by the agent~~, built in part 5.
- **Work worked out on read.** "Voting closes Friday", "who hasn't answered".
  Each reader can compute these from the records and their own clock, so they
  need no one to run anything. That keeps the no-servers promise. They belong
  with the meaning hints.
- **Permission-limited notes**, so peers, not only the tab, refuse an agent key
  that tries to define. See the honest limit in part 1.
- **Per-collection grants**, and private-space keys that rotate. Until both
  exist, an agent granted a private space can read all of it for as long as
  its keys last. See BLOCK-14.

## Open questions

1. ~~Can an agent key ever add?~~ **Decided: no.** A person always approves,
   even in a space that's only theirs.
2. **Should `std.app` carry a version**, so a changed proposal for an app
   that's already added shows as an update rather than a second app?
3. **Is "via agent" enough to say?** Or should the card name which agent
   (the note could carry "Claude in Chrome")? That's the agent's word, not a
   proof.

Rough size: **about a week.** Parts 1 and 3 are the protocol-side work; 2 and 4
are mostly the example.

## Still open

- ~~**The desktop path signs as the person.**~~ Done in BLOCK-20: `weave
  connect` gives the terminal an agent's note, and `weave mcp` runs `asAgent`.
  The agent in the browser now works as the person, with no note (BLOCK-20
  says why).
- **Coded app wins** (part 4) isn't built.
