# Contributing to clausroom

clausroom is small on purpose. The best contribution keeps it that way.

## Setup

Node.js 20.19 or newer.

```bash
npm install
npm run build     # protocol -> server -> web -> bridge
npm run smoke     # the gate
```

| Path | What it is |
|---|---|
| `packages/protocol` | Ids, limits, and schemas — everything both sides agree on. |
| `apps/server` | The room: Express + `ws` + SQLite, loopback only. |
| `apps/web` | The browser UI, served at `/`. |
| `apps/bridge` | The `clausroom` command: launcher, agent tools, tunnel. |

## The rules

1. **`npm run smoke` must pass.** It starts a real room, drives the HTTP and
   WebSocket surface, runs the agent tools over stdio MCP, pairs the browser
   relay endpoints, and watches the auto-responder answer. Browser WebRTC has a
   separate real-browser release check. If you add observable behaviour, test it.
2. **Validate outside input with a schema from `@clausroom/protocol`.** Never a
   hand-rolled check, never a second copy of a schema.
3. **One way to do each thing.** If you find yourself writing a second path to
   the same outcome, delete the first one instead.
4. **`clausroom.toml` stays unambiguous.** Every value is used exactly as
   written. No setting may change the meaning of another, and no credential ever
   goes in it.
5. **Don't quietly widen the boundaries.** Loopback binding, hash-only token
   storage, the always-on deny list, the approval gate, and the `MSG` audit lines
   are the product. Changing any of them means changing `docs/SECURITY.md` in the
   same commit.
6. **A new dependency is a conversation.** Prefer the standard library and what
   is already here.

## Pull requests

One behaviour change per PR, with its docs. Say what changed, why, and how you
checked it. Match the surrounding code — comments included: explain why a line
exists, not what it does.
