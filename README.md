<p align="center">
  <img src="docs/assets/claus.png" width="150" alt="Clausroom crab" />
</p>

<h1 align="center">clausroom</h1>

Clausroom is a private chatroom where two people and their coding agents can
work together without sharing either machine or repository.

## Install or update

Clausroom requires Node.js 20 or newer and either Codex or Claude Code.

On both machines, run this from the Clausroom checkout after cloning it or
switching to a branch with CLI changes:

```bash
npm run install:cli
```

The host keeps this source checkout because it runs the room server. If it is
not at `~/StanfordMSL/clausroom`, set its location once:

```bash
export CLAUSROOM_REPO=/path/to/clausroom
```

## Quick start

The host changes into the repository their agent should use and runs:

```bash
cd /path/to/host-repository
clausroom host
```

Send the complete `CLAUSROOM_PEER_OFFER ...` line privately to the other person.

The guest changes into their own repository and runs:

```bash
cd /path/to/guest-repository
clausroom connect
```

The guest pastes the offer, then sends the resulting
`CLAUSROOM_PEER_ANSWER ...` line back to the host. The host pastes the answer.
Both commands open a local browser and remain running for the session.

That is the entire workflow: the host runs `host`; the guest runs `connect`.
Neither person runs both commands or enters an IP address.

Codex is configured by default. Use `--agent claude` for Claude Code:

```bash
clausroom host --agent claude
clausroom connect --agent claude
```

Add `--auto` to let the selected agent answer room messages automatically:

```bash
clausroom connect --agent claude --auto
```

Auto-response stays inside the same running command. It uses the current
directory, read-only agent tools, a five-minute response timeout, and no agent
uploads unless uploads were separately enabled.

Each command grants its local coding-agent bridge access only to the current
directory. The other person cannot browse it. The encrypted WebRTC connection
exposes no filesystem, SSH service, or public application port. Agent uploads
are off unless `--allow-agent-uploads` is supplied and still require human
approval.

Detailed security and networking behavior:
[Direct WebRTC peer mode](docs/PEER-CONNECT.md),
[Security model](docs/SECURITY.md), and
[Threat model](docs/THREAT_MODEL.md).

## FAQ

### What if I SSH into the host machine from my laptop?

The host machine still runs Clausroom and owns the repository. Your laptop
needs only SSH and a browser.

From the laptop:

```bash
ssh -L 127.0.0.1:3000:127.0.0.1:3000 admin@171.64.160.63
```

In that SSH shell:

```bash
cd /path/to/host-repository
clausroom host
```

Leave the SSH session running. If the remote machine cannot open a browser, the
command prints a one-time `http://127.0.0.1:3000/#clausroom-session=...` URL.
Open that URL on the laptop. The SSH forward carries only the local Clausroom
web UI; the repository and agent remain on the host machine.

### What if I SSH into the guest/connect machine from my laptop?

Choose a fixed loopback port so it can be forwarded before the peer connection
starts.

From the laptop:

```bash
ssh -L 127.0.0.1:43001:127.0.0.1:43001 user@guest-machine
```

In that SSH shell:

```bash
cd /path/to/guest-repository
clausroom connect --listen-port 43001
```

Paste the host's offer and return the answer as usual. Leave SSH running and
open the printed
`http://127.0.0.1:43001/#clausroom-session=...` URL on the laptop. The
repository and agent remain on the guest machine.
