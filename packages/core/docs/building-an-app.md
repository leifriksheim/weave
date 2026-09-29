# Building an app

An app needs a node. There are two ways to get one, and they end in the same
place: a `P2PNode` you read and write through.

## Connect to the person's account home (recommended)

The app never sees the account's seed. It asks the person's account home for
access, the person picks which spaces it gets, and the home signs a note from
the account to a key the app made for itself. Every peer checks that note, so
the app cannot write anywhere it was not given.

```tsx
import { createWeaveConnection } from '@weaveprotocol/core/session';
import { WeaveProvider, useConnection } from '@weaveprotocol/core/react';

const connection = createWeaveConnection({
  home: 'https://weave-home.netlify.app/connect', // a suggestion: the person may use their own
  request: {
    name: 'Todo',
    access: 'write', // or 'read'
    scope: 'spaces', // or 'account', for every space
    create: [{ name: 'Todos', visibility: 'private' }],
  },
  network: { relays: ['wss://p2p-web-relay.fly.dev'] },
});

createRoot(root).render(
  <WeaveProvider connection={connection}>
    <App />
  </WeaveProvider>,
);

function App() {
  const { connection, state } = useConnection();
  if (state.status !== 'ready')
    return <button onClick={() => connection.connect()}>Connect with Weave</button>;
  return <Todos />;
}
```

- The grant lasts seven days and is remembered between visits. When it runs
  out, `state.status` is `expired`, and connecting again renews it.
- `scope: 'spaces'` gives the spaces the person picks, plus any the app asked
  to `create`. `scope: 'account'` gives every space, and lets the app make and
  join spaces. Ask for the narrower one unless the app is a view onto
  everything.
- Without React: `connectToHome`, `startConnectedNode` and `grantStore` from
  `@weaveprotocol/core/session`.

## Sign in inside the app

For an app that holds the account itself. The flow (where data lives, which
account, password or passkey, creating one, pairing a phone) ships as an
element and as a React component.

```html
<weave-auth app-name="Todo" relays="wss://p2p-web-relay.fly.dev"></weave-auth>
<script type="module">
  import '@weaveprotocol/core/elements';
  document.querySelector('weave-auth').addEventListener('weave-session', (event) => {
    const session = event.detail.session; // { account, did, sessionDid, node }, or null
    if (session) start(session.node);
  });
</script>
```

```tsx
import { createWeaveAuth } from '@weaveprotocol/core/session';
import { WeaveProvider, WeaveAuth, useWeave } from '@weaveprotocol/core/react';

const auth = createWeaveAuth({ appName: 'Todo', network: { relays: ['wss://p2p-web-relay.fly.dev'] } });

function App() {
  const { state } = useWeave();
  if (state?.stage !== 'ready') return <WeaveAuth />;
  return <Todos />;
}

createRoot(root).render(
  <WeaveProvider auth={auth}>
    <App />
  </WeaveProvider>,
);
```

## A node by hand

For scripts, tests and servers:

```typescript
import {
  createNode,
  createIdentityManager,
  createLocalRootSigner,
  indexedDBStores,
  rolePresets,
} from '@weaveprotocol/core';

const manager = createIdentityManager();
const me = await manager.fromRecoveryCode(code);

const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()),
  stores: indexedDBStores('my-app'),
  network: { relays: ['wss://p2p-web-relay.fly.dev'] },
});
```

Leave out `network` to stay offline. Call `node.close()` when done.

## Spaces

```typescript
const space = await node.spaces.create({ name: 'Groceries', visibility: 'private', ...rolePresets.team });

const invite = await node.spaces.invite(space.id); // a link-safe string; treat it as a secret
const view = await node.spaces.invite(space.id, { write: false }); // read-only
await node.spaces.join(invite); // on the friend's side
await node.spaces.closeInvite(space.id, invite); // nobody else joins with it
```

- `rolePresets`: `solo` (just you; invites are view-only), `team` (everyone
  invited can write, invite and add collections), `community` (admins,
  moderators, members). Or pass your own `roles`.
- A private invite carries the space key. Anyone holding it can read the
  space, so don't log it or put it in a URL a server sees (use the fragment,
  `#invite=…`).
- `node.spaces.list()` gives every space this node has, with `readable`,
  `writable` and `role`.

## React hooks

All from `@weaveprotocol/core/react`, below a `WeaveProvider`:

| Hook                                                                | Gives                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `useNode()`                                                         | The node, to write with                                                 |
| `useSpaces({ having? })`                                            | The spaces, kept current, with `create`, `join`, `leave`                |
| `useQuery(space, query)`                                            | `{ result, error }`, re-run as records change here or arrive from peers |
| `useRecord(space, key)` / `useLinked(space, key)`                   | One record; the records pointing at it                                  |
| `useCollections(space)` / `useProfiles(space)` / `useAccess(space)` | What a space holds; who is in it; roles and members                     |
| `useSpaceStatus(space)`                                             | Connection and peers                                                    |
| `useCan(space, action, target)`                                     | Whether to show an edit or delete button                                |
| `useHoldSpace(space)`                                               | Keeps a space syncing while the view is on screen                       |
| `useLive(space, load, deps)`                                        | Anything else, reloaded as the space changes                            |
| `useNames(space)`                                                   | `name(did)`: what someone is called there, never passing for another    |
| `useMyName()`                                                       | The account's name, to ask for when making or joining a space           |
| `useInviteLink()`                                                   | The invite this page was opened with, what it is for, and `dismiss`     |

```tsx
function Todos({ space }: { space: string }) {
  const node = useNode();
  const { result } = useQuery(space, { collection: todos, sort: { '@createdAt': 'asc' } });
  if (!result) return null;
  if (!result.complete && result.records.length === 0) return <p>Loading…</p>;
  return result.records.map((todo) => <Todo key={todo.key} todo={todo} />);
}
```

**An app given the whole account** sees every space in it. `useSpaces({ having: [proposal] })`
lists only the spaces that define those collections: the ones the app works in.
A space still being joined is kept, since its definitions haven't arrived yet.

**Names.** A name is whatever its owner typed, so two people can both be "Sam".
`useNames(space)` (or `displayName(did, profiles)` from `@weaveprotocol/core`)
adds the tail of the identity when a name is shared, and shows the tail alone
for someone with no profile.

**Invite links** carry the invite after `#`, which browsers never send to a
server. `inviteLink(invite)` makes one for this page, `inviteFromLink(text)`
takes the invite out of a pasted link, and `useInviteLink()` reads the one the
page was opened with:

```tsx
import { inviteLink, useInviteLink, useMyName, useNode } from '@weaveprotocol/core/react';

const link = inviteLink(await node.spaces.invite(space.id)); // https://app.example/#invite=…

function Invited({ onJoin }: { onJoin: (invite: string) => Promise<unknown> }) {
  const { invite, preview, dismiss } = useInviteLink();
  const me = useMyName();
  if (!invite || !preview) return null;
  return (
    <button
      onClick={() =>
        void me
          .save()
          .then(() => onJoin(invite))
          .then(dismiss)
      }
    >
      Join {preview.space.name}
    </button>
  );
}
```

`result.complete` is false while an app that holds only part of a space is
still fetching a collection. Show "Loading…", not "Nothing here".

## Live messages

For things that should reach whoever is connected now and be kept nowhere,
like typing or presence:

```typescript
await node.spaces.send(space.id, { type: 'typing' });
node.subscribe((event) => {
  if (event.type === 'message') console.log(event.from, event.message); // from: the sender's account
});
```

At most 64 KB each. Someone who isn't connected misses it.
