# BLOCK-17 — The browser extension: your spaces stay online while Chrome is open

## What this delivers

A Chrome extension that does two things the whole time your browser is open,
even with no Weave app and no account home open:

1. **Your node takes part in gossip.** It receives what others write and hands
   it to whoever is missing it.
2. **Your pod stays up to date.** Everything it receives goes straight into
   your pod folder.

It never sees your seed and can't read your private spaces. It *carries* them:
it holds records exactly as they travel (private bodies still encrypted),
checks each one the way any peer does, and passes them on.

What the user sees:

1. Install the extension. A welcome tab opens: **"Keep your spaces online
   while Chrome is open."**
2. **Connect**. Their account home opens, they unlock, and approve: *"Weave
   extension wants to keep your spaces online. It can't read them."*
3. If the account lives in a pod: **"Keep your pod up to date too?"** They
   pick the pod folder once.
4. Done. The toolbar icon shows a dot when it's carrying, and a click shows
   which spaces it carries, peers online, the pod, and the last sync.

What changes for them:

- Write in an app, close it: the extension already has the change, and so
  does the pod. The phone gets it next time it's online, as long as Chrome
  runs on the laptop.
- A friend writes while all your apps are closed: it lands in your pod
  anyway. Open the home or any app next week and it's already there.
- The pod is a real, current copy of your spaces, so backing it up or syncing
  it with iCloud or Dropbox means something.
- Apps don't change. Sign-in still goes app → account home popup → approval.

---

## Status (2026-09-24)

**Built and tested:** passes, the carrier node, carry spaces kept current by
every device of the account, the `carry` connect flow and the home's consent
screen, writing into the pod, disconnecting from either side, and the extension
itself (`extension/`). `tests/carrier.test.ts` covers the protocol side,
including a friend's write landing in the pod while every app is closed.

**Checked in a real Chromium (Playwright, loaded unpacked):** install → connect
through the home's popup → the offscreen page carries the account over WebRTC.
With the home tab closed and only the extension running, a second browser
profile signed in and got the account's data from the extension alone. A
disconnect from that second profile made the extension wipe its copy.

**Still open:** the spikes that need a real person and time (step 0: hours of
uptime, sleep and wake, folder permission after a restart, the `background`
permission, 20+ spaces), and the Web Store listing (step 7). The pod picker
can't be scripted, so writing to a real pod has been tested only with an
in-memory folder.

---

## Before you start

Paste this. It must print `READY`.

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && \
grep -q 'export async function connectToHome' src/session/connect.ts && \
grep -q 'export function createMeshAuth' src/network/peer-auth.ts && \
grep -q 'export async function deriveReadKey' src/space/space-access.ts && \
grep -q 'export async function checkSpace' src/space/space-access.ts && \
npx tsc --noEmit >/dev/null 2>&1 && \
echo READY || echo "NOT READY — the connect flow, the mesh handshake or space access keys are missing, or the project does not typecheck"
```

**Depends on no other block.** Part 1 (a node that carries without keys) is the
same thing BLOCK-07 calls "blind mode", so building it here moves the paid host
forward too.

---

## Background

### Why an extension, and not a service worker or an installed app

A service worker can't use WebRTC, and our peers talk over WebRTC (the relay
only introduces them), so a service worker can't gossip. Periodic Background
Sync wakes a page once or twice a day, too rarely to meet anyone. An installed
home app needs a window open. An extension can keep a hidden page alive for as
long as Chrome runs (an *offscreen document*), and that page can use WebRTC,
WebSockets, IndexedDB and WebCrypto: everything a node needs.

### What the extension is: not the home, and not a window onto it

There were three ways to do it:

| | What it means | Why not / why |
|---|---|---|
| **The extension is the home** | The seed lives in the extension; apps sign in through it | Makes one publisher's extension the place every account lives. Can't be self-hosted, so it's the "identity origin" we rejected. Mobile would still need the web home, so there'd be two homes with two copies of the account |
| **The extension loads the home's URL in a hidden frame** | A hidden page embedding `weave-home.netlify.app` | Chrome gives a site embedded in another site its own separate storage, so the frame would have no saved sign-in and no pod. Fragile even if it worked |
| **The extension is a carrier** ✅ | Its own small node, with its own key, connected to the account like any app, but given no keys that read or write | Fits the rules: the home stays the only thing holding keys, stays swappable, and works with any home, including self-hosted ones |

So the extension is **one more peer**. It isn't special in the protocol: apps
don't talk to it and don't need to know it exists. They meet it through the
relay, the same way they meet your phone.

### The one thing the protocol is missing: a pass that isn't a key

Today a node can't join a private space's peers without the space key.
`createMeshAuth` (`src/network/peer-auth.ts`) makes every peer prove it holds
the space's **read key** before anything moves, and the read key is derived
from the space key (`deriveReadKey`). A node without the space key throws:
*"This node cannot read the space, so it cannot join its peers."*

But the read key only *signs* the handshake; it can't decrypt anything. So
this block adds a **pass**: what a node needs to carry a space, and nothing
more.

| In a pass | Why |
|---|---|
| The space's genesis (owner, type, public keys) | Checked against the space id (`checkSpace`), so the carrier can run the same gates as any peer |
| The read key's private half | Proves to peers it may be served the space. **It can't decrypt anything** |
| — no space key | So it can't read a private record |
| — no write secret, no note (UCAN) | So it can't write anything |

A public space needs only the genesis.

What someone who stole a pass gets: the ability to download the space's
encrypted records and their outer details (author, collection name, times).
That's the same thing a blind host (BLOCK-07) or a mirror's provider sees, and
it's why the privacy copy has to say exactly that.

### How the extension hears about new spaces

The extension gets passes for your spaces when you connect. But you'll make and
join spaces afterwards, often in apps, while the home is closed. So:

- At connect, the home creates a **carry space**: a small private space shared
  by the account and the extension. The extension gets its key, which is the
  only space key it ever holds, and the space holds only passes.
- A **carrier record** (`sys.carrier`) in the account registry names it, with
  an invite to the carry space, so every device and whole-account app opens it
  too. Carry spaces are kept out of the account's own list of spaces.
- **Rule: every node with the account key keeps each carrier's passes in step
  with the account's spaces** (`node.ts`, `syncPasses`, run whenever the
  registry changes). So a space joined in any app is carried with the home
  closed, and a space left stops being carried.
- The extension watches the carry space, and starts or stops carrying spaces
  to match.

This needs no messaging between web pages and the extension. That matters:
Chrome only lets a page message an extension if the extension lists that page's
address ahead of time, which a self-hosted home can't be.

*Alternative considered:* the home tells the extension directly whenever it's
open. It's simpler, but new spaces made in apps wouldn't be carried until the
home is next opened, and it only works for homes the extension knows by
address.

---

## Design

### The extension's parts (Manifest V3)

```
extension/
  static/manifest.json, *.html, styles.css, icons/
  src/
    worker.ts       service worker: makes sure the offscreen page exists, sets the badge
    offscreen.ts    the carrier node: runs as long as Chrome runs
    welcome.ts      full tab: connect to your home, pick the pod, status, disconnect
    popup.ts        toolbar popup: status, and "Resume pod sync"
    shared.ts       messages between them, and the grant in IndexedDB
  build.mjs         esbuild, bundling the protocol straight from ../src
```

No framework: the two visible pages are small, and plain DOM keeps the popup
quick to open.

- **The node lives in the offscreen page, never in the service worker.** Chrome
  stops a service worker after about 30 idle seconds; the offscreen page stays.
  The worker's only job is to recreate the offscreen page when Chrome starts
  (`runtime.onStartup`, `onInstalled`) and to check every minute
  (`chrome.alarms`) that it's still there.
- **Permissions:** `offscreen`, `alarms`, `unlimitedStorage`. No
  host permissions and no content scripts, so the install prompt shows no
  scary warnings like "read and change all your data". WebSockets to the relay
  and WebRTC need no permission.
- **Storage:** the extension's own IndexedDB. It holds encrypted records, the
  passes, and the extension's own key (non-extractable). The offscreen page can
  only use `chrome.runtime`, so nothing is kept in `chrome.storage`.
- **Network:** the relays (and always-on nodes) from the grant, so a
  self-hosted home with its own relay works. Rooms are hashed space ids, as
  today (`relayRoom`).

### Connecting

The connect flow is `src/session/connect.ts` as it is, with one new kind of
request:

1. The welcome tab asks for the home's address (the build's `WEAVE_HOME` by
   default), then calls `connectCarrier`, which sends `access: 'carry'`.
2. The home shows its own consent screen for `carry`: what it can do, what it
   can't, and that it sees what a relay sees. An extension origin is shown as
   "A browser extension", with the name it gave.
3. On approval the home creates the carry space, writes a pass for every space
   in the registry (the registry itself included, so a restore can go through
   the extension), and hands back:
   - the carry space's invite,
   - the relays and nodes,
   - whether the account lives in a pod, and its `dataPath`,
   - no note and no invites to other spaces.
4. The extension joins the carry space, reads the passes, and starts carrying.
5. If there's a pod, the welcome tab offers to pick it, and checks that the
   folder holds `accounts/<id>` for this account before writing anything.

**This has to start from the welcome tab, not the toolbar popup.** Chrome
closes the toolbar popup the moment another window gets focus, and a closed
opener can't receive the approval.

### Disconnecting

From the home's Connected apps on any device (carriers are listed from the
registry, not only where they were connected), or from the extension. From the
account: the passes are deleted, a `carry:closed` record tells the extension to
wipe itself, and the carrier record is removed. Devices keep the carry space
open for 30 days after, so an extension that was offline still hears it. From
the extension: it wipes itself, and says to disconnect it in the home too. Be honest in the copy: a pass can't be taken back, just as a granted
app's space key can't (the known "keys never rotate" item). A disconnected
extension that kept its data still has ciphertext and could still ask peers for
more. Rotating keys fixes both, later.

### One account at a time, and making that obvious

An extension carries one account. Someone signed in to another account in the
home, or in an app, could think it carries that one too. So:

- **The extension always shows whose it is**: the account's avatar (drawn
  exactly as the home draws it), its name, and the home it came through, with
  **Switch account** beside them. Switching to another account wipes the old
  one's copy and pod link first.
- **The home warns before a switch.** Approving the extension for Bob when this
  home had it connected to Ada says so ("It keeps “Ada” online now"), with a
  "Use another account" link right there.
- **The home shows whether each extension is online right now** (it is a peer
  in its own carry space). One that never is has Chrome closed, or is carrying a
  different account, and Settings says to open it and see which.

### Writing into the pod

This works without any account key, because of how the pod is already laid
out:

```
<pod>/accounts/<id>/stores/
  registry/          sealed with the account's vault key: every space, its key,
                     its write secret. The extension never opens this.
  spaces/<space id>/ records and the index built from them. Not sealed: private
                     bodies are already encrypted with the space key. Exactly
                     what a carrier holds.
```

`src/storage/encrypted-adapter.ts` seals only the registry, on purpose, and
`src/node/space-runtime.ts:243` opens each space as `spaces/<id>`. So the
extension opens `spaces/<id>` for each space it carries, in the same folder, in
the same format, and writes records there as they arrive.

**Two copies, two peers.** The extension keeps each space in its own
IndexedDB and, while it may, in the pod — as a second runtime joined to the
first by an in-process link (`network/local-transport.ts`). Sync keeps them
level both ways, so the pod catches up after being out of reach, with no copy
code of its own.

**Passing things on at once.** Built alongside: a node now tells its peers its
new root shortly after taking in records from a peer or a folder
(`announceSoon` in `space-runtime.ts`). Before, a record passed along waited up
to 30 seconds per hop for the next heartbeat.

**Two writers in one folder is already designed for.** `folder-reconcile.ts`
exists so that two sites, or two devices behind Dropbox, can write one folder
at once with no locks: record files are named by their own hash, and the index
is put back in line with the files. A home or app open on the same pod picks up the
extension's writes live, through the folder watch the runtime already runs
(`space-runtime.ts:939`).

The rules:

- **Only `spaces/<id>` for carried spaces.** Never the account file, never the
  registry, never another account's folder.
- **The grant carries the account's `dataPath`**, so the extension knows where
  in the folder to write.
- **The extension keeps its own copy in IndexedDB too.** The pod is a second
  place it writes to, not its only store, so a missing or unplugged folder
  never stops gossip.
- **The folder is picked once, in the extension.** Folder permission belongs to
  each site separately (the home's permission doesn't carry over), so the user
  picks the same pod once more. The picker opens on the pod's usual location.
- If the pod moves or its account file disappears, stop writing and show
  "Pick your pod again" in the popup, rather than guessing.

**What Chrome actually does (read in Chromium's
`chrome_file_system_access_permission_context.cc`, 2026-09-24):** a folder
permission lasts until the last *page* of the origin closes, and for an
extension that means the welcome tab and the toolbar popup. The offscreen page
is not one, so the permission lapses soon after the popup closes. The way out
is Chrome's **"Allow on every visit"**: once an origin has it, the permission
does not lapse. Chrome offers it only in its restore prompt, which needs a tab.
Asked from the toolbar popup, Chrome grants silently but only for that
session, without offering it. So every request for the pod happens in the
welcome tab, which tells the person to choose "Allow on every visit". Still to
confirm by hand, since the prompt can't be scripted: that Chrome offers it to a
`chrome-extension://` origin at all. If it doesn't, the only no-click route is
a local helper outside the browser (the `weave` daemon) writing the pod.

**The open question (spike, step 0):** whether Chrome keeps the extension's
folder permission across restarts without asking again. Websites can get
"allow on every visit"; whether an extension's hidden page gets the same is
untested. If it doesn't, the popup shows **"Resume pod sync"** after each Chrome
restart: one click. Gossip keeps running either way, and the pod catches up
from the extension's own copy the moment it's resumed.

### The sign-in flow for apps: unchanged

Apps keep opening the home popup. The extension only adds availability. A later
nicety (not in this block): the extension remembers the home's address, so apps
could suggest it instead of asking.

---

## Files

| File | Change |
|---|---|
| `src/space/pass.ts` | **New.** Make a pass from a space and its key; check one against the space id |
| `src/space/space-access.ts` | The read key's seed, and the pair from a seed |
| `src/space/account-registry.ts` | `sys.carrier` records |
| `src/node/carrier.ts` | **New.** The carrier node: no account, no signer; spaces come from passes; the pod as a second copy |
| `src/node/space-runtime.ts` | Mesh proof with a pass's read key; announce new roots at once |
| `src/node/node.ts`, `src/node/types.ts` | `node.carriers`: add, list, remove; passes kept in step with the registry |
| `src/network/local-transport.ts` | **New.** Peers in one process |
| `src/session/connect.ts` | `access: 'carry'`, `CarryGrant`, `connectCarrier` |
| `src/session/auth.ts` | `grantCarry`; disconnecting a carrier |
| `home/src/components/ConnectPage.tsx`, `Settings.tsx` | The carry consent screen; carriers listed from the registry |
| `extension/` | **New.** The extension |
| `tests/carrier.test.ts`, `tests/connect.test.ts` | **New** tests, and the home's side |

---

## Steps

0. **Spikes, a day or two, before anything else.** Answer these on a real
   Chrome and write the answers into this block:
   - Does an offscreen page with reason `WEB_RTC` stay up for 8+ hours, and
     through the laptop sleeping and waking? Are its timers slowed?
   - Can the offscreen page write to a folder picked in the welcome tab? Does
     that permission survive a Chrome restart without a click?
   - Does the `background` permission keep Chrome running after its last
     window closes (Windows, and macOS)? If it adds an install warning, leave
     it out.
   - `window.open` from an extension tab to the home, and `postMessage` back:
     does `connect.ts`'s origin check work with a `chrome-extension://` origin?
   - Memory and sockets with 20 carried spaces. Today every space opens its own
     relay socket (`space-runtime.ts`, one network manager per space), which
     may need sharing before this scales.
1. **Passes and the carrier node** in `src/`, tested with no browser: two nodes
   that are never online together converge through a carrier, and the carrier
   holds nothing readable.
2. **`carry` in the connect flow**, and the home's consent screen.
3. **The carry space** and the "whoever adds to the registry writes a pass"
   rule.
4. **The extension shell**: build, load it unpacked, connect to a local home,
   and watch two browser profiles sync through it with no app open.
5. **The pod**: pick it, check it's this account's, write carried spaces into
   `spaces/<id>`, show and resume it from the popup. Test with the home open on
   the same pod at the same time.
6. **Disconnect**, in both the home and the extension.
7. **Chrome Web Store**: listing, privacy copy, the offscreen justification
   text.

---

## Testing

- A carrier node never holds a space key other than the carry space's, or a
  seed, vault key, write secret or note. Assert on everything the grant and the
  carry space contain.
- A private record passes through a carrier and arrives readable at a member;
  at the carrier its body is still ciphertext.
- A carrier refuses a forged record and a record by someone not allowed to
  write, like any peer (`tests/space-access.test.ts` run against a carrier).
- A pass for the wrong space (genesis not matching the id) is refused.
- A space created in a whole-account app while the home is closed becomes
  carried.
- Leaving a space stops the carrier carrying it.
- Two devices never online together converge through the carrier.
- Disconnecting wipes the extension's database and removes its passes.
- The extension writes only `spaces/<id>` for carried spaces: the registry and
  the account file are byte-for-byte unchanged after a full test run.
- A record received with the home closed is in the pod, and the home reads it
  on opening with no peer online.
- The extension and the home writing one pod at the same time converge.
- Picking a folder that holds a different account is refused.
- Add to `tests/attacks.test.ts`: a peer holding only a pass can't produce a
  record any member accepts.

---

## Acceptance criteria

- [ ] Spike answers written into this block
- [ ] The extension holds no key that can read or write your spaces
- [ ] With only the extension running, a write in one browser reaches a second
      device that comes online later
- [ ] New spaces are carried without opening the home
- [ ] With only the extension running, a friend's write lands in the pod, and
      the home shows it when opened with nobody else online
- [ ] Spike answer on folder permission after restart written down, and the
      "Resume pod sync" path built if it's needed
- [ ] Install shows no host-permission warning
- [ ] Works with a self-hosted home and its own relay
- [ ] `npx tsc --noEmit` clean, full suite green

---

## Out of scope

- **Firefox and Safari.** Firefox has no offscreen documents (it has
  background pages instead), and Safari needs an app wrapper. Chromium first:
  Chrome, Edge, Brave and Arc all run the same build.
- **Running while Chrome is closed.** That's the paid host (BLOCK-07) or the
  desktop daemon.
- **Accounts kept only in the browser (no pod).** The extension still carries
  their spaces; there's just no folder to write to.
- **Apps talking to the extension directly.** It would need a content script
  on every site, which brings the scary install warning. The mesh already
  connects them.

---

## After this: Drive

The extension is the right place to run the Drive mirror (BLOCK-03 + the Drive
driver in BLOCK-04):

- A web page gets Google access that expires after an hour and can't renew it
  in the background. An extension can: `chrome.identity.getAuthToken` renews
  on its own in Chrome, and `launchWebAuthFlow` covers Edge and Brave (check
  whether it needs a sign-in each hour there).
- Mirror segments are deliberately not sealed with the space key (BLOCK-03),
  so a carrier can write and read them with passes alone.
- With both, "nothing is open" still works: the laptop's Chrome pushes to
  Drive, and the phone pulls from Drive later.

---

## Gotchas

- **One offscreen page per extension.** Everything the extension runs in the
  background shares it.
- **The Web Store asks why an offscreen page exists.** The justification is
  "a WebRTC peer that keeps the user's spaces synced". Expect the review to
  ask; explain it plainly.
- **Sleep kills connections.** On wake, reconnect at once (`online` event, the
  alarm) rather than waiting for timeouts.
- **Two extensions with the same account** (two Chrome profiles) are two
  carriers. That's harmless: records are the same wherever they come from.
- **"Can't read" is true, "sees nothing" isn't.** The carrier sees the same
  outer details a blind host does. Say exactly that in the consent screen and
  the store listing.
