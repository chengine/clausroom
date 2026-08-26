# How Clausroom works

Clausroom has one authoritative room server, on the host code machine. It
binds only `127.0.0.1`. The other code machine runs a loopback connector, and
the two browsers carry room traffic between them over WebRTC.

There is no rendezvous service. The users exchange an offer and answer
manually.

## Starting a room

`clausroom host`:

1. Loads the project-local config, starts the room server, and creates the two
   humans and their agents.
2. Writes the host agent's private session file, attaches the selected local
   agent, and optionally starts auto-response.
3. Opens or prints a private loopback URL for the host browser.
4. Stays in the foreground with the server.

The host browser rotates the guest's one-time invite, creates a WebRTC offer,
and displays it. The offer contains SDP connection information and a fresh
session identifier, not room credentials.

`clausroom connect` starts the guest's loopback connector, opens or prints its
private browser URL, and stays in the foreground. The guest browser pastes the
offer, creates an answer, and displays it for return to the host browser.

There is no copy/paste or application connection deadline. A bad code or failed
path leaves both commands running; the users can start again with a fresh invite.

Once both browsers prove that the selected ICE path is direct, the host browser
sends the guest's one-time human invite and room-scoped agent token over the
open DTLS-protected control channel. The guest connector then logs in, writes
its local agent session, and attaches its selected agent. Credentials never
travel in the pasted offer or answer. The guest acknowledges that setup over
the control channel before the host declares the room connected.

## The data path

```text
guest browser or agent
        |
guest 127.0.0.1 connector
        |
guest browser WebSocket
        |
ordered WebRTC data channel
        |
host browser WebSocket
        |
host 127.0.0.1 room server
```

The guest connector serves the built UI locally. It forwards a new connection
only when its first request targets `/api`, `/ws`, or `/healthz`; static asset
connections stay local.

Each remote TCP connection gets one ordered WebRTC data channel. The browsers
bridge bounded binary chunks without interpreting the HTTP or WebSocket bytes.
Tunnel messages contain no destination. On the host, every accepted channel is
hard-wired to the room server's own loopback port, so the link cannot be turned
into a proxy for SSH, another service, or another machine. Normal room bearer
authentication still applies inside the tunnel.

## Two, three, or four machines

Each person has a code machine, where the command and agent run, and a browser
machine, where the person uses the room. Those may be the same machine.

- Two machines: both browsers run on their respective code machines.
- Three machines: one browser is separate from its code machine.
- Four machines: both browsers are separate from their code machines.

When a browser is separate, that user forwards their own Clausroom loopback
port through an SSH connection they already control. `clausroom ssh setup`
adds the loopback-only forward to the user's normal destination, starts it for
the current room, and creates no alias or credentials.
The browser still opens `127.0.0.1`, and WebRTC is still browser-to-browser.
Neither user needs SSH access to the other user's machine.

## Connectivity and state

STUN lets each browser discover possible direct addresses. TURN URLs are
rejected, and browser statistics must identify a non-relay candidate pair
before the room opens. LAN, VPN, public, and NAT-punched paths can work;
restrictive NAT or firewall policy can leave no direct path, in which case
Clausroom fails closed rather than relaying through a hosted server.

The host owns the private SQLite room history and artifact directory. Each side keeps
only its own live agent session in `~/.clausroom/session.json`; that file is
removed when its command exits. The project is selected by `project.dir` in the
project-local `clausroom.toml` (or an explicitly selected config).

Auto-response records the selected harness and its explicit session ID in that
same private file. Later turns resume exactly that Claude/Codex session. If the
harness reports that the ID no longer exists, Clausroom clears it and retries
once with a fresh session; it never uses a resume-latest option.

The room API remains ordinary authenticated REST plus a push WebSocket. The
browser peer layer changes how those bytes reach the host, not their meaning.
