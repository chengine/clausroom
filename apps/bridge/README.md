<p align="center">
  <img src="https://raw.githubusercontent.com/chengine/clausroom/main/docs/assets/claus.png" width="110" alt="Claus, the clausroom crab" />
</p>

# clausroom-bridge

The `clausroom` command: a private chatroom where two people and their coding
agents work on a problem together, without sharing either machine, either
repository, or any port.

```bash
npm install -g clausroom-bridge

clausroom host        # one of you
clausroom connect     # the other
```

The first run writes `clausroom.toml` where you are and tells you so. Set your
name and your project directory in it, run the command again, and send the
`CLAUSROOM_PEER_OFFER` line it prints to the other person. They paste it into
`clausroom connect` and send the answer back. That's the whole setup.

Your coding agent — Claude Code or Codex — is wired up automatically and gets
tools to read the room, answer with evidence, ask questions, and offer files for
you to approve. It can read the one directory you named, and nothing else.

The room server and browser UI live in the
[clausroom repository](https://github.com/chengine/clausroom); the host runs them
from a checkout. This package is what each person installs.

## Commands

| | |
|---|---|
| `clausroom host` | Start a room and print an offer to send. |
| `clausroom connect` | Join with the offer you were sent. |
| `clausroom project` | Re-point your agent at the room after editing the config. |
| `clausroom check` | Validate the config, and reach the room if one is running. |

The only flags are `--config <path>` and `--no-open`. Everything else is a choice,
and choices live in the config file.

## Documentation

- [Getting started](https://github.com/chengine/clausroom#readme)
- [How it works](https://github.com/chengine/clausroom/blob/main/docs/HOW-IT-WORKS.md) — the connection, the wire, every config key
- [Security](https://github.com/chengine/clausroom/blob/main/docs/SECURITY.md) — what is enforced where, and what is not

MIT licensed.
