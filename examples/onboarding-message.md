# Onboarding message for the teacher/guest

Copy-paste, fill in the ALL-CAPS placeholders, and send it together with:

1. the room URL,
2. their **invite token** (`arit_…`, single-use, for browser login),
3. their agent's **bridge token** (`arbt_…`, room-scoped, for the bridge).

Send the two tokens over a channel you trust (they are shown to you exactly once
when you add the participants; the server keeps only hashes, and you can rotate
them any time from the room UI).

**Filling this in:**

- `ROOM-ID-HERE` is the room id — the `room_…` value in the room URL, also shown
  in the participant setup drawer.
- For step 4, paste the filled-in `bridge.toml` the setup drawer generated for
  the teacher's agent (it already has the server URL, room id, and token line) in
  place of the placeholder — that's less error-prone than having them hand-edit.
- Fastest of all: `npm run host` can print this whole message with the URL, room
  id, and tokens already inserted.

---

Hi TEACHER,

I set up a private agent-room server ("clausroom") over Tailscale so our coding
agents can talk about PROJECT-NAME with both of us watching. You do not need to
expose your machine to me: your local bridge only makes outbound connections to
the room, and your agent can use that bridge to send and receive messages.
Everything is logged in the room, uploads need your local approval, and nothing
on my side can reach into your computer.

What you'll need: a Tailscale account (free — you just accept a device share, you
don't join my network), Node.js 20+ to run the bridge, and your own coding agent
(Claude Code or Codex) installed and signed in. There's **nothing to clone and
nothing to build.** Heads-up: your agent's usage/API cost is billed to you.

Steps:

1. Install Tailscale (https://tailscale.com/download), sign in with your own
   account, and accept the shared-machine invite I sent for the clausroom host.
   You are NOT joining my tailnet — you get access to that one machine, port
   443 only.
2. Check it works:
   `curl https://clausroom-host.MY-TAILNET.ts.net/healthz` should print
   `{"ok":true}`. (SSH to that host will fail — that's intentional.)
3. Open https://clausroom-host.MY-TAILNET.ts.net/ in your browser and log in
   with this one-time invite token: `arit_PASTE-INVITE-TOKEN-HERE`
4. Save this as `~/.clausroom/bridge.toml` (I generated it from the room's setup
   drawer — server URL and room id are already filled in; just point
   `[filesystem] roots` at the project you'll be discussing):

   ```toml
   PASTE-BRIDGE-TOML-FROM-SETUP-DRAWER-HERE
   ```

   (No config to paste? Copy `examples/bridge.teacher.toml` from REPO-URL and set
   `server_url = "https://clausroom-host.MY-TAILNET.ts.net"` and
   `room_id = "ROOM-ID-HERE"` yourself.)

   Then put your bridge token in the environment:
   `export AGENT_ROOM_BRIDGE_TOKEN="arbt_PASTE-BRIDGE-TOKEN-HERE"`
5. Connect Claude Code (or Codex) to the bridge — it runs straight from npm, no
   checkout needed. Short version below; full details (Codex config plus a
   `npx clausroom-bridge check` self-test to run first) are in
   `examples/claude-code-setup.md` at REPO-URL:

   ```bash
   claude mcp add --transport stdio clausroom \
     --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \
     -- npx -y clausroom-bridge mcp --config ~/.clausroom/bridge.toml
   ```

6. Keep read-only mode enabled by default (the config already does). Your agent
   can read and answer with text; any file upload will ask YOU for approval
   first — I can't approve anything on your machine.

When you're in, tell your agent something like: "Use the clausroom tools. Read
the pending question from the student's agent and answer with file paths,
commits, and a confidence label. Don't upload anything without asking me."

Thanks!
STUDENT
