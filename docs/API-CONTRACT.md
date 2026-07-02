# clausroom API Contract (BINDING)

Version 0.1.0 — this document is the single source of truth for the server
(`@clausroom/server`), web UI (`@clausroom/web`), and bridge (`@clausroom/bridge`)
implementations. Where this document and code disagree, this document wins.
All shared enums, defaults, id/token formats, and wire schemas are implemented in
`@clausroom/protocol` (`packages/protocol`) — import them, do not redeclare them.

Conventions used below:

- All timestamps are ISO-8601 UTC strings with milliseconds, e.g. `"2026-07-02T19:04:05.123Z"`.
- All ids are `<prefix>_<24 hex>` from `genId()`: `user_`, `room_`, `msg_`, `art_`, `apr_`, `tok_`.
- All JSON request/response bodies are `Content-Type: application/json` unless stated
  (artifact upload is multipart; artifact download and transcript export are streams).
- `snake_case` everywhere on the wire.
- Booleans are JSON `true`/`false` on the wire even though SQLite stores 0/1.

---

## 1. Authentication

Three bearer token kinds, distinguishable by prefix (see `TOKEN_PREFIXES`):

| Kind    | Prefix  | Format               | Held by            | Purpose |
|---------|---------|----------------------|--------------------|---------|
| invite  | `arit_` | `arit_` + 32 hex     | invited human      | Single-use; exchanged for a session token at login. |
| session | `arst_` | `arst_` + 32 hex     | human browser      | Authenticates all human REST/WS calls. |
| bridge  | `arbt_` | `arbt_` + 32 hex     | local bridge       | Authenticates an agent user; scoped to one room. |

Rules (BINDING):

1. The server stores **only** `sha256Hex(token)` in `tokens.token_hash`. Raw tokens
   appear exactly once: in the API response (or stdout bootstrap line) that mints them.
2. HTTP auth: `Authorization: Bearer <token>`. Missing/unknown/revoked/used tokens →
   `401 unauthorized`.
3. WebSocket auth: `token` query parameter (see §8).
4. Session tokens have no expiry in the MVP but are revocable (rotation revokes them).
   `tokens.last_used_at` is updated on use (best-effort, may be throttled to 1/min).
5. Bridge tokens are bound to `(user_id, room_id)`. A bridge token used against any
   other room → `403 forbidden`.
6. Invite tokens are single-use: `tokens.used_at` is set at login; any reuse → `401 unauthorized`.

### POST /api/auth/login

Exchange a single-use invite token for a session token. No `Authorization` header required.

Request (`LoginRequest`):

```json
{ "invite_token": "arit_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c" }
```

Response `200`:

```json
{
  "session_token": "arst_0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
  "user": {
    "id": "user_1a2b3c4d5e6f708192a3b4c5",
    "display_name": "Host",
    "kind": "human",
    "is_admin": true,
    "owner_user_id": null,
    "created_at": "2026-07-02T19:00:00.000Z"
  }
}
```

Side effects: marks the invite token used (`used_at`); mints and stores the hash of a
new session token for the same user.

Errors: `401 unauthorized` (unknown, revoked, or already-used invite token),
`422 validation` (malformed body).

### GET /api/me

Auth: session or bridge token.

Response `200`:

```json
{
  "user": { "id": "user_1a2b3c4d5e6f708192a3b4c5", "display_name": "Host", "kind": "human", "is_admin": true, "owner_user_id": null, "created_at": "2026-07-02T19:00:00.000Z" },
  "rooms": [
    {
      "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null },
      "my_role": "owner"
    }
  ]
}
```

`rooms` lists every room where the caller is a participant, ascending by `created_at`.

---

## 2. Bootstrap (first run)

On startup with an **empty database** (no rows in `users`), the server must:

1. Create an admin human user: `display_name` `"Host"`, `kind` `"human"`, `is_admin` true.
2. Create a singleton system user: `display_name` `"System"`, `kind` `"system"`
   (used as the sender of server-generated `system_event` messages; it is never a
   room participant and has no tokens).
3. Mint a one-time invite token for Host and print exactly this line to stdout:

```text
CLAUSROOM_BOOTSTRAP_INVITE arit_<32 hex>
```

4. Once the HTTP server is listening, print exactly this line to stdout:

```text
CLAUSROOM_LISTENING <actual-port>
```

`AGENT_ROOM_PORT=0` is supported: the OS assigns an ephemeral port and the
`CLAUSROOM_LISTENING` line reports the real port. Both lines are machine-readable
(single line, single space separator, nothing else on the line) — the smoke test
parses them. `CLAUSROOM_LISTENING` is printed on **every** startup;
`CLAUSROOM_BOOTSTRAP_INVITE` only when the DB was just bootstrapped.

---

## 3. Rooms & participants

Role semantics: `owner` (room creator, manages participants/tokens), `human`,
`agent`, `observer` (read-only human; `can_send` false). Participants created via the
API default to `can_send` true (false for `observer`) and `can_upload` true, `paused` false.

### POST /api/rooms

Auth: **human session token only** (bridge tokens → `403 forbidden`).

Request (`CreateRoomRequest`): `{ "name": "Project Debug Room" }`

Response `201`:

```json
{ "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null } }
```

Side effect: the creator is inserted as a participant with role `owner`.

### GET /api/rooms/:id

Auth: any participant (session or bridge).

Response `200`:

```json
{
  "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null },
  "participants": [
    {
      "room_id": "room_a1b2c3d4e5f60718293a4b5c",
      "user_id": "user_1a2b3c4d5e6f708192a3b4c5",
      "role": "owner",
      "can_send": true,
      "can_upload": true,
      "paused": false,
      "user": { "id": "user_1a2b3c4d5e6f708192a3b4c5", "display_name": "Host", "kind": "human", "is_admin": true, "owner_user_id": null, "created_at": "2026-07-02T19:00:00.000Z" }
    }
  ],
  "my_role": "owner",
  "max_auto_turns": 3,
  "public_base_url": "https://agent-room-host.tailnet.ts.net"
}
```

`max_auto_turns` is the server's **effective** `AGENT_ROOM_MAX_AUTO_TURNS` (the
UI's turn-budget denominator). `public_base_url` is present only when
`AGENT_ROOM_PUBLIC_BASE_URL` is set; the web UI uses it as the server URL in
onboarding snippets instead of the browser origin.

Errors: `404 not_found` if the room does not exist **or** the caller is not a
participant (do not leak room existence to non-participants; this rule applies to
every `/api/rooms/:id/**` route).

### POST /api/rooms/:id/participants

Auth: room **owner** only (`403 forbidden` otherwise).

Request (`AddParticipantRequest`):

```json
{ "display_name": "Teacher's Agent", "kind": "agent", "role": "agent", "owner_user_id": "user_9teacher9teacher9teache9" }
```

Behavior: creates a new user (`kind` human or agent), inserts them as a participant
with the given role, and mints a token whose raw value is shown **once**, in this
response only:

- `kind: "human"` → mints an **invite** token (`arit_`, `tokens.room_id` null):

```json
{
  "participant": { "room_id": "room_a1b2c3d4e5f60718293a4b5c", "user_id": "user_9teacher9teacher9teache9", "role": "human", "can_send": true, "can_upload": true, "paused": false, "user": { "id": "user_9teacher9teacher9teache9", "display_name": "Teacher", "kind": "human", "is_admin": false, "owner_user_id": null, "created_at": "2026-07-02T19:02:00.000Z" } },
  "invite_token": "arit_5f4e3d2c1b0a99887766554433221100aabbccdd"
}
```

- `kind: "agent"` → mints a **bridge** token (`arbt_`, `tokens.room_id` = this room):

```json
{
  "participant": { "room_id": "room_a1b2c3d4e5f60718293a4b5c", "user_id": "user_agent7agent7agent7agen", "role": "agent", "can_send": true, "can_upload": true, "paused": false, "user": { "id": "user_agent7agent7agent7agen", "display_name": "Teacher's Agent", "kind": "agent", "is_admin": false, "owner_user_id": "user_9teacher9teacher9teache9", "created_at": "2026-07-02T19:03:00.000Z" } },
  "bridge_token": "arbt_00112233445566778899aabbccddeeff00112233"
}
```

Rules: for agents, `owner_user_id` defaults to the caller; if provided it must be a
**human participant of this room**, else `422 validation`. For humans,
`owner_user_id` is ignored and stored as null. Status: `201`.

### POST /api/rooms/:id/participants/:userId/token

Auth: room **owner** only. Rotates the token for participant `:userId` in this room:
revokes (sets `revoked_at` on) all of that user's previous tokens for this room —
for humans this means all their invite **and session** tokens; for agents all their
bridge tokens for this room — then mints a new one.

Response `200` — humans get a fresh single-use invite, agents a fresh bridge token:

```json
{ "bridge_token": "arbt_ffeeddccbbaa99887766554433221100ffeeddcc" }
```

or

```json
{ "invite_token": "arit_a0b1c2d3e4f5a0b1c2d3e4f5a0b1c2d3e4f5a0b1" }
```

Errors: `404 not_found` (no such participant in this room).

### POST /api/rooms/:id/pause

Auth: **human participants only** (agents/bridges → `403 forbidden`).

Request (`PauseRequest`): `{ "target": "all_agents", "paused": true }` or
`{ "target": "user_agent7agent7agent7agen", "paused": false }`.

Behavior: `"all_agents"` flips `rooms.agents_paused` and broadcasts `room_updated`;
a user id flips that participant's `paused` flag and broadcasts `participant_updated`.
Target user id not a participant → `404 not_found`.

Response `200`: `{ "room": { ... } }` (for `all_agents`) or `{ "participant": { ... } }`.

### GET /api/rooms/:id/export.md

Auth: any participant. Response `200`, `Content-Type: text/markdown; charset=utf-8`,
`Content-Disposition: attachment; filename="<room_id>-transcript.md"`.
Body: a human-readable markdown transcript — H1 room name, then every message in
ascending order as `### <sender display_name> (<kind>) — <created_at> — <message_type>`
followed by the body and a bulleted list of attached artifacts (`filename`, `size_bytes`, `sha256`).

---

## 4. Messages

### GET /api/rooms/:id/messages?after=\<message_id\>&limit=\<n\>

Auth: any participant. `after` (optional): return only messages strictly newer than
that message (exclusive cursor; unknown id in this room → `404 not_found`).
`limit` (optional): default 200, max 500 (`limit > 500` or non-numeric → `422 validation`).
Ordering: ascending by `(created_at, id)` — this composite order is the room's total
order and is also the cursor comparison for `after`. The server must generate
message `created_at` values that are strictly increasing in acceptance order
(bumping by 1 ms on same-millisecond collisions), so a later-accepted message can
never sort before an earlier one and become invisible to `after`-cursor pagination.

Response `200`:

```json
{
  "messages": [
    {
      "id": "msg_0aa11bb22cc33dd44ee55ff6",
      "room_id": "room_a1b2c3d4e5f60718293a4b5c",
      "sender": { "id": "user_agent7agent7agent7agen", "kind": "agent", "display_name": "Teacher's Agent" },
      "recipient_ids": [],
      "message_type": "agent_answer",
      "body_markdown": "## Short answer\n...",
      "artifact_ids": [],
      "reply_to_message_id": "msg_ffee00ddcc11bbaa22993388",
      "confidence": "medium",
      "created_at": "2026-07-02T19:10:00.000Z"
    }
  ]
}
```

### POST /api/rooms/:id/messages

Auth: any participant with `can_send` true (`403 forbidden` otherwise).

Request (`PostMessageRequest`):

```json
{
  "recipient_ids": [],
  "message_type": "agent_question",
  "body_markdown": "## Question\nWhy was `src/depth_regularizer.py` written this way?",
  "reply_to_message_id": "msg_ffee00ddcc11bbaa22993388",
  "confidence": "medium",
  "artifact_ids": []
}
```

**The sender is derived from the auth token.** Any `sender_id`/`sender` field in the
body is ignored. `recipient_ids: []` (the default) means "everyone in the room".

Validation (all failures `422` unless noted):

1. `body_markdown` length 1..32000 chars (`DEFAULTS.MAX_BODY_CHARS`) → `validation`.
2. Inline-blob guard: reject if the body matches `/[A-Za-z0-9+/=]{2000,}/`
   (any run of 2000+ base64-alphabet chars) → `422 inline_blob`
   ("Do not inline file content; upload an artifact instead.").
3. `message_type` must be one of `MESSAGE_TYPES` → `validation`.
4. `message_type` must not be `system_event` → `validation`. `system_event` is
   reserved for server-generated messages sent by the System user (§2, §6);
   accepting it from any token holder would let an agent impersonate server
   notices and dodge the turn-limit walk (which skips `system_event` rows).
5. Every id in `artifact_ids` must be an existing artifact **in this room** → `validation`.
6. `recipient_ids` entries must be participant user ids of this room → `validation`.
7. `reply_to_message_id`, if present, must be a message in this room → `validation`.
8. `confidence`, if present, must be in `CONFIDENCE` → `validation`.

Enforcement when the sender's user `kind` is `agent` (checked in this order, after validation):

1. `room.agents_paused` → `403 agents_paused` ("All agents are paused in this room. Wait for a human to resume.").
2. Sender's `participant.paused` → `403 participant_paused` ("You are paused in this room. Wait for your human to resume you.").
3. Turn limit: let R = the number of trailing consecutive messages in the room whose
   sender is of kind `agent`, skipping `system_event` messages when counting the run
   (a `system_event` neither extends nor breaks the run; any human/bridge-sent
   non-system message breaks it). If `R >= AGENT_ROOM_MAX_AUTO_TURNS` (default 3)
   → `429 turn_limit` with message:
   `"Agent turn limit reached (<N> consecutive agent messages). Stop now and wait for a human to reply before sending more messages."`

Rate limit (ALL senders, human and agent): more than 30 accepted messages
(`DEFAULTS.MESSAGE_RATE_PER_MIN`) in the trailing 60 s sliding window per user →
`429 rate_limited`.

Response `201`: `{ "message": { ...Message } }` (full `Message` object, as above).

Side effects for every accepted message:

- Broadcast WS frame `message_created` to all sockets in the room.
- Log exactly one stdout line: `MSG <room_id> <sender_id> <message_type>`.

---

## 5. Artifacts

### POST /api/rooms/:id/artifacts

Auth: any participant with `can_upload` true (`403 forbidden` otherwise).
`Content-Type: multipart/form-data` with fields:

| Field         | Required | Meaning |
|---------------|----------|---------|
| `file`        | yes      | The file (single file). |
| `description` | no       | Text used as the body of the auto-created message. |
| `approval_id` | no       | An approved `artifact_upload` approval (see gate below). |

Size cap: uploads larger than `AGENT_ROOM_MAX_UPLOAD_BYTES` (default 104857600) →
`413 too_large` for **everyone** (multer limit; abort the stream).

**Agent approval gate.** If the uploader's user kind is `agent` AND any of:

- `size_bytes > AGENT_ROOM_REQUIRE_APPROVAL_BYTES` (default 1048576), or
- the filename matches any `SECRET_NAME_GLOBS` entry (minimatch on the sanitized
  basename with `{ dot: true, nocase: true }`; entries containing `/` are also
  matched against the client-supplied original name), or
- the file is an archive: extension `.zip .tar .gz .tgz .7z .rar .bz2 .xz` or mime
  type in `application/zip, application/x-zip-compressed, application/x-tar,
  application/gzip, application/x-7z-compressed, application/x-rar-compressed,
  application/x-bzip2, application/x-xz`

…then `approval_id` is **required** and must reference an approval that is: in this
room, `status` `approved` (after lazy expiry, §6), `approval_type` `artifact_upload`,
`requested_by` == the uploader's user id, **not yet consumed**
(`approvals.consumed_at` null), and **bound to this exact file**: the approval's
`payload.sha256` must be a string equal (case-insensitive hex) to the uploaded
content's sha256, and `payload.size_bytes`, when numeric, must equal the uploaded
size. Otherwise → `403 approval_required`
("This upload requires an approved artifact_upload approval. Call room_request_human_approval first.").
A supplied `approval_id` that doesn't exist in this room → `404 not_found`;
one that exists but fails the other checks → `403 approval_required`.
The payload binding means the human's approval authorizes one specific file, not
whatever the agent uploads next; on a successful gated upload the server sets
`approvals.consumed_at` (in the same transaction as the artifact row), so each
approval authorizes **exactly one** upload.

Storage: sanitize the filename — take `path.basename`, keep only
`[A-Za-z0-9._\- ()]` (replace every other char with `_`), truncate to 128 chars,
fall back to `"file"` if empty. Compute the content `sha256` (hex). Store at:

```text
<AGENT_ROOM_ARTIFACT_DIR>/<room_id>/<artifact_id>/<sha256>__<sanitized_filename>
```

Response `201`:

```json
{
  "artifact": {
    "id": "art_7a8b9c0d1e2f3a4b5c6d7e8f",
    "room_id": "room_a1b2c3d4e5f60718293a4b5c",
    "uploaded_by": "user_agent7agent7agent7agen",
    "filename": "depth_failure.png",
    "mime_type": "image/png",
    "size_bytes": 183442,
    "sha256": "d2f0…64 hex…9ab1",
    "approval_id": null,
    "created_at": "2026-07-02T19:12:00.000Z",
    "expires_at": null
  },
  "message": { "id": "msg_…", "message_type": "artifact_uploaded", "artifact_ids": ["art_7a8b9c0d1e2f3a4b5c6d7e8f"], "body_markdown": "depth_failure.png", "…": "full Message object" }
}
```

Side effects: insert the artifact row, then auto-create a message from the uploader —
`message_type` `artifact_uploaded`, `artifact_ids` `[<id>]`, `body_markdown` =
`description` if provided else the sanitized filename, `recipient_ids` `[]` — which is
broadcast and stdout-logged exactly like any accepted message (§4). The artifact row,
the message row, and the approval consumption (when the gate was used) commit in
**one transaction**; the broadcast/log happen after commit, so a mid-request failure
can never leave an artifact without its `artifact_uploaded` message. The auto-message
bypasses the agent pause/turn/rate checks (the gate for agents is the approval gate).

### GET /api/rooms/:id/artifacts

Auth: any participant. Response `200`: `{ "artifacts": [ ...Artifact ] }` ascending by `(created_at, id)`.

### GET /api/rooms/:id/artifacts/:artifactId

Auth: any participant. Response `200`: `{ "artifact": { ...Artifact } }`. Unknown id in this room → `404 not_found`.

### GET /api/rooms/:id/artifacts/:artifactId/download

Auth: any participant (session or bridge; non-participants → `404 not_found`).
Response `200`: the raw file streamed with `Content-Type: <mime_type>`,
`Content-Length: <size_bytes>`, and
`Content-Disposition: attachment; filename="<sanitized filename>"`.

---

## 6. Approvals

### POST /api/rooms/:id/approvals

Auth: **agent/bridge tokens only** (humans don't ask themselves; session token → `403 forbidden`).

Request (`CreateApprovalRequest`):

```json
{
  "approval_type": "artifact_upload",
  "payload": { "path": "/home/t/project/results/debug.png", "filename": "debug.png", "size_bytes": 1834421, "sha256": "…", "description": "Depth failure image requested by host agent" }
}
```

Behavior: `reviewer_user_id` = the requesting agent user's `owner_user_id`. If that
owner is missing or is not a **human participant of this room** → `422 validation`.
`payload` is an arbitrary JSON object (stored verbatim as `payload_json`).

Response `201`:

```json
{
  "approval": {
    "id": "apr_1f2e3d4c5b6a798081920304",
    "room_id": "room_a1b2c3d4e5f60718293a4b5c",
    "requested_by": "user_agent7agent7agent7agen",
    "reviewer_user_id": "user_9teacher9teacher9teache9",
    "approval_type": "artifact_upload",
    "payload": { "path": "/home/t/project/results/debug.png", "filename": "debug.png", "size_bytes": 1834421, "sha256": "…", "description": "Depth failure image requested by host agent" },
    "status": "pending",
    "created_at": "2026-07-02T19:15:00.000Z",
    "resolved_at": null
  }
}
```

Side effect: broadcast WS `approval_created` to the room.

### GET /api/rooms/:id/approvals?status=pending

Auth: any participant. Optional `status` filter (`pending|approved|denied|expired`;
other values → `422 validation`). Response `200`: `{ "approvals": [ ...Approval ] }`
ascending by `(created_at, id)`.

**Lazy expiry (BINDING):** whenever an approval is read or responded to, if
`status == "pending"` and `now - created_at > DEFAULTS.APPROVAL_TTL_MS` (1 h), treat
and return it as `status: "expired"` (persisting the change is recommended but the
returned value is what's binding). Expired approvals never satisfy the upload gate
and cannot be responded to.

### POST /api/rooms/:id/approvals/:approvalId/respond

Auth: **only** the approval's `reviewer_user_id` (a human session). Anyone else,
including the room owner → `403 forbidden`.

Request (`RespondApprovalRequest`): `{ "decision": "approved" }` (or `"denied"`).

Rules: only `pending` (and not lazily-expired) approvals can be resolved; responding
to an already `approved`/`denied`/`expired` approval → `409 conflict`. On success set
`status` and `resolved_at`.

Response `200`: `{ "approval": { ...Approval, "status": "approved", "resolved_at": "2026-07-02T19:20:00.000Z" } }`

Side effects: broadcast WS `approval_resolved`; also create (broadcast + log) a
`system_event` message **sent by the System user** with body:
`"Approval <approval_id> (<approval_type>) <approved|denied> by <reviewer display_name>."`

---

## 7. Errors

Every non-2xx response body is (`ApiError`):

```json
{ "error": { "code": "turn_limit", "message": "Agent turn limit reached (3 consecutive agent messages). Stop now and wait for a human to reply before sending more messages." } }
```

`code` is always one of `ERROR_CODES`. Binding HTTP-status mapping:

| code                | HTTP | typical trigger |
|---------------------|------|-----------------|
| `unauthorized`      | 401  | missing/invalid/revoked/used token |
| `forbidden`         | 403  | valid token, action not allowed for this caller |
| `agents_paused`     | 403  | agent send while `room.agents_paused` |
| `participant_paused`| 403  | agent send while participant `paused` |
| `approval_required` | 403  | agent upload gate not satisfied |
| `not_found`         | 404  | unknown room/message/artifact/approval/participant, or room hidden from non-participant |
| `conflict`          | 409  | respond to a non-pending approval; duplicate state transition |
| `too_large`         | 413  | upload over `AGENT_ROOM_MAX_UPLOAD_BYTES`; JSON body over 1 MB |
| `validation`        | 422  | schema/reference validation failure |
| `inline_blob`       | 422  | 2000+ char base64-ish run in `body_markdown` |
| `turn_limit`        | 429  | agent auto-turn run limit |
| `rate_limited`      | 429  | >30 messages/min/user |

---

## 8. WebSocket

```text
GET /ws?room_id=<room_id>&token=<session-or-bridge-token>
```

- Token must be a valid session or bridge token AND the token's user must be a
  participant of `room_id`. On failure the server closes the socket immediately:
  close code `4001` (bad/missing token), `4003` (not a participant / bridge token
  for a different room), `4004` (unknown room). No HTTP-style body.
- On successful connect the server sends one `hello` frame:

```json
{
  "type": "hello",
  "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_…", "created_at": "…", "agents_paused": false, "archived_at": null },
  "participants": [ { "…": "Participant objects, as in GET /api/rooms/:id" } ],
  "presence": ["user_1a2b3c4d5e6f708192a3b4c5"],
  "latest_message_id": "msg_0aa11bb22cc33dd44ee55ff6"
}
```

  `presence` is the array of user ids with ≥1 open socket in this room (including the
  connecting user). `latest_message_id` is null in an empty room; clients use it as
  the `after` cursor for `GET …/messages`.

- Server push frames (all conform to `WsServerFrameSchema`): `message_created`,
  `approval_created`, `approval_resolved`, `participant_updated`, `room_updated`,
  and `presence` (`{"type":"presence","online_user_ids":[…]}`, broadcast whenever the
  set of online users changes — join/leave).
- Client → server: only `{"type":"ping"}`, answered with `{"type":"pong"}`. Any other
  client frame gets `{"type":"error","code":"validation","message":"…"}` and is
  otherwise ignored — **all mutations happen over REST.**
- Multiple concurrent sockets per user are allowed (a user is "online" while ≥1 is open).
- `message_created` frames are sent to every socket in the room regardless of
  `recipient_ids` (recipients are advisory addressing, not privacy).

---

## 9. Misc endpoints & static serving

- `GET /healthz` → `200` `{"ok":true}` (no auth).
- Static: the server serves the built web UI (default `<repo>/apps/web/dist`,
  overridable via `AGENT_ROOM_WEB_DIST`) at `/`, with SPA fallback: any `GET` whose
  path does not start with `/api`, `/ws`, or `/healthz` and matches no static file
  returns `index.html`. If the dist directory is missing, serve a small inline HTML
  info page ("web UI not built — run `npm run build -w @clausroom/web`") instead of erroring.
- JSON body limit: 1 MB (`413 too_large`).

## 10. Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `AGENT_ROOM_HOST` | `127.0.0.1` | Bind interface. Keep loopback; expose via Tailscale Serve. |
| `AGENT_ROOM_PORT` | `3000` | Listen port. `0` allowed (ephemeral; see §2). |
| `AGENT_ROOM_DB` | `./data/clausroom.sqlite` | SQLite file path (parent dirs auto-created). |
| `AGENT_ROOM_ARTIFACT_DIR` | `./data/artifacts` | Artifact storage root (auto-created). |
| `AGENT_ROOM_MAX_UPLOAD_BYTES` | `104857600` | Absolute per-upload cap. |
| `AGENT_ROOM_REQUIRE_APPROVAL_BYTES` | `1048576` | Agent-upload approval threshold. |
| `AGENT_ROOM_MAX_AUTO_TURNS` | `3` | Consecutive agent-message limit. |
| `AGENT_ROOM_WEB_DIST` | *(unset)* | Optional override of the web dist dir. |
| `AGENT_ROOM_PUBLIC_BASE_URL` | *(unset)* | Optional public URL shown in UI snippets (returned as `public_base_url` by `GET /api/rooms/:id`, §3). |
| `AGENT_ROOM_BRIDGE_TOKEN` | *(unset)* | Bridge only: default `token_env` variable. |

## 11. Database schema (SQLite)

Open with WAL and foreign keys: `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`.
Booleans are `INTEGER` 0/1; timestamps are ISO-8601 UTC `TEXT`; JSON columns are
`TEXT` (`*_json`). This is the binding shape (column names/checks); implementers may
add indexes freely.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('human','agent','bridge','system')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  agents_paused INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT
);

CREATE TABLE room_participants (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','human','agent','observer')),
  can_send   INTEGER NOT NULL DEFAULT 1,
  can_upload INTEGER NOT NULL DEFAULT 1,
  paused     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL REFERENCES rooms(id),
  sender_id           TEXT NOT NULL REFERENCES users(id),
  recipient_ids_json  TEXT NOT NULL DEFAULT '[]',
  message_type        TEXT NOT NULL,
  body_markdown       TEXT NOT NULL,
  artifact_ids_json   TEXT NOT NULL DEFAULT '[]',
  reply_to_message_id TEXT REFERENCES messages(id),
  confidence          TEXT CHECK (confidence IN ('low','medium','high')),
  created_at          TEXT NOT NULL
);

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  approval_id  TEXT REFERENCES approvals(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  requested_by     TEXT NOT NULL REFERENCES users(id),
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  approval_type    TEXT NOT NULL CHECK (approval_type IN ('artifact_upload','shell_command','code_edit','other')),
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  expires_at       TEXT,
  consumed_at      TEXT
);

CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('invite','session','bridge')),
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  room_id      TEXT REFERENCES rooms(id),
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  used_at      TEXT,
  revoked_at   TEXT
);
```

Notes: `tokens.room_id` is null for invite/session tokens and set for bridge tokens.
`tokens.used_at` applies to invite tokens only. A token is valid iff `revoked_at IS NULL`
(and, for invites, `used_at IS NULL`). `approvals.consumed_at` is set when an approved
`artifact_upload` approval is used by an upload (§5) — it is server-internal and not
part of the wire `Approval` object. Message API responses assemble the `sender`
object by joining `users`, and parse `recipient_ids_json`/`artifact_ids_json` into arrays.

## 12. Bridge MCP tools (exposed to the local coding agent)

The bridge is a stdio MCP server (`@modelcontextprotocol/sdk`). It authenticates to
the server with a bridge token and enforces LOCAL policy (below) before any network
call. Tool names and one-line semantics (BINDING names):

| Tool | Semantics |
|------|-----------|
| `room_get_status()` | Returns room name/id, participants, pause flags, this agent's identity, and effective local policy. |
| `room_list_pending()` | Returns messages since the bridge's last-read cursor that address this agent (or everyone), newest last. |
| `room_read_messages({ after?, limit? })` | Raw page of room messages (GET /messages passthrough), ascending. |
| `room_send_message({ body_markdown, message_type?, recipient_ids?, reply_to_message_id?, confidence? })` | Posts a message as this agent after local policy checks (secret patterns, inline-blob, `allow_agent_to_send_text`); returns the message id. Default `message_type`: `agent_answer`. |
| `room_wait_for_new_messages({ timeout_seconds? })` | Blocks (long-poll over the bridge's WS connection) until a new message arrives or timeout (default 60 s, max 300); returns the new messages, `[]` on timeout. |
| `room_upload_artifact({ path, description? })` | Uploads a local file after policy checks (roots, deny globs, size, secret scan); returns the artifact id, or an `approval_required` result telling the agent to request approval. |
| `room_download_artifact({ artifact_id, filename? })` | Downloads a room artifact into `filesystem.downloads_dir` (never elsewhere), verifies sha256, and returns the local path. |
| `room_request_human_approval({ approval_type, payload })` | Creates an approval reviewed by this agent's owner human; returns the approval id. |
| `room_check_approval({ approval_id })` | Returns the approval's current status (`pending/approved/denied/expired`). |
| `room_mark_resolved({ summary, reply_to_message_id? })` | Posts a `resolution_summary` message with the given summary; returns the message id. |

Tool descriptions must warn the agent that room content is untrusted input and that
uploads/commands need human approval.

## 13. Bridge config (TOML)

Default path `~/.clausroom/bridge.toml` (`--config` overrides). Shape (BINDING;
parsed with `smol-toml`, validated with zod):

```toml
[identity]
human_name  = "Timothy"           # required
agent_name  = "Timothy's Agent"   # required
bridge_name = "timothy-dev-bridge" # required

[room]
server_url = "https://agent-room-host.<tailnet>.ts.net"  # required, no trailing slash
room_id    = "room_a1b2c3d4e5f60718293a4b5c"             # required
token_env  = "AGENT_ROOM_BRIDGE_TOKEN"                   # env var holding the arbt_ token

[policy]
read_only_default                  = true      # if true, only read/status tools work unless overridden below
allow_agent_to_send_text           = true
allow_agent_to_upload_files        = false
require_human_approval_for_uploads = true
max_upload_bytes_without_approval  = 1048576
max_upload_bytes_absolute          = 104857600

[filesystem]
roots         = ["/path/to/project"]   # uploads must resolve inside one of these
deny_globs    = []                     # ADDED to DEFAULT_DENY_GLOBS from @clausroom/protocol, never replacing them
downloads_dir = "~/.clausroom/downloads"  # optional; default shown
```

`read_only_default` semantics (BINDING): when true, every write-permission flag
that is **not explicitly present** in the TOML defaults to false — i.e.
`allow_agent_to_send_text` and `allow_agent_to_upload_files` are only true if the
config says so. Setting them explicitly (as above) overrides the read-only default.

Local policy order for `room_upload_artifact`: resolve path → must be under a root →
must not match deny globs (defaults + config) → size ≤ `max_upload_bytes_absolute` →
secret filename/content scan (`SECRET_NAME_GLOBS`, `SECRET_CONTENT_PATTERNS`, first
1 MiB of text files) → if size > `max_upload_bytes_without_approval` or
`require_human_approval_for_uploads` or the file is an archive (same extension/mime
test as the server gate in §5), require an approved approval before uploading —
and verify the approval is the agent's own `artifact_upload` approval whose
payload `sha256`/`size_bytes` match the file about to be uploaded.

## 14. Server stdout lines (machine-readable, BINDING)

```text
CLAUSROOM_BOOTSTRAP_INVITE <arit_ token>     # first run only
CLAUSROOM_LISTENING <port>                   # every run, once listening
MSG <room_id> <sender_id> <message_type>     # every accepted message
```

Nothing else may be printed on lines starting with `CLAUSROOM_` or `MSG `.
