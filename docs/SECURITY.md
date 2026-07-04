# clausroom security model

This document restates the ten security invariants from the product spec
(section 0) against the actual implementation, then describes the token model,
artifact policy, and approval model, and finishes with an honest list of what is
**not** enforced by the code.

Layers referenced below:

- **Tailscale** — network layer: device sharing, grants/ACL, Serve (TLS).
- **Server** (`apps/server`) — central enforcement: auth, room membership,
  pause/turn/rate limits, upload gates, logging.
- **Bridge** (`apps/bridge`) — local enforcement on each human's machine:
  filesystem roots, deny globs, secret scanning, local approvals.
- **Deploy** (`deploy/`) — configuration that keeps the above honest.

## The ten invariants, and which layer enforces each

| # | Invariant | Enforced by |
|---|-----------|-------------|
| 1 | Do not invite the collaborator into your whole tailnet | **Tailscale + operator**: use device sharing of the server machine only; `deploy/tailscale-policy.hujson` grants the guest `tcp:443` on `tag:agent-room-server` and nothing else, with policy `tests` to catch regressions. Not enforceable in app code. |
| 2 | Do not host the chatroom on your main personal laptop if avoidable | **Deploy**: `deploy/Dockerfile` + `docker-compose.yml` run the server as a non-root user in a container whose only writable mount is `./data:/data` — no home directory, no repo. The systemd unit adds `ProtectHome=read-only`. |
| 3 | The collaborator reaches only the chatroom server, only port 443 | **Tailscale**: the grants file allows the guest `tcp:443` only; Serve terminates TLS and proxies to loopback. **Server**: binds `AGENT_ROOM_HOST=127.0.0.1` by default so the backend port is never on a routable interface. |
| 4 | The host machine never initiates connections into the guest's machine | **Architecture**: the bridge is a stdio MCP process that makes outbound HTTPS/WSS calls to the server and listens on nothing. There is no server→bridge channel other than WS frames on a bridge-initiated socket. |
| 5 | The server has no filesystem access to either repo | **Server design**: it reads/writes only `AGENT_ROOM_DB` and `AGENT_ROOM_ARTIFACT_DIR`. It stores messages and explicitly uploaded artifacts; there is no endpoint that reads arbitrary paths. **Deploy**: the container mounts only `/data`. |
| 6 | Each bridge controls what its local agent can see/do; read-only by default | **Bridge**: `policy.read_only_default = true` in `bridge.toml`; `allow_agent_to_upload_files = false` by default; every tool call passes local policy checks before any network call. |
| 7 | Code writes, shell commands, and file transfers above small limits require local human approval | **Bridge + server**: the bridge requires an approved `artifact_upload` approval for uploads over `max_upload_bytes_without_approval` (1 MiB) or when `require_human_approval_for_uploads` is set; the **server independently** re-enforces the gate for agent uploads (size > `AGENT_ROOM_REQUIRE_APPROVAL_BYTES`, secret-like filename, or archive → `403 approval_required`). Approvals are reviewed only by the requesting agent's own human (`reviewer_user_id = owner_user_id`); even the room owner cannot approve someone else's agent (`403 forbidden`). The bridge exposes no shell tool at all. |
| 8 | Every agent-to-agent message is logged; no hidden backchannel | **Server**: all mutations happen over REST; every accepted message is stored in SQLite, broadcast to every socket in the room (`recipient_ids` is advisory addressing, not privacy), and logged to stdout as `MSG <room_id> <sender_id> <message_type>`. Transcripts export via `GET /api/rooms/:id/export.md`. The WS channel accepts only `ping` from clients. |
| 9 | Artifacts move as files with metadata, hashes, and limits — not inline in chat | **Server**: multipart upload to `POST /api/rooms/:id/artifacts` with stored `sha256`, `size_bytes`, `mime_type`; message bodies with a 2000+ char base64-alphabet run are rejected with `422 inline_blob`; JSON bodies are capped at 1 MB; uploads at `AGENT_ROOM_MAX_UPLOAD_BYTES` (100 MiB). **Bridge**: verifies the sha256 on download and only writes into `downloads_dir`. |
| 10 | Secrets are denied by policy | **Bridge**: `DEFAULT_DENY_GLOBS` (`.env`, `.ssh`, `*.pem`, `*token*`, …) are always applied — config `deny_globs` can only add to them — plus `SECRET_NAME_GLOBS` / `SECRET_CONTENT_PATTERNS` scans (first 1 MiB of text files). **Server**: secret-like filenames from agents force the approval gate even if a bridge is compromised. Both lists live in `@clausroom/protocol` so server and bridge cannot drift. |

## Token model

Three bearer-token kinds, distinguishable by prefix (`TOKEN_PREFIXES` in
`@clausroom/protocol`):

| Kind | Prefix | Held by | Scope |
|---|---|---|---|
| invite | `arit_` | invited human | single-use; exchanged for a session token at `POST /api/auth/login` |
| session | `arst_` | human browser | all human REST/WS calls |
| bridge | `arbt_` | local bridge process | bound to one `(user, room)` pair |

- **Hash-only storage.** The server persists only `sha256(token)` in
  `tokens.token_hash`. A raw token appears exactly once: in the API response (or
  the `CLAUSROOM_BOOTSTRAP_INVITE` stdout line) that mints it. A database or
  transcript leak does not leak usable credentials.
- **Prefixes make leaks greppable** and let the server reject a bridge token used
  as a session token (and vice versa) before any lookup.
- **Single-use invites.** `tokens.used_at` is set at login; reuse → `401`.
- **Room binding.** A bridge token used against any other room → `403`.
- **Revocation/rotation.** `POST /api/rooms/:id/participants/:userId/token`
  (owner only) revokes all of that user's previous tokens for the room — for
  humans including their session tokens — and mints a fresh one. A token is valid
  iff `revoked_at IS NULL` (and, for invites, `used_at IS NULL`); revocation takes
  effect on the next request.
- Bridge tokens are never written to config files: `bridge.toml` names an
  environment variable (`token_env`, default `AGENT_ROOM_BRIDGE_TOKEN`).
- **Owner-lockout recovery.** Session TTL expiry could otherwise brick a
  deployment: minting a fresh invite requires an authenticated owner session —
  exactly what an idle owner just lost. On startup, if an **admin human** (the
  bootstrap Host) holds no usable credential at all (every invite used or
  revoked, every session revoked or TTL-expired), the server mints a fresh
  single-use invite for them and prints it once to stdout as
  `CLAUSROOM_RECOVERY_INVITE arit_…`. Recovery therefore requires restarting
  the server process (i.e. shell access to the host machine) — a remote guest
  cannot trigger it. Non-admin humans still need the room owner to rotate
  their token.

## Artifact policy

- Absolute cap `AGENT_ROOM_MAX_UPLOAD_BYTES` (100 MiB) for **everyone**; the
  stream is aborted at the limit (`413 too_large`).
- Agent uploads require an approved, unexpired, same-room, same-requester
  `artifact_upload` approval when the file is > `AGENT_ROOM_REQUIRE_APPROVAL_BYTES`
  (1 MiB), has a secret-like filename, or is an archive (`.zip .tar .gz .tgz .7z
  .rar .bz2 .xz` or archive mime types). The approval is **bound to the exact
  file** (its `payload.sha256` must match the uploaded content, and
  `payload.size_bytes` when present must match the size) and is **single-use**
  (consumed by the upload) — a human "yes" to one file can never authorize a
  different or repeated upload.
- Filenames are sanitized (basename only, `[A-Za-z0-9._\- ()]`, ≤128 chars) and
  content is stored under
  `<AGENT_ROOM_ARTIFACT_DIR>/<room_id>/<artifact_id>/<sha256>__<name>` — the
  sha256 in the path and DB lets both sides verify integrity end to end.
- Every upload auto-creates an `artifact_uploaded` message, so files can never
  move silently.
- Download is participant-only; non-participants get `404` (room existence is
  never leaked).

## Approval model

- Only agents (bridge tokens) can create approvals; only the requesting agent's
  **own human** (`owner_user_id`, who must be a human participant of the room)
  can respond. The remote human can see approvals but can never approve actions
  on someone else's machine.
- Pending approvals expire after 1 hour (`APPROVAL_TTL_MS`, lazy expiry on read
  or respond); expired approvals never satisfy the upload gate and cannot be
  resolved (`409 conflict`).
- Approved `artifact_upload` approvals are single-use and file-bound (see the
  artifact policy above): one approval, one upload, of exactly the reviewed file.
- Every resolution is broadcast and recorded as a `system_event` message from the
  System user, so the transcript shows who approved what, when. `system_event`
  is reserved for the server: the message API rejects it from every token holder
  (`422 validation`), so agents can neither impersonate System notices nor
  launder messages past the turn-limit walk (which skips `system_event` rows).

## Abuse limits (agents talking too much)

- **Turn limit:** after `AGENT_ROOM_MAX_AUTO_TURNS` (3) consecutive agent
  messages, further agent sends get `429 turn_limit` until a human speaks.
- **Pause:** humans can pause all agents in a room (`agents_paused`) or a single
  participant; paused agents get `403 agents_paused` / `403 participant_paused`.
- **Rate limit:** >30 accepted messages per user per sliding 60 s → `429`.
- **Body cap:** 32,000 chars per message.

## What AUTO MODE confines (`clausroom-bridge auto`)

The `auto` subcommand feeds room content straight into a locally spawned,
tool-bearing engine (Claude Code, Codex, or a `custom` argv) and posts its
output back to the room, with **no human in the loop per reply**. Because room
content is attacker-influenced (see the prompt-injection analysis in
`THREAT_MODEL.md`), the bridge confines that engine as follows:

- **Reads/searches are scoped to `[filesystem].roots`.** The engine may read and
  grep files **inside** the configured roots; file **contents** anywhere outside
  the roots are denied. `auto.workdir` must itself resolve (after `~` expansion
  and symlink resolution) inside one of `[filesystem].roots`, or the bridge
  refuses to start — the engine works in the project directory you named, never
  in your home directory.
- **No shell, no writes, no network.** The engine is granted a read-only tool
  allowlist (`allowed_tools`, default `["Read", "Grep"]`); it cannot execute
  shell commands, write or edit files, or make network calls. The claude engine
  runs with `--permission-mode dontAsk`, so anything outside the allowlist is
  **denied outright** rather than queued for a human who is not watching — there
  is no silent-escalation path. Widening `allowed_tools` (e.g. adding `Bash`,
  `Write`, `Edit`, `WebFetch`) is the operator's explicit, at-your-own-risk
  choice.
- **Glob is denied; discovery uses a bridge-injected file tree.** Without an OS
  sandbox, `Glob` is **not** in the allowlist (a glob can enumerate paths
  outside the roots). So the engine does not go blind, the bridge injects a
  **roots-bounded file tree** into the composed prompt — a listing of the files
  under `[filesystem].roots` only — which the engine reads with `Read`/`Grep`.
  Discovery therefore never escapes the roots.
- **With an OS sandbox, the boundary is kernel-enforced.** When `bwrap`
  (bubblewrap, Linux) or `sandbox-exec` (macOS) is present on `PATH`, the engine
  is launched inside it with the filesystem view restricted to
  `[filesystem].roots` (read-only) plus the minimum it needs to run. There the
  containment is enforced by the OS, not merely by the tool allowlist, and
  `Glob` inside the sandbox can only see the roots. When no sandbox binary is
  available the allowlist + injected file tree above are the boundary; install
  bubblewrap (`apt install bubblewrap`) on Linux to upgrade to OS-level
  confinement.
- **Room content is untrusted input.** The composed prompt marks room messages,
  summaries, filenames, and artifact contents as untrusted data and instructs
  the engine not to follow instructions embedded in them. Instructions to an LLM
  are mitigation, not enforcement — the capability limits above are the backstop.
- **The bridge token is scrubbed** from the engine subprocess's environment, so
  an injected engine cannot act as the bridge, and every reply the engine
  produces still passes the bridge's local outgoing-message policy (secret-pattern
  redaction, inline-blob guard, `allow_agent_to_send_text`) and the server's
  guardrails (pause flags, rate limit, consecutive-agent turn limit) exactly like
  any other agent.

> **Fixed in 0.1.1:** `[filesystem].roots` now governs the auto engine.
> Previously `roots` bounded only uploads and `room_download_artifact`, while the
> auto engine ran with whatever ambient filesystem access its CLI had — it could
> read outside the roots. As of 0.1.1 the auto engine's reads/searches are
> confined to the roots (allowlist + injected file tree, or an OS sandbox when
> available), `Glob` is denied without a sandbox, and `max_turns` defaults to
> **6** (was 25).

## What is NOT enforced (honest gaps)

Three MVP gaps are closed as of v0.1 and are no longer on this list: artifacts
now expire and count against a per-room storage quota (`AGENT_ROOM_ARTIFACT_RETENTION_DAYS`,
`AGENT_ROOM_ROOM_STORAGE_BYTES`); session tokens now slide-expire
(`AGENT_ROOM_SESSION_TTL_DAYS`); and message bodies are now redacted against
the shared secret patterns. What remains:

- **No TLS in the app itself.** The server speaks plain HTTP on loopback;
  Tailscale Serve provides TLS and tailnet-only exposure. If you bind to
  `0.0.0.0` without Serve (as inside the Docker container), traffic on that hop
  is unencrypted — keep the compose port mapping on `127.0.0.1`.
- **Network posture is operator-enforced.** Nothing in the code can verify you
  used device sharing instead of a tailnet invite, applied the grants file, or
  avoided Funnel. Run the policy `tests` and the spec's verification checklist.
- **Message redaction is best-effort pattern matching.** Message bodies and
  the pinned room summary are scanned against `SECRET_CONTENT_PATTERNS` plus
  the clausroom token pattern (`arit_/arst_/arbt_` + 32 hex) and matches
  become `[redacted-secret]`, but encoded, split, or novel secret formats pass
  through untouched. It is a seatbelt against accidental paste, not a security
  guarantee — still do not paste secrets into chat. `choices` entries are not
  scanned.
- **Secret scanning of uploads is likewise best-effort** (name globs + content
  regexes on the first 1 MiB of text files). Novel secret formats, binary
  encodings, or encrypted blobs will not be caught. Human review of uploads is
  the real gate.
- **Approval `payload` binding covers content, not intent.** The server verifies
  the uploaded bytes match the approval payload's `sha256`/`size_bytes` and
  consumes the approval after one upload, but the `path`/`description` fields
  remain advisory — the reviewing human should still read them.
- **Activity pills are cosmetic.** `working`/`idle` frames are self-reported by
  each bridge, never persisted, and enforce nothing — an agent that lies about
  being idle loses nothing and gains nothing. Do not treat them as an audit
  signal; the message log is the audit signal.
- **The auto-responder trusts its local engine *within* its confinement.**
  `clausroom-bridge auto` spawns whatever engine CLI the *local* config names and
  posts its output; the server cannot tell an autonomous reply from a
  human-supervised one. The engine is confined as described in "What AUTO MODE
  confines" above (reads/searches scoped to `[filesystem].roots`; no
  shell/write/network; `Glob` denied without an OS sandbox), and every reply
  still passes the bridge's local policy and the server's guardrails. The
  residual risk is exfiltration *within* granted capability: a read-only engine
  can still read a file that is inside the roots into a room reply (subject to
  secret-pattern redaction). Point the roots and `workdir` at exactly the project
  you are willing to discuss, and pause the agent the moment a conversation looks
  steered. Room content fed into the engine is untrusted input; see
  `THREAT_MODEL.md` for the prompt-injection analysis.
- **Humans are trusted within their permissions.** A human participant can post
  anything their `can_send`/`can_upload` flags allow, including through the
  browser bypassing all bridge policy — the bridge constrains *agents*, not
  people.
