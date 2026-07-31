# Direct WebRTC peer mode

Peer mode gives Clausroom a videogame-style listen host without publishing the
Clausroom web server to the Internet.

```text
HOST                                             GUEST

browser/agent ─▶ 127.0.0.1:Clausroom             browser/agent
                       ▲                              │
                       │ fixed target                 ▼
                  peer host ══ encrypted WebRTC ══ peer join
                                                       │
                                                       ▼
                                             127.0.0.1:random-port
```

The host remains the authoritative room server. WebRTC changes only the network
transport: existing HTTP, WebSocket, chat, approval, and artifact-transfer
behavior passes through reliable ordered data channels unchanged.

## What you need

- Node.js 20 or newer on both machines.
- The host's normal Clausroom source checkout and build.
- A private channel for exchanging the generated offer and answer text.
- Networks that permit some direct ICE path between the machines.

You do **not** need Tailscale, Docker, a domain, a TLS certificate, an SSH key,
a router port-forward, a hosted signaling service, or a public Clausroom TCP
listener.

## Recommended setup

On the host:

```bash
npm install
npm run build
npm run up -- --peer
```

After the launcher creates the room, it prints one long line beginning with
`CLAUSROOM_PEER_OFFER`. Send the complete line privately to the guest.

On the guest:

```bash
npx -y clausroom-bridge peer join
```

Paste the offer when prompted. Send the resulting
`CLAUSROOM_PEER_ANSWER ...` line privately to the host, who pastes it into the
still-running host command.

When ICE and peer authentication succeed, the guest sees:

```text
CLAUSROOM_PEER_PATH direct ...
CLAUSROOM_PEER_READY http://127.0.0.1:49152
```

The port is an example and normally changes each run. The guest opens that
loopback URL in a browser and uses the same URL as `room.server_url` in
`bridge.toml`. Leave both peer commands running while using the room.

## Running the tunnel separately

If the Clausroom server is already running on host loopback:

```bash
# Host
npx -y clausroom-bridge peer host --target http://127.0.0.1:3000

# Guest
npx -y clausroom-bridge peer join
```

`--target` accepts only `http://127.0.0.1:<port>`,
`http://localhost:<port>`, or IPv6 loopback. The join side always listens only
on `127.0.0.1`; `--listen-port 0` chooses a free port.

The defaults use the public STUN services
`stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`. To use a
different discovery service, repeat `--stun`:

```bash
npx -y clausroom-bridge peer host \
  --stun stun:stun.example.edu:3478
```

For same-network testing, both sides can pass `--no-stun`. STUN sees source IP
and timing metadata but never carries Clausroom content.

## Security boundary

- **No public application listener.** In `npm run up -- --peer`, the launcher
  overrides `AGENT_ROOM_HOST` to `127.0.0.1`, even if the shell exported a
  broader bind address.
- **Fixed host destination.** The host tunnel can open connections only to the
  one validated loopback Clausroom port supplied at startup. It is not a SOCKS
  proxy and cannot select SSH, a file-sharing service, or another address.
- **Guest loopback only.** The joining peer's local proxy binds to
  `127.0.0.1`, so other LAN or Internet machines cannot use it.
- **Authenticated encryption.** ICE chooses connectivity; DTLS authenticates
  the fingerprints in the manually exchanged SDP and encrypts each WebRTC data
  channel. A small application handshake binds the connection to the generated
  session.
- **Direct means direct.** TURN URLs are rejected, and a selected relay
  candidate is refused. `CLAUSROOM_PEER_PATH direct ...` reports the chosen
  candidate pair.
- **Application controls remain active.** Invite/session/bridge tokens, room
  membership, message logging, size limits, secret scanning, hash verification,
  and artifact approval all operate exactly as they do over Tailscale.
- **No filesystem protocol.** The peer layer transports bytes for the
  Clausroom application only. Local repositories remain visible only to their
  local coding-agent bridges under each side's configured filesystem policy.

The offer and answer contain ephemeral ICE candidates, DTLS fingerprints, and
session data. Treat them as one-session capability material: exchange them
privately, do not post them publicly, and restart both commands if either code
is sent to the wrong person.

`node-datachannel` is the peer command's platform-specific WebRTC runtime. It is
an optional dependency and is loaded only for `peer host` or `peer join`; it is
not a Docker dependency and does not alter the ordinary server/MCP paths.

## When direct mode cannot connect

Direct ICE is not guaranteed. Symmetric/carrier-grade NAT, outbound UDP blocks,
VPN routing, or tightly managed institutional firewalls can prevent a usable
candidate pair. Peer mode times out and fails closed in that case.

A TURN service would improve success by relaying encrypted traffic, but then a
hosted data intermediary exists. This implementation intentionally does not
support TURN. Use the existing Tailscale deployment when the networks cannot
establish a direct path.

WebRTC is ordinary encrypted peer traffic, not an invisibility mechanism.
Network administrators may see STUN requests, UDP flows, endpoints, volume, and
timing, and local policy may still require authorization. Do not use peer mode
to bypass an organization's access rules.

## Verification

The repository includes an end-to-end local test that manually shuttles a real
offer/answer between two bridge processes and transfers multi-megabyte request
and response bodies:

```bash
npm run smoke:peer
```

For a live session, check all of the following:

1. Clausroom reports `CLAUSROOM_LISTENING` on `127.0.0.1`.
2. Both peers print `CLAUSROOM_PEER_PATH direct`, never `relay`.
3. The guest URL begins with `http://127.0.0.1:`.
4. The guest can load `/healthz`, log in, receive live messages, and transfer a
   deliberately non-sensitive test artifact.
5. Neither machine has a new public TCP listener for Clausroom or SSH.
