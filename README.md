<p align="center">
  <img src="docs/assets/claus.png" width="150" alt="Claus, the clausroom crab" />
</p>

<h1 align="center">clausroom</h1>

A private chatroom where two people and their coding agents work on a problem
together — without sharing either machine, either repository, or any port.

One person hosts. The other joins with one line of text. Both agents can read
their own side's project and talk to each other in the room, while both humans
watch and approve.

## Install

Node.js 20 or newer, plus Claude Code or Codex. On both machines:

```bash
git clone https://github.com/chengine/clausroom
cd clausroom
npm run install:cli
```

## Press play

Both people do the same two things: edit one file, run one command.

```bash
clausroom host        # one of you
clausroom connect     # the other
```

The first run writes `clausroom.toml` next to you and tells you where it is.
Open it, set your name and your project directory, and run the command again:

```toml
[me]
name  = "Mikel"
agent = "claude"          # claude | codex | none

[partner]
name = "Ada"

[project]
# The one directory your agent may read. Nothing outside it is reachable.
dir = "~/work/depth-regularizer"
```

`clausroom host` prints one long line starting with `CLAUSROOM_PEER_OFFER`.
Send that line to the other person however you normally talk. They paste it into
`clausroom connect`, which prints a `CLAUSROOM_PEER_ANSWER` line to send back.
Paste that into the still-running `host`, and the room opens in both browsers.

There is no deadline on the paste, and a mistyped one just asks again. Neither
person enters an IP address, a token, or a room id.

## What each side can see

Your agent gets a set of `room_*` tools — read the room, answer with evidence,
ask a question, share a file. It can read the one directory you named and
nothing else. Their agent can read theirs. Neither can reach across.

Files never move without a human saying so: an agent that wants to share one
creates a request, and the person who owns that agent approves it in the browser.
Every message and every file is in the transcript; there is no side channel.

Turn it up or down in `clausroom.toml`:

```toml
[agent]
send_messages = true    # may post text into the room
upload_files  = false   # may offer a file; you approve each one either way
auto_reply    = false   # answers messages addressed to it with no human turn
```

`auto_reply = true` lets your agent answer on its own, with read-only tools, a
per-answer time limit, and every reply still passing the same checks. The room is
untrusted input to it, and it is told so.

Every value in that file is used exactly as written. Nothing in it overrides
anything else, and it never contains a token.

## If you SSH into the machine that hosts

Forward the same port you host on, then run `clausroom host` there:

```bash
ssh -L 127.0.0.1:3000:127.0.0.1:3000 you@host-machine
cd ~/work/depth-regularizer && clausroom host --no-open
```

Because the port matches, the URL it prints works as-is on your laptop. Leave the
SSH session running. The repository and the agent stay on the host machine.

## Checking on things

```bash
clausroom check       # is the config valid, and is the room reachable?
clausroom project     # re-point your agent at the room after editing the config
```

## Details

- [How it works](docs/HOW-IT-WORKS.md) — the connection, the wire, the config reference.
- [Security](docs/SECURITY.md) — what is enforced where, and what is not.
