# @weaveprotocol/relay

The signaling relay: a WebSocket server that introduces peers and never sees
their data. What it must do, and what a client may count on, is
[spec 04 §1](../../spec/04-network.md); this page is about running this one.

> Not protocol. Another relay may be run and configured differently and still
> work with every client.

## Running it

`signaling-server.mjs` wraps `createRelay` (from `relay.mjs`) in an HTTP
server. Every always-on node (`weave serve`, `weave run`, and the host) runs
the same relay on its own port, beside its `/peer` endpoint.

```bash
npm start            # node signaling-server.mjs, on port 8787
node signaling-server.mjs 9000
```

Configuration is by environment:

| Variable                       | Meaning                                                                    | Default                             |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------- |
| `PORT` (or first CLI argument) | listening port of `signaling-server.mjs`                                   | `8787` (`8080` in the Docker image) |
| `TURN_SECRET`                  | shared secret with coturn; TURN is off without it                          | —                                   |
| `TURN_URLS`                    | comma-separated TURN URLs handed out                                       | — (TURN off if empty)               |
| `TURN_TTL_SECONDS`             | password lifetime                                                          | `14400` (4 h)                       |
| `FLY_APP_NAME`                 | when set, the relay runs behind Fly's proxy and believes `Fly-Client-IP`   | —                                   |
| `TURN_PUBLIC_IP`               | coturn's external IP (`start.sh` only, which runs coturn beside the relay) | —                                   |

Only with `FLY_APP_NAME` set is a header believed for the client's address;
anywhere else the TCP peer address is used, since a header is whatever the
client says. Per-message compression is off (`perMessageDeflate: false`).

## TURN passwords

Passwords are minted as [spec 04 §1.7](../../spec/04-network.md) says, one per
network: every socket from one IPv4 address, or one IPv6 /64, shares a
username. A held one is reused while more than half its TTL remains, and a new
one is minted after that. So asking again is free, and coturn's per-user quota
caps a network rather than each request. IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
counts as the IPv4 address.

The limits the relay enforces, and what it does on each, are in
[spec 04 §1.6](../../spec/04-network.md); the values are the constants at the
top of `relay.mjs`.

_Source: `packages/relay/relay.mjs` (`createRelay`, `clientIp`, `turnFromEnv`, `offerTurn`, `networkOf`), `packages/relay/relay.d.mts`, `packages/relay/signaling-server.mjs`, `packages/relay/start.sh`, `packages/relay/fly.toml`, `packages/cli/src/serve.ts`. Tests: `packages/core/tests/relay-turn.test.ts`, `packages/cli/tests/cli.test.ts`._
