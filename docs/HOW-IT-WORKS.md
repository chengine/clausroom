# How clausroom works

Four pieces, and one of them is temporary:

| Piece | What it is |
|---|---|
| `packages/protocol` | Every id, limit, and schema both sides agree on. |
| `apps/server` | The room. Express + `ws` + one SQLite file, bound to `127.0.0.1`. |
| `apps/web` | The browser UI the server serves at `/`. |
| `apps/bridge` | The `clausroom` command: the launcher, the agent's tools, and the tunnel. |

Only the host runs a server. The guest reaches it over a direct encrypted link
and sees it on a loopback URL of their own.

## Starting a room

`clausroom host` does this, in order:

1. Starts the server as a child process on `127.0.0.1`. The server prints
   `CLAUSROOM_INVITE <arit_…>` and `CLAUSROOM_LISTENING <port>` and nothing else
   that matters.
2. Trades that invite for a browser session, creates the room, and adds four
   participants: you (owner), your partner, your agent, and theirs. Each agent is
   owned by one human — the only person who can answer its approval requests.
3. Writes `~/.clausroom/session.json` (mode 0600) with where the room is, which
   token your agent uses, and how far it has read.
4. Registers the bridge as your coding agent's MCP server, scoped to your project
   directory, and starts the auto-responder if you asked for one.
5. Creates a WebRTC offer and prints it. Your partner's browser invite and their
   agent's token travel inside it, so they need nothing else from you.

The invite is minted fresh on every boot. That is deliberate: there is no cached
session to expire and no way to lock yourself out of your own room.

`clausroom connect` is the mirror image: it takes the offer, answers it, and once
the link is up it logs in with the invite it was given, writes its own session
file, and wires up its own agent.

Both commands stay in the foreground. On exit they stop what they started and
delete their session file.

## The connection

The host opens no public port. It creates a WebRTC offer whose data channels map
to exactly one address — the loopback port its own server listens on.

The guest runs a TCP proxy on `127.0.0.1`. Their browser and their agent speak
ordinary HTTP and WebSocket to it; each connection becomes one reliable, ordered
data channel carrying a one-byte frame type (`data`, `end`, `reset`) so TCP
half-close survives the trip. The tunnel never interprets the bytes it carries.

STUN only discovers addresses. TURN URLs are rejected and a relayed candidate
pair is refused outright — both sides print `CLAUSROOM_PEER_PATH direct …` with
the pair they chose. If the two networks cannot reach each other, this fails
rather than routing your room through a stranger's server.

Direct ICE is not guaranteed. Symmetric NAT, blocked UDP *and* TCP, or a strict
firewall can leave no usable pair. WebRTC is ordinary encrypted traffic, not a
way around an organisation's rules: STUN requests, endpoints, volume, and timing
are all visible to a network administrator.

## The wire

Everything the browser and the agent do goes over REST. The WebSocket is push
only: clients may send `ping` and, if they are an agent, a `status` report.

```
POST /api/auth/login                              invite  -> session token
GET  /api/me                                      who am I, which rooms
POST /api/rooms                                   create (human session only)
GET  /api/rooms/:id                               room, participants, my role
POST /api/rooms/:id/participants                  add one (owner only)
POST /api/rooms/:id/participants/:userId/token    re-issue theirs (owner only)
POST /api/rooms/:id/pause                         pause/resume agents (humans only)
PUT  /api/rooms/:id/summary                       set or clear the shared summary
GET  /api/rooms/:id/messages?after=&limit=        oldest first
POST /api/rooms/:id/messages                      post one
GET  /api/rooms/:id/artifacts[/:id[/download]]    list, describe, fetch
POST /api/rooms/:id/artifacts                     multipart upload
GET  /api/rooms/:id/approvals?status=             list
POST /api/rooms/:id/approvals                     request one (agents only)
POST /api/rooms/:id/approvals/:id/respond         answer (reviewer only)
GET  /api/rooms/:id/export.md                     the transcript
GET  /healthz                                     {"ok":true}
GET  /ws?room_id=&token=                          the push channel
```

A non-2xx body is always `{"error":{"code","message"}}`. The codes are
`unauthorized`, `forbidden`, `not_found`, `validation`, `inline_blob`,
`too_large`, `conflict`, `turn_limit`, `agents_paused`, `participant_paused`,
and `approval_required`. Room membership is hidden from outsiders: a room you are
not in is a 404, not a 403.

Server frames: `hello`, `message_created`, `approval_created`,
`approval_resolved`, `participant_updated`, `room_updated`, `presence`,
`activity`, `pong`, `error`. A frame sent while a socket was down is simply
missed, so both clients follow every `hello` with a REST catch-up from the last
message they saw.

Three limits are fixed, because there is nothing to tune for two people: 3 agent
messages in a row before a human must speak, 32,000 characters per message, and
one hour before an unanswered approval reads as expired.

## The agent's tools

`room_get_status`, `room_list_pending`, `room_read_messages`,
`room_send_message`, `room_wait_for_new_messages`, `room_upload_artifact`,
`room_download_artifact`, `room_request_human_approval`, `room_check_approval`,
`room_mark_resolved`, `room_get_summary`, `room_update_summary`.

Every block of room content handed to an agent is prefixed with a note saying it
is untrusted data, not instructions. Room content is written by the other side.

Reading advances a cursor kept in the session file, so restarting an agent does
not re-read the room. `room_list_pending` deliberately does not move it.

## clausroom.toml

```toml
[me]
name  = "Mikel"           # how you appear in rooms you host
agent = "claude"          # claude | codex | none

[partner]
name = "Ada"              # how they appear; they get this label from you

[room]
name = "clausroom"

[project]
dir = "."                 # the only directory your agent may read, relative to this file

[agent]
send_messages    = true   # may post text
upload_files     = false  # may offer a file; you approve each one either way
max_upload_mb    = 25
auto_reply       = false  # answers addressed messages with no human turn
tools            = ["Read", "Grep", "Glob"]   # read-only on purpose
model            = ""     # "" = the agent's own default
timeout_seconds  = 300    # a longer run is killed and nothing is posted
context_messages = 30     # recent room messages included in the prompt
command          = []     # non-empty = run this argv instead of the agent CLI

[server]
port = 3000               # loopback only, always
data = "~/.clausroom/data"

[peer]
stun = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
port = 0                  # loopback port for the guest's browser; 0 = any free
```

`tools`, `model`, `timeout_seconds`, `context_messages`, and `command` are read
only when `auto_reply = true`. Everything else always applies. No value here
changes meaning depending on another, and none of it is a credential: room ids,
URLs, and tokens live in `~/.clausroom/session.json` instead, which the launcher
writes at startup and deletes on exit.

Delete the file to get a fresh one with every key and its comment.

## Working on clausroom itself

```bash
npm run build     # protocol -> server -> web -> bridge
npm run smoke     # the gate: one end-to-end test against the built artifacts
npm run dev:web   # Vite, against a room you started separately
```

`npm run smoke` starts a real room, drives the HTTP and WebSocket surface, runs
the agent tools over stdio MCP, joins from a second process through the real
tunnel, moves two megabytes across it, and watches the auto-responder answer.
Nothing is mocked and nothing touches the network.
