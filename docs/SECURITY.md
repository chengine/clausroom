# Security model

Clausroom is designed to let two people share one room without giving either
person general network or filesystem access to the other's machine. It assumes
that each user controls their own code machine, browser, SSH account, and local
agent installation.

## Network boundary

- The host room server and guest connector bind only `127.0.0.1`; Clausroom
  exposes no public HTTP, SSH, or filesystem port.
- A browser on another machine reaches only its owner's loopback service through
  an existing SSH connection. The generated `LocalForward` binds both ends to
  loopback and contains no key, password, or Clausroom token.
- Local browser control and tunnel WebSockets require a random 256-bit secret
  plus the exact loopback `Host` and `Origin`.
- The guest classifies a connection by its first request as room traffic or
  local UI traffic. The tunnel protocol itself has no host, port, command, or
  path field, and the host endpoint always opens only the room server's own
  loopback port. Server authentication remains the per-request boundary.
- WebRTC encrypts the browser-to-browser leg with DTLS. TURN is rejected, and
  the browsers refuse a selected ICE pair if either candidate is a relay or the
  direct pair cannot be proved.

The peer therefore receives room HTTP/WebSocket traffic, not a network proxy.
Every API request still needs a valid bearer token and room membership.

## Signaling and credentials

The pasted offer and answer contain ICE/SDP connection details and DTLS
fingerprints, but no room token. Send them through a channel where you can
identify the other person: an attacker who can replace both signaling messages
can impersonate a peer. The codes also reveal candidate network addresses.

The printed browser URLs are more sensitive. The host URL hands its browser the
owner session, local peer secret, and pending guest credentials; the guest URL
contains its local peer secret. These values are placed in a URL fragment, which
is not sent in HTTP, stripped from the address bar immediately, and retained in
tab-scoped `sessionStorage`. Do not share either URL.

The guest credentials cross only after the direct DTLS channel opens. Human
invites are single-use. Rotating a participant token revokes its older tokens
and disconnects its live room sockets; a new host run also revokes old owner
sessions. Agent tokens are scoped to one room. The database stores token hashes
rather than usable tokens. Each code machine writes its active local agent
token to a mode `0600` session file on POSIX and removes it on normal shutdown.

Room data and token-hash records persist in the host database. Stopping the
command ends network access but is not data erasure; a leaked active token must
still be treated as compromised.

Clausroom enforces private file and directory modes on POSIX. On Windows, local
at-rest isolation depends on the ACLs of the user's profile and configured data
directory.

## Files and room content

The peer transport never accepts a filesystem path. The room server accesses
only its database and artifact storage. A collaborator cannot browse, mount, or
address the other repository through Clausroom.

A local agent can deliberately send text into chat. Its artifact-upload tool is
stricter:

- uploads are disabled by default;
- the source must resolve, including symlinks, to a regular file inside that
  side's configured project;
- always-denied paths and common credential patterns are refused locally;
- the agent's human must approve the exact sanitized filename, description,
  byte count, and SHA-256 digest;
- both the bridge and server verify that manifest, and one approval authorizes
  one upload.

A human may upload through their own browser without an approval, because that
is the explicit human action. A room retains at most 1 GiB of artifacts.
Downloads initiated by an agent go only to its private local
`~/.clausroom/downloads` directory and must be treated as untrusted.

All room members can receive room messages and artifacts. Recipient labels are
addressing, not encryption or private messages. The host stores chat and
artifacts in plaintext unless the host filesystem provides its own encryption.

## Agent boundary

Room content is labelled as untrusted before it reaches an auto-responder. The
default configuration requests read-only tools, sets the project working
directory, and enforces a turn limit, output limit, and wall-clock timeout;
outbound text also passes local and server-side secret/blob checks. Users can
weaken these defaults by changing the agent command or tools.

`project.dir` is a strict boundary for Clausroom file-transfer tools, not an OS
sandbox around a third-party engine. Claude, Codex, or a custom command may read
anything its own sandbox permits, and auto mode can be influenced by untrusted
room text. The selected engine and its sandbox therefore remain part of that
user's trusted computing base. Secret scanning recognizes common patterns, not
every possible secret, and ordinary-looking source text can still be sent as
chat by an enabled agent. Leave `--auto` off if that trust is inappropriate.

Room pause controls and the consecutive-agent-turn limit reject agent message
posts. They do not kill the local agent process, revoke its token, or suspend
every API operation; stop the local command or agent for a full local cutoff.

## Operational limits

Direct-only WebRTC is an availability tradeoff. Symmetric NAT, blocked UDP/TCP,
or restrictive policy can prevent a connection, and Clausroom has no relay
fallback.

Encryption does not make the connection invisible. STUN services and network
administrators can observe endpoints, timing, and traffic volume, and each peer
learns the other's selected candidate addresses. Clausroom is not a firewall or
policy bypass; use it only where local rules permit it.

A compromised browser, CLI, agent, operating-system account, or host database
can defeat that side's protections. Clausroom isolates cooperative endpoints; it
does not repair an already-compromised machine.
