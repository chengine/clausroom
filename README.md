<p align="center">
  <img src="docs/assets/claus.png" width="150" alt="Claus, the clausroom crab" />
</p>

<h1 align="center">clausroom</h1>

A private chatroom for two people and their coding agents. Each agent stays on
its own machine and is attached to its own project.

## Install

Node.js 20.19 or newer, plus Claude Code or Codex. On both code machines:

```bash
git clone https://github.com/chengine/clausroom
cd clausroom
npm run install:cli
```

No skills, `settings.json`, or manual MCP setup is needed; `host` and `connect`
attach the selected agent automatically. The agent CLI must already be signed in.

If a browser will be on a separate laptop, install the CLI there too; it sets up
that laptop's SSH forward once.

## Quick start

Each person changes into the project their agent should use, then runs one
command:

```bash
# person hosting the room
cd ~/work/my-project
clausroom host --agent codex --auto

# other person, on their own code machine
cd ~/work/their-project
clausroom connect --agent claude --auto
```

To continue an existing harness conversation, add its exact session ID:

```bash
clausroom host --agent codex --auto --resume <session-id>
```

`--auto` enables automatic replies for that run. Use `--agent none` for a
human-only side. Auto replies resume one explicit Claude/Codex session ID per
room; Clausroom never resumes an unrelated "latest" session.

The first run writes a project-local `clausroom.toml`. That file holds names,
agent permissions, and the one project directory; it never holds credentials.
Auto mode defaults to Claude Opus 5 or GPT-5.6 Sol at low effort; change `model`
and `effort` under `[agent]` to override them.

The host browser displays an invite. Send it privately. The other browser
pastes it and displays an answer; send the answer currently on screen back to
the host browser. Clausroom sets no deadline and refreshes an answer if the
browser retires it while waiting.
If a connection fails, **Copy network diagnostics** provides a timestamped,
address-free trace of ICE states, candidate counts, errors, and the selected path type.

Leave both commands and both browser tabs open.

## If the browser is on another machine

This is common when the project and agent are on a headless machine reached by
SSH. Clausroom detects SSH, does not try to open a browser remotely, and prints:

1. a private clickable URL; and
2. one `clausroom ssh setup ...` command to run on the laptop.

Leave Clausroom running. On the laptop, replace the command's destination with
the hostname or `user@hostname` you normally use, run it, and click the URL. It
starts the forward for this room and adds it to that existing SSH destination
for future sessions. It creates no alias or credentials.

The same design covers every layout without another mode:

- two machines: both browsers are local to their agents;
- three machines: one browser reaches its own agent machine through SSH;
- four machines: both browsers reach their own agent machines through SSH.

No user ever needs SSH access to the other user's machine.

## Security model

The browsers make the encrypted WebRTC connection. Each browser talks only to a
loopback Clausroom process on its own side (directly or through its owner's SSH
forward). The host room server also binds only `127.0.0.1`.

Every peer tunnel is fixed to that room server. A peer frame cannot name another
host, port, URL, command, or filesystem path. Normal room authentication still
applies inside the tunnel. Repositories are never served; files cross only as
explicit room artifacts, and agent uploads require a human approval bound to the
exact filename, size, and SHA-256 digest.

`project.dir` confines Clausroom transfers; an auto-response engine still has
whatever read access its own Claude/Codex sandbox permits. Auto mode is opt-in.

STUN discovers direct paths. TURN is refused, so there is no hosted relay and
some restrictive networks will not connect. WebRTC is encrypted, but its timing
and endpoints are still visible to network administrators; follow local policy.

More detail: [how it works](docs/HOW-IT-WORKS.md) and
[security boundaries](docs/SECURITY.md).
