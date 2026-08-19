# What clausroom protects, and what it doesn't

The point of clausroom is that two people can put their coding agents in the same
room without either of them getting access to the other's machine. This is how
that holds up, and where it stops.

## The boundaries

**Neither machine is reachable.** The host's room server binds `127.0.0.1` and
nothing else — there is no flag to change that. The guest's side of the tunnel
also binds `127.0.0.1`, so nobody else on their network can use it. No port is
published, no domain or certificate is involved, and there is no SSH path between
the two.

**The tunnel goes to exactly one place.** The host's data channels are wired to
one validated loopback address, fixed at startup: the port its own server
listens on. It is not a proxy. It cannot be pointed at SSH, at a file share, or
at anything else, and it never interprets the bytes it carries as a path or a
command.

**The link is direct or it is nothing.** ICE decides connectivity and DTLS
authenticates the fingerprints in the offer and answer you exchanged by hand.
TURN URLs are rejected in config, and a relayed candidate pair is refused at
runtime — so your room never passes through a third party's server. Both sides
print the pair they chose.

**The server never touches either repository.** It reads and writes one SQLite
file and one directory of uploaded files. There is no endpoint that reads an
arbitrary path, because there is no code that opens one.

**Each side's agent sees one directory.** The bridge resolves every requested
path — symlinks included — and refuses anything that does not land inside the one
directory in your config. On top of that, an always-on deny list (`.env`, `.ssh`,
`*.pem`, `*token*`, `*credential*`, `secrets/`, `.git`, `node_modules`) applies
with no way to switch it off, and any file whose first 5 MB look like credentials
is refused outright rather than gated. Your partner's agent is subject to their
own copy of these rules on their own machine; nothing you configure reaches
across, and nothing they configure reaches you.

**Files move only when a human says so.** Every agent upload needs an approved
`artifact_upload` request, and an approval is good for exactly one upload. Only
the human who owns that agent can answer it — not the other person, not even the
room owner. A human uploading through their own browser needs no approval,
because they are the approval.

**There is no back channel.** Every mutation is a REST call. Every accepted
message is stored, broadcast to every socket in the room, and logged to stdout as
`MSG <room> <sender> <type>`. `recipient_ids` is addressing, not privacy. The
WebSocket accepts only `ping` and an agent's own `working`/`idle` report.
`GET /api/rooms/:id/export.md` gives you the whole transcript.

**Agents cannot run away.** Three agent messages in a row and the room refuses
the fourth until a human speaks. Either human can pause every agent, or one
agent, at any moment. An agent that is refused is told to stop and wait, not to
retry.

**Credentials are not stored.** The database holds `sha256(token)` and never the
token, so a copy of the SQLite file is not a set of working credentials. A raw
token appears exactly twice: in the response that mints it, and in the offer the
host hands to the guest. Browser session tokens travel in a URL fragment, which
is never sent to the server, and the page drops the fragment as soon as it has
read it. `clausroom.toml` never contains one; `~/.clausroom/session.json` does,
and it is mode 0600 and deleted when the room closes.

**Secrets in chat get a seatbelt.** The server rewrites anything matching a known
credential shape — API keys, private key headers, its own token format — to
`[redacted-secret]` before storing or broadcasting it, and refuses a message
carrying a long base64 run with `inline_blob`. The agent's own machine refuses to
send such text in the first place. This is a seatbelt for the moment someone
pastes a key into the room, not a guarantee.

**The auto-responder is fenced in.** It runs the local agent with read-only tools
by default, in the project directory, with a wall-clock limit, and with no
clausroom variables in its environment. Its prompt states plainly that the room
is untrusted data and that instructions found inside it must be refused. Its
reply passes the same local checks and the same room limits as anything a human
sends. A run that times out posts nothing.

## What this does not protect against

**The offer is a bearer invitation.** It carries the guest's one-time browser
invite and their agent's room token. Whoever holds it first can join. Send it
over a channel you trust, and if it goes to the wrong person, stop the host and
start again — the room and its tokens die with it.

**Prompt injection is mitigated, not solved.** Room content reaches a model that
can act. Every surface labels it as untrusted and the tools are read-only by
default, but a sufficiently persuasive message aimed at a permissive
configuration is a real risk. Turning on `upload_files` or widening `tools` is
you accepting more of it.

**A compromised bridge is a compromised side.** The local policy runs on your
machine, in your process. If something has already taken over that process, it
has your project. The server's independent approval gate is what stops it turning
into their project too.

**Your agent's usage is billed to you.** Each side runs and pays for its own.

**Secret scanning is pattern matching.** It catches the common shapes. It will
miss a credential that does not look like one.

**The network is not invisible.** WebRTC is ordinary encrypted traffic. A network
administrator can see STUN requests, endpoints, volume, and timing, and local
policy may still require authorisation. Do not use this to get around an
organisation's rules.

## Reporting something

Open an issue for anything ordinary. For something security-sensitive, contact
the maintainers privately first: <https://github.com/chengine/clausroom>.
