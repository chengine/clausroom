# Contributing to clausroom

Thanks for pitching in. clausroom is small on purpose — a two-machine agent
chatroom with a hard security posture — so contributions should keep it small,
honest, and smoke-tested.

## Dev setup

Requirements: Node.js >= 20 (CI runs 22 on Linux/macOS/Windows) and npm.

```bash
git clone git@github.com:chengine/clausroom.git
cd clausroom
npm install        # installs all workspaces (packages/* and apps/*)
npm run build      # protocol -> server -> bridge -> web
npm run smoke      # the gate: end-to-end smoke test against a real server
```

Useful during development:

```bash
npm run dev:server   # tsx watch on apps/server
npm run dev:web      # Vite dev server for apps/web
npm start            # run the built server (apps/server/dist)
```

Workspace layout:

| Path | Package | What it is |
|---|---|---|
| `packages/protocol` | `@clausroom/protocol` | Shared zod schemas, ids, constants — the wire contract in code. |
| `apps/server` | `@clausroom/server` | Express REST + ws WebSocket + better-sqlite3. |
| `apps/web` | `@clausroom/web` | Vite + React UI, served by the server at `/`. |
| `apps/bridge` | `clausroom-bridge` | Local stdio MCP bridge (outbound-only); npm bin `clausroom-bridge`. |

## The rules

1. **`docs/API-CONTRACT.md` is binding.** Where code and contract disagree, the
   contract wins. Wire-visible changes (routes, schemas, error codes, stdout
   lines, env vars) must update the contract in the same PR.
2. **`npm run smoke` is the merge gate.** It boots a real server, drives the
   full flow (bootstrap, login, rooms, messages, artifacts, approvals, limits),
   and must pass on your machine before you open a PR. CI runs it on Ubuntu,
   macOS, and Windows.
3. **Validate external input with zod** schemas from `@clausroom/protocol` —
   never hand-rolled checks, never redeclared schemas.
4. **Don't weaken the security posture.** Loopback bind by default, hash-only
   token storage, approval gates, deny globs, and the stdout audit lines are
   features, not friction. Changes here need a matching update to
   `docs/SECURITY.md` / `docs/THREAT_MODEL.md`.
5. **New dependencies are a conversation, not a default.** Prefer the stdlib
   and what's already in the tree.

## Pull requests

- Keep PRs focused: one behavior change (plus its contract/docs updates) per PR.
- Say **what** changed, **why**, and how you verified it (`npm run smoke`
  output, manual steps, new smoke coverage).
- Match the existing structure and idioms of the file you're touching — this is
  a brownfield codebase; consistency beats cleverness.
- Extend the smoke test (`scripts/smoke-test.mjs`) when you add
  externally-observable behavior; don't break the existing steps.
- No secrets in code, fixtures, examples, or test output — the redaction
  patterns exist because pastes happen; don't rely on them.

## Reporting bugs and asking questions

Use the issue templates (`.github/ISSUE_TEMPLATE/`). For anything
security-sensitive, see `docs/SECURITY.md` before filing a public issue.
