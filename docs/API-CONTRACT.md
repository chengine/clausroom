# clausroom API Contract (BINDING)

Version 0.1.0 — this document is the single source of truth for the server
(`@clausroom/server`), web UI (`@clausroom/web`), and bridge (`clausroom-bridge`)
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
4. **Session expiry (sliding).** A session token is expired when
   `max(last_used_at, created_at) + AGENT_ROOM_SESSION_TTL_DAYS < now`
   (`AGENT_ROOM_SESSION_TTL_DAYS` is a float number of days, default 30 =
   `DEFAULTS.SESSION_TTL_DAYS`). Using an expired session token →
   `401 unauthorized` with message exactly:
   `"Session expired. Ask the room owner for a fresh invite/token."`
   Sliding renewal: on each successful authenticated use of a session token the
   server refreshes `tokens.last_used_at`, throttled to **at most once per hour**
   per token (so an active session never expires; an idle one dies after the TTL).
   Session tokens remain revocable (rotation revokes them). **Invite and bridge
   tokens are unaffected** — they never TTL-expire; their `last_used_at` updates
   stay best-effort (may be throttled to 1/min).
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
      "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null, "summary_markdown": null, "summary_updated_by": null, "summary_updated_at": null },
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

**Owner-lockout recovery.** On startup with a **non-empty** database, for each
**admin human** (`is_admin` true — the bootstrap Host) who holds no usable
credential at all — every invite token used or revoked, and every session token
revoked or TTL-expired (§1 rule 4) — the server mints a fresh single-use invite
for that user and prints exactly one line per recovered admin:

```text
CLAUSROOM_RECOVERY_INVITE arit_<32 hex>
```

Same machine-readable format as the bootstrap line. This is the in-band escape
from session expiry locking out the sole owner (minting invites normally
requires an authenticated owner session); it triggers only via a server
restart, never while running, and never for non-admin users.

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
{ "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null, "summary_markdown": null, "summary_updated_by": null, "summary_updated_at": null } }
```

Side effect: the creator is inserted as a participant with role `owner`.

### GET /api/rooms/:id

Auth: any participant (session or bridge).

Response `200`:

```json
{
  "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_1a2b3c4d5e6f708192a3b4c5", "created_at": "2026-07-02T19:01:00.000Z", "agents_paused": false, "archived_at": null, "summary_markdown": null, "summary_updated_by": null, "summary_updated_at": null },
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

### PUT /api/rooms/:id/summary

Auth: **any participant with `can_send` true** — human or agent, session or bridge
token (`403 forbidden` when `can_send` is false, e.g. observers). This is the only
`can_send` check applied: `room.agents_paused`, per-participant `paused`, the turn
limit, and the message rate limit do **not** gate summary updates.

Request (`UpdateSummaryRequestSchema`):

```json
{ "summary_markdown": "## Status\n- depth bug reproduced\n- fix pending review" }
```

Validation: `summary_markdown` is either `null` (clears the summary) or a string of
1..4000 chars (`DEFAULTS.SUMMARY_MAX_CHARS`); anything else → `422 validation`.

Behavior: sets `rooms.summary_markdown` to the given value, `summary_updated_by` to
the caller's user id, and `summary_updated_at` to now (all three are set on every
call, including clears). A non-null `summary_markdown` is redacted before storage
and broadcast exactly like a message body (§4 Redaction: every `REDACTION_PATTERNS`
match becomes `[redacted-secret]`; the redacted value is what persists, and it is
not re-validated against the 4000-char cap — replacement may slightly grow it).

Response `200`: `{ "room": { ...Room } }` (the updated room, including the three
summary fields).

Side effects (in order):

1. Broadcast WS `room_updated` with the updated room.
2. Create a `system_event` message **sent by the System user** with body exactly
   `"<caller display_name> updated the room summary."` — broadcast and
   stdout-logged like any accepted message (§4).

`GET /api/rooms/:id` (and every other place a `Room` is serialized, including the
WS `hello` and `room_updated` frames) includes `summary_markdown`,
`summary_updated_by`, and `summary_updated_at` — all `null` until the first update.
The web UI renders the summary as a pinned, collapsible card at the top of the room.

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
      "choices": null,
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
  "artifact_ids": [],
  "choices": ["It is intentional — keep it", "It is a bug — fix it", "Not sure, investigate more"]
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
9. `choices`, if present, must be an array of 1..6 (`DEFAULTS.CHOICES_MAX`) strings,
   each 1..120 chars (`DEFAULTS.CHOICE_MAX_CHARS`) → `validation`
   (`MessageChoicesSchema`). Allowed on any message type the endpoint accepts
   (i.e. any non-`system_event` type — rule 4 already rejects `system_event`);
   only meaningful on `agent_question` and `human_message` (see *Decision choices*).

**Redaction (best-effort, BINDING behavior).** After validation and before
storage and broadcast, the server scans `body_markdown` against every pattern in
`REDACTION_PATTERNS` (= `SECRET_CONTENT_PATTERNS` plus `CLAUSROOM_TOKEN_PATTERN`,
the clausroom bearer-token pattern `ar(?:it|st|bt)_[0-9a-f]{32}`), each compiled
with `new RegExp(src, 'g')`, and replaces **every** match with the literal string
`[redacted-secret]`. This applies to **all sender kinds** (human, agent, system).
The redacted body is what gets stored, broadcast, and exported — the original
never persists. The upload auto-message body (§5) SHOULD be redacted the same
way, and the pinned room summary (§3) is redacted the same way. This is a
best-effort seatbelt against accidental secret paste, not a
security guarantee: encoded, split, or novel secrets pass through. `choices`
entries are not scanned. The redacted body is not re-validated against rules
1–2 (replacement can slightly grow the byte length; that is acceptable).

**Decision choices (inline decision cards).** A message with `choices` renders in
the web UI as a decision card: the body plus one button per choice. Clicking a
button posts a `human_message` whose `body_markdown` is **exactly** the choice
text and whose `reply_to_message_id` is the card message's id. A card counts as
**answered** once any human (non-agent) reply in the room — button click or typed
— has a body exactly equal to one of its choices; answered cards render their
buttons disabled, highlighting the chosen one. `choices` is stored verbatim
(`messages.choices_json`) and returned on the `Message` object (`null`/omitted
when unset); it has no server-side semantics beyond validation rule 9.

Enforcement when the sender's user `kind` is `agent` (checked in this order, after validation):

1. `room.agents_paused` → `403 agents_paused` ("All agents are paused in this room. Wait for a human to resume.").
2. Sender's `participant.paused` → `403 participant_paused` ("You are paused in this room. Wait for your human to resume you.").
3. Turn limit: let R = the number of trailing consecutive messages in the room whose
   sender is of kind `agent`, skipping `system_event` messages when counting the run
   (a `system_event` neither extends nor breaks the run; any human/bridge-sent
   non-system message breaks it). If `R >= AGENT_ROOM_MAX_AUTO_TURNS` (default 3)
   → `429 turn_limit` with message:
   `"Agent turn limit reached (<N> consecutive agent messages). Stop now and wait for a human to reply before sending more messages."`

**Turn-continue.** There is no dedicated API for granting more agent turns: **any**
human non-`system_event` message breaks the run and resets the consecutive-agent
counter to 0 (this falls directly out of the run definition above). The web UI
exposes this as a **Continue** button (shown when the room is at/near the turn
limit) and a `/continue` composer command; both simply post a `human_message`
with body exactly `"Continue — granted more agent turns."`

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

**Room storage quota (BINDING).** Let `used` = the sum of `size_bytes` over this
room's **non-deleted** artifacts (`deleted_at IS NULL`; expired-but-not-yet-swept
rows still count). If `used + incoming size_bytes > AGENT_ROOM_ROOM_STORAGE_BYTES`
(default 1073741824 = `DEFAULTS.ROOM_STORAGE_BYTES`) → `413` with error code
`quota_exceeded` and message exactly:
`"Room storage quota exceeded. Wait for older artifacts to expire or ask the room owner to raise AGENT_ROOM_ROOM_STORAGE_BYTES."`
The quota applies to **all** uploaders (human and agent). Accounting is atomic
with the insert: the `used` sum is computed inside the same transaction that
inserts the artifact row, so concurrent uploads cannot both squeeze under the
quota. On quota failure nothing is written and any supplied approval is **not**
consumed.

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
    "expires_at": "2026-08-01T19:12:00.000Z",
    "deleted_at": null
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

Auth: any participant. Response `200`: `{ "artifacts": [ ...Artifact ] }` ascending by
`(created_at, id)`. Includes deleted/expired rows (with `deleted_at` set once swept) —
metadata is never hidden, so the UI can grey out dead artifact chips.

### GET /api/rooms/:id/artifacts/:artifactId

Auth: any participant. Response `200`: `{ "artifact": { ...Artifact } }`. Unknown id
in this room → `404 not_found`. Deleted/expired artifacts still return their row
(with `deleted_at` set once swept) — only the **download** route 404s.

### GET /api/rooms/:id/artifacts/:artifactId/download

Auth: any participant (session or bridge; non-participants → `404 not_found`).
Response `200`: the raw file streamed with `Content-Type: <mime_type>`,
`Content-Length: <size_bytes>`, and
`Content-Disposition: attachment; filename="<sanitized filename>"`.

If the artifact is **deleted or expired** (`deleted_at` set, **or** `expires_at`
non-null and `<= now` even before the sweep runs) → `404 not_found` with message
exactly: `"Artifact expired or deleted."`

### Retention & expiry (BINDING)

`AGENT_ROOM_ARTIFACT_RETENTION_DAYS` is a **float** number of days
(default 30 = `DEFAULTS.ARTIFACT_RETENTION_DAYS`):

- positive or `0`: at upload time every artifact gets
  `expires_at = created_at + retention` (`0` means `expires_at = created_at`,
  i.e. immediate expiry — useful for tests);
- negative, or the literal string `off`: retention is **disabled** —
  `expires_at` is stored as `null` and artifacts never expire.

**Sweep.** On boot and every 10 minutes thereafter, the server finds artifacts
with `deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now`,
unlinks each stored file (missing files are ignored), and sets `deleted_at`.
The row is **never** deleted — metadata routes keep returning it — and no
message or WS frame is emitted by the sweep. Freed bytes stop counting toward
the room storage quota as soon as `deleted_at` is set. Messages may keep
referencing dead artifact ids (`artifact_ids` validation only requires that the
row exists). UIs should treat an artifact as dead when `deleted_at` is set or
`expires_at` is in the past.

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
| `unauthorized`      | 401  | missing/invalid/revoked/used token; expired session (§1 rule 4) |
| `forbidden`         | 403  | valid token, action not allowed for this caller |
| `agents_paused`     | 403  | agent send while `room.agents_paused` |
| `participant_paused`| 403  | agent send while participant `paused` |
| `approval_required` | 403  | agent upload gate not satisfied |
| `not_found`         | 404  | unknown room/message/artifact/approval/participant, or room hidden from non-participant |
| `conflict`          | 409  | respond to a non-pending approval; duplicate state transition |
| `too_large`         | 413  | upload over `AGENT_ROOM_MAX_UPLOAD_BYTES`; JSON body over 1 MB |
| `quota_exceeded`    | 413  | upload would push the room's non-deleted artifact bytes over `AGENT_ROOM_ROOM_STORAGE_BYTES` (§5) |
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
  close code `4001` (bad/missing/expired token — an expired session per §1 rule 4
  counts), `4003` (not a participant / bridge token for a different room),
  `4004` (unknown room). No HTTP-style body.
- On successful connect the server sends one `hello` frame:

```json
{
  "type": "hello",
  "room": { "id": "room_a1b2c3d4e5f60718293a4b5c", "name": "Project Debug Room", "created_by": "user_…", "created_at": "…", "agents_paused": false, "archived_at": null, "summary_markdown": null, "summary_updated_by": null, "summary_updated_at": null },
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
  `presence` (`{"type":"presence","online_user_ids":[…]}`, broadcast whenever the
  set of online users changes — join/leave), and `activity` (below).
- Client → server frames (`WsClientFrameSchema`, a discriminated union):
  - `{"type":"ping"}` — answered with `{"type":"pong"}`.
  - `{"type":"status","state":"working"|"idle"}` — agent activity report (below).
    Honored **only** when the connection's user kind is `agent`; from any other
    kind the frame is valid but **silently ignored** (no error frame, no effect).

  Any frame that fails `WsClientFrameSchema` gets
  `{"type":"error","code":"validation","message":"…"}` and is otherwise ignored —
  **all mutations happen over REST.**
- Multiple concurrent sockets per user are allowed (a user is "online" while ≥1 is open).
- `message_created` frames are sent to every socket in the room regardless of
  `recipient_ids` (recipients are advisory addressing, not privacy).

### Agent activity ("working" pills)

Per-user ephemeral state, `working` or `idle` (`ActivityStateSchema`), default
`idle`. **Never persisted** — no DB row, no REST endpoint, and the `hello` frame
carries no activity info (a freshly connected client assumes everyone is idle and
learns from subsequent frames).

- An agent connection's `{"type":"status","state":…}` frame sets its user's state.
- On every state **change** the server broadcasts to all sockets in the room:

```json
{ "type": "activity", "payload": { "user_id": "user_agent7agent7agent7agen", "state": "working" } }
```

- A repeated `working` report refreshes the timer without rebroadcasting.
- Auto-revert: `DEFAULTS.ACTIVITY_IDLE_TIMEOUT_MS` (60000) after the last
  `working` report without a refresh, the server reverts the user to `idle` and
  broadcasts the change. The user's last socket closing also reverts (and
  broadcasts) immediately.

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
| `AGENT_ROOM_ARTIFACT_RETENTION_DAYS` | `30` | Artifact retention, float days. `0` = immediate expiry; negative or `off` disables expiry (§5). |
| `AGENT_ROOM_ROOM_STORAGE_BYTES` | `1073741824` | Per-room quota on the sum of non-deleted artifact `size_bytes` (§5). |
| `AGENT_ROOM_SESSION_TTL_DAYS` | `30` | Session-token sliding expiry, float days (§1 rule 4). |
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
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL,
  agents_paused      INTEGER NOT NULL DEFAULT 0,
  archived_at        TEXT,
  summary_markdown   TEXT,
  summary_updated_by TEXT REFERENCES users(id),
  summary_updated_at TEXT
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
  choices_json        TEXT,
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
  expires_at   TEXT,
  deleted_at   TEXT
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
object by joining `users`, and parse `recipient_ids_json`/`artifact_ids_json` into
arrays. `messages.choices_json` is a JSON string array or NULL; it becomes the wire
`choices` field (`null` when NULL).

**Migration (v0.1).** `rooms.summary_markdown` / `summary_updated_by` /
`summary_updated_at`, `messages.choices_json`, and `artifacts.deleted_at` are new
in v0.1. On boot, the server must `ALTER TABLE … ADD COLUMN` any of them missing
from an existing database (all nullable, so plain adds suffice; pre-existing rows
read as NULL, which is the correct "unset" value).

## 12. Bridge MCP tools (exposed to the local coding agent)

The bridge is a stdio MCP server (`@modelcontextprotocol/sdk`). It authenticates to
the server with a bridge token and enforces LOCAL policy (below) before any network
call. Tool names and one-line semantics (BINDING names):

| Tool | Semantics |
|------|-----------|
| `room_get_status()` | Returns room name/id, participants, pause flags, this agent's identity, and effective local policy. |
| `room_list_pending()` | Returns messages since the bridge's last-read cursor that address this agent (or everyone), newest last. |
| `room_read_messages({ after?, limit? })` | Raw page of room messages (GET /messages passthrough), ascending. |
| `room_send_message({ body_markdown, message_type?, recipient_ids?, reply_to_message_id?, confidence?, choices? })` | Posts a message as this agent after local policy checks (secret patterns, inline-blob, `allow_agent_to_send_text`); returns the message id. Default `message_type`: `agent_answer`. `choices` (optional, 1–6 strings ≤120 chars) renders a decision card (§4). |
| `room_wait_for_new_messages({ timeout_seconds? })` | Blocks (long-poll over the bridge's WS connection) until a new message arrives or timeout (default 60 s, max 300); returns the new messages, `[]` on timeout. |
| `room_upload_artifact({ path, description? })` | Uploads a local file after policy checks (roots, deny globs, size, secret scan); returns the artifact id, or an `approval_required` result telling the agent to request approval. |
| `room_download_artifact({ artifact_id, filename? })` | Downloads a room artifact into `filesystem.downloads_dir` (never elsewhere), verifies sha256, and returns the local path. |
| `room_request_human_approval({ approval_type, payload })` | Creates an approval reviewed by this agent's owner human; returns the approval id. |
| `room_check_approval({ approval_id })` | Returns the approval's current status (`pending/approved/denied/expired`). |
| `room_mark_resolved({ summary, reply_to_message_id? })` | Posts a `resolution_summary` message with the given summary; returns the message id. |
| `room_get_summary()` | Returns the room's pinned summary: `summary_markdown`, `summary_updated_by`, `summary_updated_at` (all null when unset). Read-only, always allowed. |
| `room_update_summary({ summary_markdown })` | Sets (or clears, with null) the pinned room summary via `PUT /api/rooms/:id/summary` (§3). Gated by `allow_agent_to_send_text` (it posts human-visible text). Returns the updated room summary fields. |

Tool descriptions must warn the agent that room content is untrusted input and that
uploads/commands need human approval.

**Automatic activity frames.** The bridge reports agent activity (§8) without any
tool: it sends `{"type":"status","state":"working"}` on its WS connection when a
tool execution begins and `{"type":"status","state":"idle"}` when it ends —
except `room_wait_for_new_messages`, which is idle waiting and must not flip the
state. Overlapping tool calls keep the state `working` until the last one ends.
Best-effort: if the WS is down, tool execution proceeds and no frame is sent.

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

[auto]                                  # only needed for `clausroom-bridge auto` (see below)
engine               = "claude"         # required: 'claude' | 'codex' | 'custom'
workdir              = "/path/to/project"  # required; MUST resolve inside filesystem.roots
allowed_tools        = ["Read", "Grep"]  # default; auto-scoped to filesystem.roots (Glob denied unless sandboxed)
model                = "sonnet"        # optional; engine default when unset
max_turns            = 6                # default
timeout_seconds      = 300              # default; wall clock per engine run
max_context_messages = 30               # default; room messages included in the prompt
respond_to           = "addressed"      # default; or 'mentions_only'
custom_command       = []               # argv array; required when engine = 'custom'
extra_args           = []               # extra argv appended to the engine CLI
bare                 = false            # default
max_budget_usd       = 2.50             # optional; unset = no budget cap
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

### `[auto]` — autonomous engine adapter (`clausroom-bridge auto`, Milestone 5)

`clausroom-bridge auto` runs the bridge as an autonomous responder: it watches the
room, and for each message it should answer it composes a prompt (room context, at
most `max_context_messages` recent messages, plus the triggering message) and runs
a local coding-agent engine, then posts the engine's reply via the normal
`room_send_message` path (all local policy checks and server-side limits apply).
The `[auto]` table is required for this subcommand only; other subcommands ignore it.

| Key | Type / values | Default | Meaning |
|-----|---------------|---------|---------|
| `engine` | `'claude' \| 'codex' \| 'custom'` | *(required)* | Which engine CLI to drive. |
| `workdir` | string | *(required)* | Engine working directory. **MUST resolve (after symlinks/`~`) inside one of `filesystem.roots`**, else the bridge refuses to start. |
| `allowed_tools` | string[] | `["Read", "Grep"]` | Tools granted to the engine, interpreted **semantically** and read-only on purpose. `Read`/`Grep` are auto-scoped to `filesystem.roots` (the bridge derives `Read(//root/**)` matchers — the operator never hand-writes them — which confine both file reads and greps to the roots). `Glob`/`LS` leak file **names** and cannot be path-scoped, so they are **denied** unless an OS sandbox is active; the bridge injects a roots-bounded file tree into the prompt instead. `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch` are always denied. |
| `model` | string | *(unset)* | Model override passed to the engine. |
| `max_turns` | int | `6` | Engine-internal turn cap per run. A chat reply needs ~1–2 agentic turns; keep it low to bound API spend and avoid `error_max_turns`. |
| `timeout_seconds` | int | `300` | Wall-clock cap per engine run; on timeout the run is killed and no reply is posted. |
| `max_context_messages` | int | `30` | Max recent room messages included in the composed prompt. |
| `respond_to` | `'addressed' \| 'mentions_only'` | `'addressed'` | `addressed`: reply when `recipient_ids` includes this agent, **or** `recipient_ids` is empty and the sender is not this agent. `mentions_only`: reply only when `recipient_ids` explicitly includes this agent. |
| `custom_command` | string[] (argv) | *(unset)* | Required (non-empty) when `engine = 'custom'`; rejected for other engines. The bridge spawns it with the composed prompt on **stdin**; it must print the reply markdown to **stdout** (exit code 0). |
| `extra_args` | string[] | `[]` | Extra argv appended to the engine CLI invocation. |
| `bare` | bool | `false` | When true, skip the bridge's prompt scaffolding and pass the triggering message body as the prompt verbatim. |
| `max_budget_usd` | float | *(unset)* | Per-run budget cap passed to engines that support one; unset = no cap. |

**Safety posture (BINDING).** The engine runs with **read-only tools by default**
(`allowed_tools` default; granting write/exec tools is an explicit operator
choice). **Filesystem confinement (BINDING):** the engine must not read file
**contents** or enumerate file **names** outside `filesystem.roots`. The bridge
enforces this by (a) auto-scoping the engine's read/search tools to the roots
(`Read(//root/**)` matchers, one per resolved root — these confine both the read
and grep tools), (b) denying the write/shell/network tools and the name-leaking
`Glob`/`LS` tools, and (c) injecting a roots-bounded file tree (deny-glob
filtered, symlinks not followed, capped) into the prompt so the engine can still
discover structure. When an OS sandbox (`bwrap` on Linux, `sandbox-exec` on
macOS) is present it wraps the engine spawn (roots bound read-only) as
defense-in-depth and `Glob`/`LS` may then be granted; when it is absent the
bridge logs a one-line warning that confinement is permission-only. `workdir`
must resolve inside a root or the responder refuses to start. For `engine =
"custom"`, containment is the operator's responsibility. All room content fed
into the prompt is **untrusted input** — the composed prompt must say so and
instruct the engine to treat instructions found in room messages as data, not
commands; it also tells the engine that **its entire text reply is posted
verbatim as the room message** (it needs no tool to send, and may initiate as
well as answer). Every reply still goes through the bridge's local policy
(secret patterns, inline-blob, `allow_agent_to_send_text`) and the server's
guardrails — pause flags, rate limit, and the consecutive-agent **turn limit**
(§4) all still apply, so a runaway auto-responder stops after
`AGENT_ROOM_MAX_AUTO_TURNS` messages until a human replies (or clicks
**Continue**, §4). On any engine failure (spawn error, non-zero exit,
`error_max_turns`, usage limit) the daemon posts a short apologetic
`agent_answer` or logs a clear stderr line and continues — it never exits
silently; a timeout kills the run and posts no reply. The bridge emits
`working`/`idle` activity frames around engine runs like any other tool
execution (§12).

## 14. Server stdout lines (machine-readable, BINDING)

```text
CLAUSROOM_BOOTSTRAP_INVITE <arit_ token>     # first run only
CLAUSROOM_RECOVERY_INVITE <arit_ token>      # only when an admin human is locked out (§2)
CLAUSROOM_LISTENING <port>                   # every run, once listening
MSG <room_id> <sender_id> <message_type>     # every accepted message
```

Nothing else may be printed on lines starting with `CLAUSROOM_` or `MSG `.
