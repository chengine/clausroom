# Safe Agent-to-Agent Coding Chatroom: Implementation Blueprint

**Goal:** build a private chatroom where two humans and their coding agents can collaborate across two separate computers, while preventing either person from gaining direct access to the other's full machine, tailnet, repo, secrets, or agent memory.

This document is written as an implementation spec for a coding agent. It assumes the first implementation is a **local-first, self-hosted MVP** using:

- **Tailscale** for private networking.
- **A dedicated chatroom server machine/VM/container** controlled by the host.
- **A local bridge/MCP tool on each participant's machine** so each agent can send and receive room messages without exposing the whole computer.
- **Read-only defaults and explicit approval gates** for code edits, shell commands, file transfer, and artifact sharing.

---

## 0. Core security model

The safe design is:

```text
You + your coding agent bridge
        |
        | outbound HTTPS/WSS over Tailscale
        v
Dedicated chatroom server
        ^
        | outbound HTTPS/WSS over Tailscale
        |
Collaborator + collaborator coding agent bridge
```

### Security invariants

1. **Do not invite the collaborator into your whole tailnet as a general member.** Prefer Tailscale **device sharing** of only the chatroom server machine.
2. **Do not host the chatroom on your main personal laptop if avoidable.** Use a dedicated mini-PC, lab workstation, VM, or containerized service with minimal mounts.
3. **The collaborator should only reach the chatroom server, ideally only port `443` or `3000`.**
4. **Your machine should not initiate connections into the collaborator's machine.** The collaborator's local bridge makes outbound connections to the chatroom server.
5. **The chatroom server should not have direct filesystem access to either person's source repo.** It stores messages and explicit artifacts only.
6. **Each local bridge controls what its local agent can see and do.** Bridges are read-only by default.
7. **All code writes, shell commands, and file transfers above small limits require local human approval.**
8. **Every agent-to-agent message is logged.** No hidden backchannel.
9. **Artifacts are transferred as files with metadata, hashes, and retention policy, not embedded in chat messages.**
10. **Secrets are denied by policy.** Never allow `.env`, `.ssh`, API keys, credentials, tokens, private keys, or browser/session data to be uploaded by an agent automatically.

---

## 1. Roles and machines

### Host side: you

You operate:

```text
agent-room-host
  - Tailscale installed
  - Chatroom server running locally
  - SQLite/Postgres database
  - local artifact directory
  - exposed only through Tailscale Serve or direct Tailscale IP
```

You also operate your normal development machine:

```text
your-dev-machine
  - your repo
  - your coding agent, e.g. Claude Code or Codex
  - your local agent-room bridge / MCP server
  - outbound connection to chatroom server
```

`agent-room-host` and `your-dev-machine` can be the same physical machine for a quick prototype, but the safer version is to keep them separate or run the chatroom inside a VM/container with no access to your home directory.

### Collaborator side

The collaborator operates:

```text
collaborator-dev-machine
  - collaborator repo/context
  - collaborator coding agent
  - collaborator local agent-room bridge / MCP server
  - outbound connection to your chatroom server over Tailscale
```

They do **not** need to expose SSH, Jupyter, file shares, or a web server to you.

---

## 2. Recommended MVP architecture

Build three pieces:

```text
apps/web
  Browser UI for both humans.

apps/server
  Message broker, auth, rooms, WebSocket streaming, artifacts, approvals.

apps/bridge
  Local process or MCP server run by each participant. Connects local coding agent to the room.
```

Recommended repo layout:

```text
agent-room/
  apps/
    web/                  # Next.js or Vite/React UI
    server/               # FastAPI, Node, or Go server
    bridge/               # Local bridge CLI + MCP server
  packages/
    protocol/             # Shared message schemas
    adapters/
      claude-code/        # optional direct integration later
      codex/              # optional direct integration later
  deploy/
    docker-compose.yml
    tailscale-policy.hujson
    systemd/
      agent-room-server.service
      agent-room-bridge.service
  docs/
    SECURITY.md
    THREAT_MODEL.md
```

### Start with MCP/tool-based integration, not full autonomous control

For the first safe version, do **not** try to remotely control Claude Code/Codex directly.

Instead, implement a local MCP server / bridge exposing tools such as:

```text
room_read_thread
room_list_pending
room_send_message
room_upload_artifact
room_request_human_approval
room_mark_resolved
```

Then each human can tell their coding agent:

```text
Use the agent-room tools. Read the latest question from collaborator_agent,
answer with evidence, and do not upload files or run commands without asking me.
```

This is safer than trying to make the agents run fully unattended. A later version can add direct orchestration through vendor-specific SDKs or app-server protocols.

---

## 3. Tailscale setup: host side

### 3.1 Install Tailscale on `agent-room-host`

Install Tailscale normally for the OS. Then authenticate the server.

```bash
sudo tailscale up --hostname=agent-room-host
```

Check its Tailscale IP:

```bash
tailscale ip -4
```

Expected output:

```text
100.x.y.z
```

### 3.2 Prefer a tagged server identity

In the Tailscale admin console, create a tag for the chatroom server:

```jsonc
{
  "tagOwners": {
    "tag:agent-room-server": ["autogroup:admin"]
  }
}
```

Then authenticate the server with that tag:

```bash
sudo tailscale up --hostname=agent-room-host --advertise-tags=tag:agent-room-server
```

Why tag it?

- The ACL/grant can target `tag:agent-room-server` instead of a mutable hostname.
- The server can be treated as infrastructure, not as your personal user device.
- You can replace the machine later without changing the policy semantics.

### 3.3 Run the chatroom server on localhost

Run the app so it listens only on loopback inside the host:

```bash
AGENT_ROOM_HOST=127.0.0.1 \
AGENT_ROOM_PORT=3000 \
AGENT_ROOM_DB=/var/lib/agent-room/agent-room.sqlite \
AGENT_ROOM_ARTIFACT_DIR=/var/lib/agent-room/artifacts \
agent-room-server
```

Safer Docker Compose example:

```yaml
services:
  agent-room-server:
    image: ghcr.io/your-org/agent-room-server:latest
    restart: unless-stopped
    environment:
      AGENT_ROOM_PUBLIC_BASE_URL: "https://agent-room-host.<your-tailnet>.ts.net"
      AGENT_ROOM_DB: "/data/agent-room.sqlite"
      AGENT_ROOM_ARTIFACT_DIR: "/data/artifacts"
      AGENT_ROOM_MAX_UPLOAD_BYTES: "104857600" # 100 MB
      AGENT_ROOM_REQUIRE_APPROVAL_BYTES: "1048576" # 1 MB
      AGENT_ROOM_DISABLE_PUBLIC_SIGNUPS: "true"
      AGENT_ROOM_AUTH_MODE: "invite-token"
    volumes:
      - ./data:/data
    ports:
      - "127.0.0.1:3000:3000"
```

Start it:

```bash
docker compose -f deploy/docker-compose.yml up -d
curl http://127.0.0.1:3000/healthz
```

Expected:

```json
{"ok":true}
```

### 3.4 Expose only the chatroom service through Tailscale

Recommended: use **Tailscale Serve** to expose the local web app only inside the tailnet.

```bash
tailscale serve --https=443 localhost:3000
```

Check status:

```bash
tailscale serve status --json
```

Expected URL pattern:

```text
https://agent-room-host.<your-tailnet>.ts.net/
```

Do **not** use Tailscale Funnel for the default private version. Funnel exposes a local service to the broader internet; Serve exposes to the tailnet/private network.

### 3.5 Share only the chatroom server machine

In the Tailscale admin console:

1. Go to **Machines**.
2. Select `agent-room-host`.
3. Select **Share**.
4. Invite your collaborator's Tailscale identity/email.
5. Do not invite them as a full member of your tailnet unless you have a separate reason.

Tailscale's device-sharing model is designed so the recipient can access the shared machine without seeing the rest of your tailnet. However, sharing a machine is still network access to that machine, so pair it with grants/ACLs and app-level auth.

---

## 4. Tailscale grants / ACLs

Use Tailscale grants/ACLs to enforce least privilege. Exact syntax may need adjustment depending on your tailnet policy state, but this is the intended shape.

### 4.1 Minimal grant: collaborator can access only HTTPS on the chatroom server

Replace:

- `collaborator@example.com` with their Tailscale login.
- `you@example.com` with your login.

```jsonc
{
  "tagOwners": {
    "tag:agent-room-server": ["autogroup:admin"]
  },

  "grants": [
    {
      "src": ["you@example.com"],
      "dst": ["tag:agent-room-server"],
      "ip": ["tcp:443", "tcp:3000"]
    },
    {
      "src": ["collaborator@example.com"],
      "dst": ["tag:agent-room-server"],
      "ip": ["tcp:443"]
    }
  ],

  "ssh": [],

  "tests": [
    {
      "src": "collaborator@example.com",
      "accept": ["tag:agent-room-server:443"],
      "deny": [
        "tag:agent-room-server:22",
        "tag:agent-room-server:3000"
      ]
    }
  ]
}
```

Notes:

- If using `tailscale serve --https=443`, the collaborator should only need `tcp:443`.
- If you expose raw port `3000` directly instead of Serve, allow `tcp:3000` instead of `tcp:443`.
- Keep `ssh` empty unless you intentionally want Tailscale SSH.
- Use Tailscale policy tests to catch accidental exposure.

### 4.2 Host firewall defense-in-depth

On Linux host, additionally restrict host ports:

```bash
sudo ufw default deny incoming
sudo ufw allow in on tailscale0 to any port 443 proto tcp
sudo ufw deny 22/tcp
sudo ufw enable
sudo ufw status verbose
```

If you use `tailscale serve` proxying from `localhost:3000`, do not expose port `3000` on non-loopback interfaces.

Verify locally:

```bash
ss -ltnp
```

Expected safe state:

```text
127.0.0.1:3000   # app backend only on loopback
0.0.0.0:22       # ideally absent, or blocked by firewall/grants
```

---

## 5. Chatroom server implementation

### 5.1 Server responsibilities

The server is intentionally dumb. It should **not** directly read repos or drive agents. It should:

```text
- authenticate users and bridges
- create rooms
- store messages
- stream messages over WebSocket
- store artifacts
- track approvals
- enforce room-level permissions
- log all agent-to-agent communication
```

It should not:

```text
- SSH into participants' machines
- read local source repos
- store raw Claude/Codex memory
- execute arbitrary commands
- hold participants' Claude/OpenAI API keys unless absolutely necessary
```

### 5.2 API endpoints

Minimum HTTP endpoints:

```text
GET  /healthz
POST /api/auth/login
POST /api/rooms
GET  /api/rooms/:room_id
GET  /api/rooms/:room_id/messages
POST /api/rooms/:room_id/messages
POST /api/rooms/:room_id/artifacts
GET  /api/rooms/:room_id/artifacts/:artifact_id
POST /api/rooms/:room_id/approvals/:approval_id/respond
GET  /api/me
```

WebSocket endpoint:

```text
GET /ws?room_id=<room_id>&token=<participant_or_bridge_token>
```

Message flow:

```text
browser -> server -> all subscribed browsers
bridge  -> server -> browsers + addressed bridge(s)
server  -> bridge -> local agent via MCP/tool process
```

### 5.3 Database schema

Use SQLite for MVP. Use Postgres later if hosted.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','bridge','system')),
  created_at TEXT NOT NULL
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE room_participants (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','human','agent','observer')),
  can_send INTEGER NOT NULL DEFAULT 1,
  can_upload INTEGER NOT NULL DEFAULT 0,
  can_request_agent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_ids_json TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  reply_to_message_id TEXT,
  confidence TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE bridge_tokens (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
```

### 5.4 Message envelope

Use a typed JSON envelope internally:

```json
{
  "id": "msg_01H...",
  "room_id": "room_01H...",
  "sender": {
    "id": "agent_timothy",
    "kind": "agent",
    "display_name": "Timothy's Agent"
  },
  "recipients": ["agent_collaborator"],
  "type": "agent_question",
  "body_markdown": "Why was src/depth_regularizer.py written this way?",
  "requested_evidence": ["files", "commits", "tests", "logs"],
  "artifacts": [],
  "approval": null,
  "created_at": "2026-07-02T12:00:00-07:00"
}
```

Allowed message types:

```text
human_message
agent_question
agent_answer
evidence
artifact_uploaded
approval_request
approval_response
system_event
resolution_summary
```

### 5.5 Artifact policy

Do not send large files over the WebSocket. Use HTTP upload/download.

Default limits:

```text
max_single_upload_bytes: 100 MB
require_human_approval_above: 1 MB
block_secret_like_filenames: true
block_secret_like_content_scan: true
retention_days: 30 by default
```

Deny-list examples:

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
.ssh/**
.aws/**
.gcp/**
.azure/**
**/secrets/**
**/*token*
**/*credential*
```

Allowed artifact types for MVP:

```text
text/plain
text/markdown
application/json
image/png
image/jpeg
image/webp
text/x-diff
text/x-patch
application/zip   # approval required
```

For code, prefer patches/diffs over whole folders:

```text
Good:
- git commit SHA
- branch name
- PR link
- unified diff
- file path + line range

Avoid:
- entire source tree zip
- raw repo archive
- dependency cache
- node_modules
- venv
- model checkpoints
```

---

## 6. Local bridge / MCP server implementation

Each participant runs a local bridge. It can be implemented as a Python or TypeScript CLI that also serves as an MCP server to the local coding agent.

### 6.1 Bridge responsibilities

The bridge should:

```text
- connect to the chatroom server using a room-specific token
- expose room tools to the local coding agent
- enforce local policy before sending messages/artifacts
- require local human approval for risky actions
- never accept arbitrary remote shell commands
- never expose filesystem outside configured roots
```

### 6.2 Bridge config file

Create `~/.agent-room/bridge.toml`:

```toml
[identity]
human_name = "Timothy"
agent_name = "Timothy's Agent"
bridge_name = "timothy-dev-bridge"

[room]
server_url = "https://agent-room-host.<your-tailnet>.ts.net"
room_id = "room_xxx"
token_env = "AGENT_ROOM_BRIDGE_TOKEN"

[policy]
read_only_default = true
allow_agent_to_send_text = true
allow_agent_to_upload_files = false
require_human_approval_for_uploads = true
require_human_approval_for_shell = true
require_human_approval_for_code_edits = true
max_upload_bytes_without_approval = 1048576
max_upload_bytes_absolute = 104857600

[filesystem]
roots = ["/path/to/project"]
deny_globs = [
  "**/.env",
  "**/.env.*",
  "**/.ssh/**",
  "**/*.pem",
  "**/*.key",
  "**/*token*",
  "**/*credential*",
  "**/secrets/**",
  "**/node_modules/**",
  "**/.git/**"
]

[commands]
allow_shell = false
allowed_readonly_commands = [
  "git status --short",
  "git log --oneline -n 20",
  "git diff --stat",
  "git diff",
  "pytest --collect-only"
]
```

### 6.3 MCP tools exposed by the bridge

Expose these tools to Claude Code/Codex:

```text
room_list_pending(filter?: string) -> messages[]
room_read_thread(thread_id: string) -> messages[]
room_send_message(recipient: string, body_markdown: string, evidence?: Evidence[]) -> message_id
room_upload_artifact(path: string, description: string) -> artifact_id or approval_required
room_request_human_approval(type: string, payload: object) -> approval_id
room_check_approval(approval_id: string) -> status
room_mark_resolved(message_id: string, summary: string) -> ok
```

Tool descriptions should be strict. Example:

```text
room_upload_artifact:
Upload a local file to the shared agent room as an artifact. Use this only when the human has explicitly approved sharing the file, or when the file is a small non-secret artifact allowed by policy. This tool refuses paths outside configured roots and refuses secret-like filenames/content.
```

### 6.4 Bridge behavior for messages

When the local agent calls `room_send_message`, the bridge should validate:

```text
- sender identity matches local agent
- room token is valid
- body is not empty
- no huge inline base64 blobs
- no known secret patterns
- no forbidden file content embedded directly
```

Then send:

```http
POST /api/rooms/:room_id/messages
Authorization: Bearer <bridge-token>
Content-Type: application/json
```

Payload:

```json
{
  "sender_id": "agent_timothy",
  "recipient_ids": ["agent_collaborator", "human_collaborator"],
  "message_type": "agent_answer",
  "body_markdown": "...",
  "artifact_ids": [],
  "confidence": "medium"
}
```

### 6.5 Bridge behavior for artifact upload

Before upload:

1. Resolve path to absolute path.
2. Confirm path is under one of the configured roots.
3. Confirm it does not match deny globs.
4. Compute size and SHA-256.
5. Scan first N MB for obvious secret patterns.
6. If over approval threshold, create approval request and stop.
7. Otherwise upload via HTTP multipart.

Pseudo-code:

```python
def upload_artifact(path: str, description: str):
    resolved = resolve(path)
    assert_under_allowed_root(resolved)
    reject_if_glob_denied(resolved)
    size = os.path.getsize(resolved)
    if size > cfg.policy.max_upload_bytes_absolute:
        raise PolicyError("File exceeds absolute upload limit")
    sha = sha256_file(resolved)
    if looks_like_secret(resolved):
        raise PolicyError("Secret-like file refused")
    if size > cfg.policy.max_upload_bytes_without_approval:
        return request_human_approval("artifact_upload", {"path": str(resolved), "size": size, "sha256": sha})
    return post_multipart_upload(resolved, description, sha)
```

---

## 7. Coding-agent setup: your side

### 7.1 Create room and tokens

On the chatroom UI:

1. Create room: `Project Debug Room`.
2. Add participants:
   - `Timothy` as human owner.
   - `Timothy's Agent` as local agent.
   - `Collaborator` as human.
   - `Collaborator's Agent` as remote/local agent owned by collaborator.
3. Generate one bridge token for your local bridge.
4. Generate a separate bridge token for collaborator's local bridge.
5. Send collaborator only:
   - room URL
   - their invite token
   - instructions to install/run bridge

Never share your own bridge token.

### 7.2 Run your bridge

```bash
export AGENT_ROOM_BRIDGE_TOKEN="arbt_your_token"
agent-room-bridge --config ~/.agent-room/bridge.toml
```

Expected log:

```text
connected to room room_xxx as timothy-dev-bridge
registered tools: room_list_pending, room_read_thread, room_send_message, room_upload_artifact, room_request_human_approval
policy: read-only default, uploads require approval above 1048576 bytes
```

### 7.3 Connect Claude Code to the bridge

If the bridge is a local stdio MCP server:

```bash
claude mcp add --transport stdio agent-room \
  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \
  -- agent-room-bridge mcp --config ~/.agent-room/bridge.toml
```

Verify:

```bash
claude mcp list
```

Inside Claude Code:

```text
/mcp
```

Then prompt Claude Code:

```text
You have access to the agent-room MCP tools. This is a shared room with my collaborator and their coding agent. Use the room tools only for text messages and evidence summaries. Do not upload files, run shell commands, or reveal secrets unless I explicitly approve. Start by reading pending messages and summarizing what needs my attention.
```

### 7.4 Connect Codex to the bridge

Option A: CLI command if supported in your Codex version:

```bash
codex mcp add agent-room -- agent-room-bridge mcp --config ~/.agent-room/bridge.toml
codex mcp list
```

Option B: edit `~/.codex/config.toml`:

```toml
[mcp_servers.agent_room]
command = "agent-room-bridge"
args = ["mcp", "--config", "/home/you/.agent-room/bridge.toml"]
env = { AGENT_ROOM_BRIDGE_TOKEN = "arbt_your_token" }
enabled_tools = [
  "room_list_pending",
  "room_read_thread",
  "room_send_message",
  "room_upload_artifact",
  "room_request_human_approval",
  "room_check_approval",
  "room_mark_resolved"
]
default_tools_approval_mode = "prompt"
```

Then prompt Codex:

```text
Use the agent-room tools to coordinate with the collaborator's agent. Ask targeted questions, require evidence, and do not upload files or perform code changes without my approval.
```

---

## 8. Coding-agent setup: collaborator side

Send the collaborator a short onboarding message like this:

```text
I set up a private agent-room server over Tailscale. You do not need to expose your machine to me. Your local bridge will make an outbound connection to the room, and your agent can use that bridge to send/receive messages.

Steps:
1. Install Tailscale and accept the shared machine invite for agent-room-host.
2. Open https://agent-room-host.<tailnet>.ts.net/ in your browser.
3. Run the local bridge using your invite token.
4. Connect Claude Code/Codex to the local bridge as an MCP server.
5. Keep read-only mode enabled by default.
```

### 8.1 Collaborator accepts Tailscale share

They install Tailscale, log in with their own Tailscale account, and accept the shared-machine invite. They do not need to join your whole tailnet.

They test access:

```bash
curl https://agent-room-host.<your-tailnet>.ts.net/healthz
```

Expected:

```json
{"ok":true}
```

They should not be able to SSH to the server:

```bash
ssh agent-room-host.<your-tailnet>.ts.net
```

Expected:

```text
connection refused / timed out / denied
```

### 8.2 Collaborator runs their bridge

Their `~/.agent-room/bridge.toml` should point to the same room server but use their own local paths and token.

```toml
[identity]
human_name = "Collaborator"
agent_name = "Collaborator's Agent"
bridge_name = "collaborator-dev-bridge"

[room]
server_url = "https://agent-room-host.<your-tailnet>.ts.net"
room_id = "room_xxx"
token_env = "AGENT_ROOM_BRIDGE_TOKEN"

[policy]
read_only_default = true
allow_agent_to_send_text = true
allow_agent_to_upload_files = false
require_human_approval_for_uploads = true
require_human_approval_for_shell = true
require_human_approval_for_code_edits = true
max_upload_bytes_without_approval = 1048576
max_upload_bytes_absolute = 104857600

[filesystem]
roots = ["/path/to/collaborator/project"]
deny_globs = [
  "**/.env",
  "**/.env.*",
  "**/.ssh/**",
  "**/*.pem",
  "**/*.key",
  "**/*token*",
  "**/*credential*",
  "**/secrets/**",
  "**/node_modules/**",
  "**/.git/**"
]
```

Start:

```bash
export AGENT_ROOM_BRIDGE_TOKEN="arbt_collaborator_token"
agent-room-bridge --config ~/.agent-room/bridge.toml
```

Then connect their coding agent to the bridge using the same Claude Code/Codex MCP patterns as above.

---

## 9. Human UI requirements

The browser UI should show four participants:

```text
Timothy
Timothy's Agent
Collaborator
Collaborator's Agent
```

### 9.1 Message cards

Render messages as cards with:

```text
sender
recipient(s)
type
body
artifact cards
confidence
approval status
timestamp
thread/reply context
```

### 9.2 Control buttons

For humans:

```text
Ask my agent
Ask collaborator's agent
Ask both agents
Pause my agent
Pause all agent turns
Require evidence
Approve/deny upload
Approve/deny shell command
Mark resolved
Export transcript
```

### 9.3 Agent guardrail banners

Every agent answer should display:

```text
Evidence: none / file paths / commits / tests / artifacts
Confidence: low / medium / high
Action taken: read-only / requested approval / uploaded artifact / proposed patch
```

Never let an agent answer appear as if it is authoritative without showing confidence/evidence.

---

## 10. Recommended conversation protocol

The room should encourage structured agent-to-agent exchanges.

### 10.1 Question format

When one agent asks the other agent a question, prefer:

```markdown
## Question
Why was `src/rendering/depth_regularizer.py` implemented this way?

## Requested answer
- original purpose
- relevant files/functions
- relevant commits/tests/logs, if available
- known failed alternatives
- assumptions/invariants
- current confidence

## Constraints
Do not upload files unless your human approves. Prefer file paths, line ranges, commit IDs, and concise summaries.
```

### 10.2 Answer format

Agents should answer with:

```markdown
## Short answer
...

## Evidence
- `path/to/file.py`, function `foo`, lines N-M
- commit `abc123`, if available
- test `tests/test_foo.py`

## Assumptions
...

## Known uncertainty
...

## Suggested follow-up
...

## Confidence
Medium
```

### 10.3 Human override

Humans can send:

```text
Pause agent turns.
Only answer this narrow question.
Do not ask for files.
Do not upload anything.
Summarize and stop.
```

The server should enforce pause flags so agents cannot continue spamming the room.

---

## 11. Approval model

### 11.1 Actions requiring approval

Always require local human approval for:

```text
- shell command execution
- code edits
- git commits/pushes
- file uploads above threshold
- uploading any zip/archive
- uploading any file matching secret-like patterns
- sharing raw logs that may contain tokens
- sharing environment/config files
- changing bridge policy
```

### 11.2 Approval payload examples

File upload approval:

```json
{
  "type": "artifact_upload",
  "path": "/path/to/project/results/debug.png",
  "filename": "debug.png",
  "size_bytes": 1834421,
  "sha256": "...",
  "description": "Depth rendering failure image requested by collaborator_agent"
}
```

Shell command approval:

```json
{
  "type": "shell_command",
  "command": "pytest tests/test_depth_regularizer.py -q",
  "cwd": "/path/to/project",
  "reason": "Verify whether the suspected invariant is covered by tests"
}
```

The local bridge should display the approval request in the local terminal and/or local web UI. The remote human should not be able to approve actions on someone else's machine.

---

## 12. File transfer implementation

### 12.1 Use HTTP upload, not WebSocket blobs

Agent sends a message:

```text
I have artifact `art_123`: depth_failure.png
```

Actual upload:

```http
POST /api/rooms/:room_id/artifacts
Authorization: Bearer <bridge-token>
Content-Type: multipart/form-data
```

Server stores:

```text
/var/lib/agent-room/artifacts/<room_id>/<artifact_id>/<sha256>__filename
```

### 12.2 Artifact metadata

Store:

```json
{
  "artifact_id": "art_123",
  "filename": "depth_failure.png",
  "mime_type": "image/png",
  "size_bytes": 1834421,
  "sha256": "...",
  "uploaded_by": "agent_timothy",
  "approved_by": "human_timothy",
  "created_at": "...",
  "expires_at": "..."
}
```

### 12.3 Secret scanning

At minimum, scan text-like files for patterns:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
BEGIN RSA PRIVATE KEY
BEGIN OPENSSH PRIVATE KEY
xoxb-
ghp_
github_pat_
sk-
```

If matched, block upload and require manual override. For MVP, manual override can mean: user must upload through browser UI, not through agent bridge.

### 12.4 Large files

For large artifacts, prefer references:

```text
- git branch
- commit SHA
- PR URL
- shared dataset path agreed out-of-band
- rsync/scp over Tailscale between humans, not automatic agent bridge
```

Do not let agents automatically zip and upload entire directories.

---

## 13. Verification checklist

### 13.1 Network tests: host side

From your own machine:

```bash
curl https://agent-room-host.<tailnet>.ts.net/healthz
```

From collaborator machine:

```bash
curl https://agent-room-host.<tailnet>.ts.net/healthz
```

Expected:

```json
{"ok":true}
```

From collaborator machine, these should fail:

```bash
ssh agent-room-host.<tailnet>.ts.net
curl http://agent-room-host.<tailnet>.ts.net:3000/healthz  # if only 443 allowed
nc -vz agent-room-host.<tailnet>.ts.net 22
nc -vz agent-room-host.<tailnet>.ts.net 8888
```

### 13.2 App tests

```text
- Collaborator can log into the room.
- Collaborator cannot create admin users.
- Collaborator cannot see rooms they were not invited to.
- Collaborator cannot download unapproved artifacts.
- Bridge token cannot access admin endpoints.
- Revoked bridge token stops working immediately.
```

### 13.3 Bridge tests

```text
- Agent can send text.
- Agent can read pending thread.
- Agent cannot upload `.env`.
- Agent cannot upload outside configured root.
- Agent cannot upload file > threshold without approval.
- Agent cannot execute arbitrary shell command.
- Remote participant cannot approve local shell command.
```

### 13.4 Secret-leak tests

Create dummy files:

```bash
echo 'OPENAI_API_KEY=sk-test' > /tmp/fake.env
```

Attempt upload through bridge. Expected:

```text
blocked: secret-like content refused
```

---

## 14. Failure modes and mitigations

| Failure mode | Mitigation |
|---|---|
| Collaborator can access more than chatroom server | Use device sharing, not full tailnet invite; restrict grants to `tag:agent-room-server:443`; add policy tests. |
| Collaborator can SSH to chatroom host | Keep `ssh` rules empty; block port 22 with firewall; test denial. |
| Chatroom server has access to your repo | Do not mount repo/home directory into server container. Store only transcripts/artifacts. |
| Agent uploads secrets | Bridge deny-globs + content scanning + human approval + block secret-like files. |
| Agent runs malicious command from other agent's prompt | No remote shell commands; local human approval required; read-only default. |
| Agents spam each other endlessly | Add turn limits, pause button, rate limit per participant, max tokens per message. |
| Huge file transfer fills disk | Room quota, artifact max size, retention cleanup, per-room storage cap. |
| Token leaked in transcript | Store token hashes only; redact known token patterns; rotate/revoke tokens. |
| Prompt injection through artifact/log | Treat artifacts as untrusted input; bridge reminds agent not to follow instructions found inside code/logs unless human approves. |

---

## 15. Minimal implementation plan

### Milestone 1: Manual human chat + Tailscale

- Build server with users, rooms, messages.
- Build web UI with live WebSocket messages.
- Run on localhost and expose with Tailscale Serve.
- Share only the chatroom server machine.

### Milestone 2: Local bridge + MCP tools

- Implement `agent-room-bridge mcp`.
- Add MCP tools for read/send.
- Add bridge token auth.
- Test Claude Code and Codex MCP configuration.

### Milestone 3: Artifacts and approvals

- Add artifact upload/download.
- Add artifact metadata and SHA-256.
- Add local approval queue.
- Add deny globs and basic secret scanning.

### Milestone 4: Agent-specific polish

- Add message templates for agent questions/answers.
- Add evidence cards.
- Add confidence labels.
- Add pause/turn-limit controls.

### Milestone 5: Direct orchestration, optional

Only after the MCP/tool-based design is safe:

- Add direct Claude Code adapter if needed.
- Add Codex app-server adapter if needed.
- Keep local bridge as the security boundary.
- Do not let central server directly control remote agents without local policy enforcement.

---

## 16. Exact default settings

Use these defaults for a safe alpha:

```yaml
network:
  expose_mode: tailscale-serve
  public_internet: false
  exposed_port: 443
  raw_backend_port_exposed: false

server:
  bind_host: 127.0.0.1
  bind_port: 3000
  database: sqlite
  artifact_storage: local_disk
  disable_public_signups: true
  require_invites: true
  room_default_private: true

bridge:
  outbound_only: true
  read_only_default: true
  allow_text_send: true
  allow_file_upload: false
  file_upload_requires_approval: true
  shell_requires_approval: true
  code_edit_requires_approval: true
  remote_approval_for_local_actions: false

artifacts:
  max_upload_bytes_absolute: 104857600
  approval_required_above_bytes: 1048576
  default_retention_days: 30
  block_secret_like_names: true
  block_secret_like_content: true

agent_conversation:
  max_auto_turns_without_human: 3
  require_evidence_for_answers: true
  require_confidence_label: true
  allow_hidden_backchannel: false
```

---

## 17. What each side can and cannot access

### Collaborator can access

```text
- the chatroom web app
- messages in rooms they are invited to
- artifacts approved for that room
- their own local bridge and local agent
```

### Collaborator cannot access

```text
- your whole tailnet
- your other devices
- your filesystem
- your repo unless you explicitly upload files/artifacts
- your agent memory unless your agent shares a summary/message
- SSH/Jupyter/dev servers on the chatroom host if grants/firewall are correct
```

### You can access

```text
- the chatroom web app
- collaborator's agent messages in the room
- artifacts they explicitly approve/upload
```

### You cannot access

```text
- collaborator's full computer
- collaborator's filesystem
- collaborator's repo unless they explicitly share paths/artifacts/summaries
- collaborator's raw agent memory
- collaborator's shell
```

This is the desired boundary.

---

## 18. References checked while writing this spec

- Tailscale machine sharing: https://tailscale.com/docs/features/sharing
- Tailscale grants syntax: https://tailscale.com/docs/reference/syntax/grants
- Tailscale policy file syntax/tests/tags: https://tailscale.com/docs/reference/syntax/policy-file
- Tailscale Serve: https://tailscale.com/docs/features/tailscale-serve
- Tailscale Serve CLI: https://tailscale.com/docs/reference/tailscale-cli/serve
- Tailscale Funnel distinction: https://tailscale.com/docs/features/tailscale-funnel
- Tailscale Taildrop limitations: https://tailscale.com/docs/features/taildrop
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
- Claude Code overview: https://code.claude.com/docs/en/overview
- OpenAI Codex MCP docs: https://developers.openai.com/codex/mcp
- OpenAI Codex app-server docs: https://developers.openai.com/codex/app-server
- OpenAI Codex CLI docs: https://developers.openai.com/codex/cli
- OpenAI Codex config reference: https://developers.openai.com/codex/config-reference
- MCP roots specification: https://modelcontextprotocol.io/specification/2025-06-18/client/roots
- MCP tools specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools

---

## 19. Final recommendation

Build the first version as:

```text
Tailscale-shared dedicated chatroom host
+ private browser room
+ local outbound bridges
+ MCP tools for each local coding agent
+ read-only default
+ approval-gated files/actions
```

This achieves the important product behavior:

```text
Two humans can steer.
Two agents can talk a lot.
Neither side gets direct access to the other's full computer.
All shared context is explicit, logged, permissioned, and revocable.
```
