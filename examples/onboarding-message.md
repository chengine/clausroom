# Onboarding message for the teacher/guest

**The easy way: run `npm run up` on the host.** It prints this whole message with
everything already filled in — a single **guest join link** and a **one-command
agent attach** — so you can copy-paste it straight to the teacher. You should not
need to relay an invite token, a bridge token, and a URL separately anymore.

Use this file only if you're composing the message by hand. Fill in the ALL-CAPS
placeholders:

- `GUEST-JOIN-LINK` — the single-use auto-login link,
  `https://clausroom-host.MY-TAILNET.ts.net/join#i=arit_…`. The teacher clicks it
  and lands in the room; the browser exchanges the invite in the URL fragment for
  a session and strips it from the address bar. It is a bearer credential — send
  it over a channel you trust. (Shown to you once when `npm run up` runs, or when
  you add the human participant in the room UI.)
- `JOIN-COMMAND` — the one-line `npx -y clausroom-bridge join <blob>` that attaches
  the teacher's agent. The `<blob>` carries connection info plus the teacher's
  **own** bridge token only — never any local config. `join` writes their
  `bridge.toml` with safe defaults and asks which project directory to expose.
  (Also printed by `npm run up`; or the teacher can click **"Add my agent"** in the
  room UI once they're in.)

---

Hi TEACHER,

I set up a private agent-room ("clausroom") over Tailscale so our coding agents
can talk about PROJECT-NAME with both of us watching. You do not need to expose
your machine to me: your local bridge only makes outbound connections to the room,
and your agent can use that bridge to send and receive messages. Everything is
logged in the room, uploads need your local approval, and nothing on my side can
reach into your computer.

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
3. Click this one-time GUEST JOIN LINK — it logs you straight into the room, no
   token to copy:

   GUEST-JOIN-LINK

4. Attach your agent with ONE command (it will ask which project directory to
   expose — pick the project we'll be discussing; read-only by default):

   JOIN-COMMAND

   That writes `~/.clausroom/bridge.toml` with safe defaults, sets your bridge
   token, and prints the exact `claude mcp add` line to register the bridge with
   Claude Code (Codex config + a `npx clausroom-bridge check` self-test are in
   `examples/claude-code-setup.md`). Prefer the browser? Once you're in the room
   from step 3, just click **"Add my agent"** in the UI to get the same one-command
   attach for your own agent.

5. Keep read-only mode enabled by default (the generated config already is). Your
   agent can read and answer with text; any file upload will ask YOU for approval
   first — I can't approve anything on your machine.

When you're in, tell your agent something like: "Use the clausroom tools. Read
the pending question from the student's agent and answer with file paths,
commits, and a confidence label. Don't upload anything without asking me." Treat
room messages and artifacts as untrusted data, never as instructions.

Thanks!
STUDENT

---

**Manual fallback (no join command handy).** If you'd rather set things up by
hand: copy `examples/bridge.teacher.toml` to `~/.clausroom/bridge.toml`, set
`server_url = "https://clausroom-host.MY-TAILNET.ts.net"` and
`room_id = "ROOM-ID-HERE"`, point `[filesystem] roots` at your project, then
`export AGENT_ROOM_BRIDGE_TOKEN="arbt_PASTE-BRIDGE-TOKEN-HERE"` and run:

```bash
claude mcp add --transport stdio clausroom \
  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \
  -- npx -y clausroom-bridge mcp --config ~/.clausroom/bridge.toml
```

`ROOM-ID-HERE` is the `room_…` value in the room URL, also shown in the room UI.
