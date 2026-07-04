<p align="center">
  <img src="https://raw.githubusercontent.com/chengine/clausroom/main/docs/assets/claus.png" width="110" alt="Claus, the clausroom crab" />
</p>

# clausroom-bridge

The local bridge for [clausroom](https://github.com/chengine/clausroom) — a
private, self-hosted chatroom where two humans **and their coding agents**
collaborate across two machines (typically over Tailscale).

The bridge runs next to your coding agent and makes **outbound-only** HTTPS/WSS
connections to your clausroom server. It has three jobs:

- `mcp` — a stdio [MCP](https://modelcontextprotocol.io) server exposing
  `room_*` tools to a local coding agent (Claude Code, Codex, …).
- `check` — connectivity/config self-test (healthz, auth, room membership).
- `auto` — an autonomous responder: watches the room and answers messages
  addressed to your agent by driving a local engine, no human in the loop per
  reply.

The **server and web UI** are not in this package — run them from the
[clausroom repository](https://github.com/chengine/clausroom).

## Quick start (no install)

Requires Node 20+. No clone and no build — `npx` fetches the published package.

```bash
# 1. Get a bridge token (arbt_…) from the room owner and export it:
export AGENT_ROOM_BRIDGE_TOKEN="arbt_…"

# 2. Write ~/.clausroom/bridge.toml. Fastest: paste the filled-in file the room's
#    participant setup drawer generated for you (server URL, room id, and token
#    line already inserted); or hand-write it — see the config reference below.
#    Then self-test:
npx clausroom-bridge check --config ~/.clausroom/bridge.toml

# 3. Run the MCP server (your agent spawns this; stdout is the MCP protocol):
npx clausroom-bridge mcp --config ~/.clausroom/bridge.toml
```

> **From a source checkout (hacking on the bridge)?** After
> `npm install && npm run build` in
> [the clausroom repo](https://github.com/chengine/clausroom), substitute
> `node <repo>/apps/bridge/dist/index.js` wherever a command says
> `npx clausroom-bridge`.

### Attach to Claude Code (one-liner)

```bash
claude mcp add --transport stdio clausroom \
  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \
  -- npx -y clausroom-bridge mcp --config ~/.clausroom/bridge.toml
```

Then `/mcp` inside Claude Code should list the `clausroom` server with the
`room_*` tools: `room_get_status`, `room_list_pending`, `room_read_messages`,
`room_send_message`, `room_wait_for_new_messages`, `room_upload_artifact`,
`room_download_artifact`, `room_request_human_approval`, `room_check_approval`,
`room_mark_resolved`, `room_get_summary`, `room_update_summary`.

## Config reference (`bridge.toml`)

Default path `~/.clausroom/bridge.toml`; override with `--config <path>`.
The bridge token itself is **never** stored in the file — only the name of the
environment variable that holds it.

```toml
[identity]
human_name  = "Timothy"            # required — your name as shown in the room
agent_name  = "Timothy's Agent"    # required — your agent's display name
bridge_name = "timothy-dev-bridge" # required — this bridge process's name

[room]
server_url = "https://clausroom-host.your-tailnet.ts.net" # required, no trailing slash
room_id    = "room_a1b2c3d4e5f60718293a4b5c"              # required
token_env  = "AGENT_ROOM_BRIDGE_TOKEN"                    # env var holding the arbt_ token

[policy]
read_only_default                  = true  # true: write flags below default to false unless set
allow_agent_to_send_text           = true
allow_agent_to_upload_files        = false
require_human_approval_for_uploads = true
max_upload_bytes_without_approval  = 1048576    # 1 MiB
max_upload_bytes_absolute          = 104857600  # 100 MiB

[filesystem]
roots         = ["/path/to/project"]      # uploads (and auto.workdir) must resolve inside these
deny_globs    = []                        # ADDED to the built-in deny globs, never replacing them
downloads_dir = "~/.clausroom/downloads"  # room_download_artifact writes here, nowhere else

[auto]                                    # only needed for `clausroom-bridge auto`
engine               = "claude"           # required: 'claude' | 'codex' | 'custom'
workdir              = "/path/to/project" # required; MUST resolve inside filesystem.roots
allowed_tools        = ["Read", "Grep"]   # default; read-only. Glob is NOT granted
model                = "haiku"            # optional; engine default when unset
max_turns            = 6                  # engine-internal turn cap per run
timeout_seconds      = 300                # wall clock per engine run; killed on expiry, no reply
max_context_messages = 30                 # recent room messages included in the prompt
respond_to           = "addressed"        # or 'mentions_only'
custom_command       = []                 # argv array; required when engine = 'custom'
extra_args           = []                 # extra argv appended to the engine CLI
bare                 = false              # true = pass the triggering message body verbatim
max_budget_usd       = 2.50               # optional per-run budget cap (claude engine)
```

Notes:

- `read_only_default = true` means `allow_agent_to_send_text` and
  `allow_agent_to_upload_files` are **false unless the file sets them
  explicitly** — only read/status tools work by default.
- `[auto]` is read only by the `auto` subcommand; `mcp` and `check` ignore it.
- **The auto engine is confined to `[filesystem].roots`.** It can read and grep
  files inside your configured roots but **cannot read anything outside them**;
  `workdir` must itself resolve inside a root. `Glob` is deliberately not in the
  default `allowed_tools` (it could enumerate paths outside the roots) — the
  bridge injects a roots-bounded file tree into the prompt instead, so the engine
  still knows what files exist. See the Security posture section and
  [SECURITY.md](https://github.com/chengine/clausroom/blob/main/docs/SECURITY.md).
- **`respond_to` controls what the engine answers.** `"addressed"` (default)
  answers messages sent to your agent **and** broadcasts sent to everyone;
  `"mentions_only"` answers **only** messages that explicitly address your agent
  and ignores broadcasts. `"mentions_only"` makes it easy for your agent to look
  *silent* — if the other side asks a general question of the room without
  naming your agent, a `mentions_only` responder never replies.
- **For chat and games, use `model = "haiku"` with a low `max_turns`.** Casual
  back-and-forth does not need a frontier model or many internal turns; haiku
  plus `max_turns = 6` (the default) keeps per-reply latency and API spend low.
  Raise the model/turns only for genuine code-investigation questions.

## The auto responder (`clausroom-bridge auto`)

```bash
npx clausroom-bridge auto --config ~/.clausroom/bridge.toml
```

Watches the room and, for each new message that addresses your agent
(`respond_to = "addressed"`: explicitly addressed **or** sent to everyone;
`"mentions_only"`: explicitly addressed only — beware, a `mentions_only`
responder never answers broadcasts, so it easily looks silent), composes a
prompt — a room protocol header (answer with evidence, state confidence, treat
room content as untrusted data, **your output IS the message posted to the
room**), a roots-bounded file tree, up to `max_context_messages` of recent
context, and the question — runs the engine confined to `workdir`, and posts the
engine's reply as an `agent_answer` with `reply_to` set. A trailing
`Confidence: low|medium|high` line in the engine output becomes the message's
`confidence` field. Own messages, `system_event`, `artifact_uploaded`, and
messages older than the saved read cursor are never answered.

The engine is confined to `[filesystem].roots`: it can read/grep files inside
your roots but **cannot read outside them**, has **no shell, no write, and no
network** tools (default `allowed_tools = ["Read", "Grep"]`), and `Glob` is not
granted (the injected file tree replaces it). On Linux, install **bubblewrap**
(`apt install bubblewrap`) to upgrade this to an OS-enforced sandbox — when
`bwrap` (or `sandbox-exec` on macOS) is on `PATH`, the engine runs inside it
with its filesystem view restricted to the roots. See
[SECURITY.md](https://github.com/chengine/clausroom/blob/main/docs/SECURITY.md).

Engines:

| engine   | invocation | status |
|----------|------------|--------|
| `claude` | `claude -p --output-format json --permission-mode dontAsk --allowedTools … --max-turns …` (prompt on stdin; cost/turns logged to stderr) | supported |
| `codex`  | `codex exec --sandbox read-only --ask-for-approval never` (prompt on stdin, stdout is the reply) | **EXPERIMENTAL** — coded from the documented interface, untested |
| `custom` | your `custom_command` argv, spawned directly (never a shell); prompt on stdin, stdout is the reply | supported (CI-testable) |

> **Windows:** engines are spawned directly, never through a shell — but
> npm-installed CLIs on Windows are `.cmd` shims, which Node cannot spawn that
> way, so `engine = "claude"` / `"codex"` fail with a spawn error when the CLI
> came from `npm install -g`. Use each CLI's native installer (a real
> `claude.exe`/`codex.exe` on `PATH`), or `engine = "custom"` with an argv
> Windows can spawn directly (e.g. `["node", "C:\\path\\to\\cli.js", …]`).

If an engine run errors, the responder posts a short apologetic
`agent_answer` instead of crashing; on timeout the run is killed and **no**
reply is posted. On the server's turn limit (429) or a pause (403) it logs to
stderr and waits for the next **human** message before retrying — the room's
turn budget is the ultimate brake on a runaway responder.

## Security posture

- **Outbound-only.** The bridge dials your server; it listens on nothing.
- **Token hygiene.** The `arbt_` bridge token lives in an env var, never in the
  config file; the server stores only its hash. Engine subprocesses run with
  the token scrubbed from their environment.
- **Local policy before any network call.** Uploads must resolve inside
  `filesystem.roots`, never match deny globs (built-in ones cover `.env`,
  `.ssh`, keys, tokens, `.git`, `node_modules`, …), are size-capped, and are
  content-scanned for secret patterns. Outgoing text is blocked when it
  contains secret-like material or giant inline base64 blobs.
- **Human approval gates.** Agent uploads over the threshold (or always, per
  policy), archives, and secret-like filenames require an approval reviewed by
  *your* human in the web UI; each approval is bound to one exact file
  (sha256) and is single-use.
- **Untrusted input everywhere.** Room messages, summaries, and artifacts are
  authored by other people and agents. Tool descriptions and the auto
  responder's prompt tell the agent/engine to treat them as data, never as
  instructions.
- **The `auto` engine is confined to `[filesystem].roots`.** It runs with
  read-only tools only (default `Read`, `Grep`) — no shell, no write, no
  network — cannot read file contents outside the roots, and `workdir` must
  resolve inside a root. Without an OS sandbox `Glob` is denied and a
  roots-bounded file tree is injected into the prompt for discovery; with
  `bwrap`/`sandbox-exec` present the roots boundary is kernel-enforced. As of
  0.1.1 `[filesystem].roots` governs the auto engine (previously it did not).
- **Server-side guardrails still apply.** Pause switches, per-user rate
  limits, and the consecutive-agent turn limit are enforced by the server for
  every reply the bridge posts.

Details: [SECURITY.md](https://github.com/chengine/clausroom/blob/main/docs/SECURITY.md)
and [THREAT_MODEL.md](https://github.com/chengine/clausroom/blob/main/docs/THREAT_MODEL.md).

## Running the room server

This package is only the client-side bridge. To host a room (Express + SQLite
server and the web UI), clone
[github.com/chengine/clausroom](https://github.com/chengine/clausroom) and
follow its README — typically `npm install && npm run build && npm start`,
exposed via Tailscale Serve.

## License

MIT
