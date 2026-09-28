# Screens and apps

A space can grow its own tools without anyone deploying anything. An **app**
is a record that proposes some collections. A **screen** is a small UI that
travels on a collection definition.

## Apps: proposing collections

```typescript
import { proposeApp, reviewApp, addApp } from '@weaveprotocol/core/schemas';

const proposal = await proposeApp(node, space.id, {
  title: 'Chores',
  description: 'Who does what around the house this week.',
  needs: [
    {
      name: 'app.chores.task',
      title: 'Chore',
      schema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, done: { type: 'boolean' } },
        required: ['title'],
      },
      rules: { delete: 'creator' },
    },
  ],
});

// Someone allowed to define collections reads what it would do, then adds it
const review = reviewApp(proposal.body!, await node.collections.list(space.id));
await addApp(node, space.id, proposal.key);
```

- A proposal is one `std.app` record. Nothing is defined yet, so it can't
  break anything.
- `reviewApp` says, per collection, whether it is new, a change, or the same,
  with a summary in sentences worked out from its rules. Show that to the
  person before they add it.
- `addApp` defines each collection, signed by whoever adds it. They need the
  `define` permission in the space.
- An agent can propose but never add: every peer ignores definitions signed
  under an agent's note.
- At most 10 collections per app.
- To change an app, propose a new one with `updates: <its key>`. Until the
  update is added, the old one stays in use; after, `supersededApps` names the
  old one, and `addApp` refuses it, since adding it would undo the update.

## Screens: a UI on a collection

A definition may carry `screen`: one HTML document, scripts and styles inline,
at most 48 KB. Apps that show the space can run it instead of plain lists.

It runs sealed: no network, no storage, no popups, no `alert`, `confirm` or
`prompt`, no libraries or fonts from URLs. Forms work, but go nowhere: handle
`submit`, call `preventDefault()` and save with `weave.put`. It reaches
records only through `window.weave`, as the person looking, so every rule
still holds and a screen can do nothing its viewer couldn't.

```html
<ul id="list"></ul>
<form id="add"><input name="title" required /><button>Add</button></form>
<script>
  const list = document.getElementById('list');
  async function draw() {
    const chores = await weave.list({ collection: 'app.chores.task' });
    list.replaceChildren(
      ...chores.map((chore) => {
        const item = document.createElement('li');
        item.textContent = chore.body.title + (chore.body.done ? ' ✓' : '');
        item.onclick = () => weave.update(chore.key, { ...chore.body, done: !chore.body.done });
        return item;
      }),
    );
  }
  document.getElementById('add').onsubmit = async (event) => {
    event.preventDefault();
    await weave.put('app.chores.task', { title: event.target.title.value });
    event.target.reset();
  };
  weave.onChange(draw);
  draw();
</script>
```

`window.weave`:

|                                                     |                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `weave.me`                                          | `{ did, name }`: who is looking                                                |
| `weave.collections`                                 | The collection names this screen may use (its app's)                           |
| `await weave.list({ collection, where })`           | Records, oldest first. `where: { "link:<rel>": key }` or `{ field: value }`    |
| `await weave.get(key)`                              | One record, or null                                                            |
| `await weave.put(collection, body, { links, key })` | Writes a record as the person looking                                          |
| `await weave.update(key, body, { links })`          | The next version                                                               |
| `await weave.remove(key)`                           | Deletes                                                                        |
| `await weave.people()`                              | `[{ did, name }]` of the space                                                 |
| `weave.onChange(callback)`                          | Called when records change, here or on another device. Returns a stop function |

Each record is `{ key, collection, body, links, createdBy, createdAt, updatedAt, mine, viaAgent }`.

- Keep all state in records and redraw on `onChange`. Other people's changes
  arrive that way.
- Two people can write at once. Let the collection's rules settle clashes
  (`onePer`, creator-only edits), not the screen.
- A refused write rejects with the reason. An error the screen doesn't catch
  is shown to the person.
- The full guide an agent is given is exported as `SCREEN_GUIDE` from
  `@weaveprotocol/core/schemas`.

## Hosting screens in your app

To show screens, run them in an `<iframe sandbox="allow-scripts allow-forms">`
whose page removes network access and form targets (a strict
Content-Security-Policy with `form-action 'none'`), and hand it a
message port to a bridge:

```typescript
import { createScreenBridge, screenDocument } from '@weaveprotocol/core/schemas';

const channel = new MessageChannel();
const bridge = createScreenBridge({ node, spaceId, collections, port: channel.port1 });
frame.contentWindow.postMessage(
  { weave: 'load', document: screenDocument(screen), me: { did: node.did, name }, collections },
  '*',
  [channel.port2],
);
// bridge.close() when the frame goes away
```

The page inside the frame writes the document it is given, with `window.__weave`
set to `{ port, me, collections }` first. The Weave example app's frame page,
`apps/example/public/screen.html`, and `apps/example/src/components/apps/ScreenFrame.tsx`,
in the repository, show the whole thing.
