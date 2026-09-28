# Weave for Chrome

Keeps your Weave spaces online, and your pod up to date, while your browser is
open — even with no Weave app open. It can't read them.

Without it, your data only moves while some app of yours is open. Write
something, close the tab, and it waits there until that app and one of your
other devices happen to be online together. With the extension, Chrome itself
is always there to pass things on: your phone gets your laptop's changes
whenever it comes online, and a friend's message lands in your pod while every
app is closed.

## What it holds

It connects to your account home like an app does, but gets something
different: a **pass** for each space instead of a key. A pass lets it prove to
your other devices that it may be sent the space, and nothing more. So it keeps
records exactly as they travel, private ones still locked, and checks each one
the way every device does. It never gets your password, a space's key or a
note that lets it write.

What it can see is what a relay sees: who wrote something, when, and the name
of the collection. Not what anything says.

## Build and load

```bash
npm install                        # at the repository root: one install for the whole workspace
npm run build -w apps/extension    # or: npm run dev -w apps/extension, to rebuild on change
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load
unpacked** → choose `extension/dist`. A welcome tab opens; connect it to your
account home. With `npm run dev`, press the reload button on the extension's
card after a change (and after a change to `static/`, restart `npm run dev`).

The website offers it for download too, at `/extension`, until it is in the
Chrome Web Store: `npm run package -w apps/extension -- <out.zip>` builds it
with `.env.production` (the deployed home and relay) and zips it, and the
site's build (`netlify.toml`) puts it at `/weave-chrome.zip`.

Settings are read at build time, from `extension/.env.local` (not committed;
copy `.env.example` to start). A variable set in the shell wins over the file.

| Variable       | Default                                           | What                                                                               |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `WEAVE_HOME`   | `http://localhost:5174`                           | The account home offered first. People can type their own.                         |
| `WEAVE_RELAYS` | `ws://localhost:8787,wss://p2p-web-relay.fly.dev` | Relays, comma separated. The home's relays arrive with the grant and are used too. |

For local development run the home (`npm run dev -w apps/home`). The relay on
this machine (`npm run signal` at the root) is optional: the deployed one is in
the defaults too, so you only need the local one to work offline.

## How it's put together

| File               | Runs in            | Does                                                                                                                                                               |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/worker.ts`    | the service worker | Keeps the offscreen page alive (on start, install, and a one-minute alarm) and sets the badge. Chrome stops it after 30 quiet seconds, so nothing else lives here. |
| `src/offscreen.ts` | a hidden page      | The carrier node (`createCarrierNode`): runs as long as Chrome does, over WebRTC. Attaches the pod when Chrome allows it.                                          |
| `src/welcome.ts`   | a tab              | Connecting to the home, picking the pod, status, disconnecting. Connecting has to happen here: the toolbar popup closes when the home's window takes focus.        |
| `src/popup.ts`     | the toolbar popup  | Status at a glance, **Resume pod sync** when Chrome wants a click, and "Notify me when…".                                                                          |
| `src/notify.ts`    | a tab              | Picking what to be notified about from the kinds of record your spaces hold, and asking the home to add them. A tab for the same reason as connecting.             |

Permissions: `offscreen`, `alarms`, `unlimitedStorage`, `notifications`. No
host permissions and no content scripts, so installing it shows no warning
about reading your sites.

## Notifications

**Notify me when…** says what to hear about: new messages in a space, ones
that mention you, ones in #design. You choose in the account home, or an app
suggests some, or you pick in this extension: it offers the kinds of record it
sees go by (it can't read them, but their kind is on the outside), and asks
the home, where you confirm. The extension
gets each of those with the value replaced by a code only your spaces' keys
can produce, so it matches records as they arrive without learning what you
asked for or reading the record. It shows the space, your label and the time;
clicking opens the app, or the home. The popup lists them, mutes one in this
browser, opens the tab to add more, and the home to pause or remove them. The worker shows the
notification; the offscreen page, where the carrier runs, may not.

The design, and what is still to be checked, is in
[06 — Nodes, sessions and apps](../../spec/06-nodes-and-sessions.md).

## Still to do

- **Real Chrome.** Check:
  - 8+ hours of uptime across sleep;
  - the folder permission after a restart, and "Allow on every visit";
  - the `background` permission;
  - 20+ spaces.
- **A real pod.** Test with the manual folder picker, and a run of the Drive mirror in the extension. The protocol side is in [05](../../spec/05-sync-and-storage.md), mirrors.
- **Testing.** A browser-driven test of the popup and notifications.
- **Publishing.** The Chrome Web Store listing. Until then the site's `/extension` page offers a zip to load unpacked; when the listing is live, point that page at it.
