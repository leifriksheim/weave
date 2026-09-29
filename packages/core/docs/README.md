# Building on Weave

Short guides for building an app with `@weaveprotocol/core`. They ship in the
package, so they always match the version installed: an agent working in an
app's repository finds them at `node_modules/@weaveprotocol/core/docs/`.

The package README, one folder up, covers every module in depth. The protocol
itself (what goes over the wire, what is signed, what every peer checks) is
specified in `spec/` in the repository: https://github.com/leifriksheim/weave/tree/main/spec

## The model in ten lines

- An **account** is a seed the person keeps. Apps never need it.
- A **node** (`createNode`) is the whole stack in one object: it signs, stores,
  encrypts, checks and syncs. Everything below goes through it.
- A **space** is a shared place: its members, their roles, and its data.
  Private spaces are encrypted end to end.
- A **collection** is a named kind of record in a space, like `app.todo.item`.
  Its definition (a JSON Schema, links, rules) is stored in the space itself.
- A **record** is a signed JSON body with a key that stays the same across
  edits. Every edit is a new version.
- **Rules** say who may create, edit and delete, and **checks** what a
  record must be, citing other records as evidence. Every device checks every
  record that arrives against them, so there is no server to write.
- **Queries** are plain JSON: Mongo-style filters, sorting, paging, and
  `include` to follow links.

## Guides

| Guide                                            | Read it to                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| [building-an-app.md](building-an-app.md)         | Get a node: sign-in, the account home, React                      |
| [collections.md](collections.md)                 | Say what your data is and who may do what with it                 |
| [records-and-queries.md](records-and-queries.md) | Write, edit, delete, query and watch records                      |
| [screens-and-apps.md](screens-and-apps.md)       | Ship a small app inside a space, with no deploy                   |
| [agents.md](agents.md)                           | Let an agent read and write as the person, from a terminal or MCP |

## Reference

What the library does, in full. None of it is protocol: no peer checks it,
and another implementation may do it differently and still sync with this
one. Some of it is a convention apps share, like `std.*` bodies and direct
messages: an app that does it differently still syncs, but can't read what
the others wrote.

| Page                                       | Covers                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [node.md](node.md)                         | `createNode`: configuration, root signers and session notes, stores, holding spaces, following the account, events, the network, the app-side client, carriers and hosting, doors, React |
| [sign-in.md](sign-in.md)                   | `createWeaveAuth`: places, account stores, ways in, passkeys, staying signed in, pods, pairing, the account home's side                                                                  |
| [actions.md](actions.md)                   | The node's actions, and the CLI, MCP and WebMCP tools made of them                                                                                                                       |
| [query-format.md](query-format.md)         | The JSON query format: filters, operators, sort and cursor, include                                                                                                                      |
| [standard-library.md](standard-library.md) | Every `std.*` collection, and the conventions they follow                                                                                                                                |
| [direct-messages.md](direct-messages.md)   | `std.direct` and `node.direct`: text sealed for some members of a space                                                                                                                  |
| [apps-as-records.md](apps-as-records.md)   | `std.app`: the review, updates, notifications, compatibility, and how screens run                                                                                                        |
| [calls.md](calls.md)                       | Voice and video calls in a space: the `call.*` messages, ringing, joining, leaving                                                                                                       |
| [contacts.md](contacts.md)                 | `std.contact` and `std.contact-request`: the list, sealed requests, `node.contacts`                                                                                                      |
| [doors.md](doors.md)                       | Doors kept as records, and how a knock becomes a contact: `std.door`, `std.knock`, the answer                                                                                            |
| [spaces.md](spaces.md)                     | Role presets, invite defaults, key upkeep, profiles, the space manager                                                                                                                   |
| [storage.md](storage.md)                   | Pacing sync, the store in memory, storage adapters, IndexedDB, data folders, blob stores and mirrors                                                                                     |

## Rules of thumb

- Import only from the package's entry points: `@weaveprotocol/core`, and
  `/react`, `/session`, `/schemas`, `/elements`, `/calls` for those parts.
- Name your collections reverse-DNS style, `app.<yours>.<thing>`. `sys.*` is
  the protocol's own, and `std.*` is the shared library in `/schemas`.
- Check the standard library (`@weaveprotocol/core/schemas`) before defining a
  reaction, comment, tag, message, task or poll of your own. Using the same
  one is how two apps see each other's data.
- Never keep state outside records if other people should see it. Records are
  what syncs.
- A refused write throws with the reason in plain words. Show it, or check
  first with `node.records.can` and hide the button.
