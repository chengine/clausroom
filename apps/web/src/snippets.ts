/**
 * Ready-made onboarding snippets shown once when a participant + token is
 * minted. Shapes mirror the product spec (safe_agent_chatroom_implementation.md
 * sections 6.2 and 7.3) and the binding bridge config in docs/API-CONTRACT.md
 * section 13.
 */
import { slugify } from './format.js';

export interface AgentSnippetInput {
  serverUrl: string;
  roomId: string;
  agentName: string;
  ownerHumanName: string;
  bridgeToken: string;
}

export function bridgeToml(input: AgentSnippetInput): string {
  const bridgeName = `${slugify(input.agentName)}-bridge`;
  return `[identity]
human_name  = ${tomlString(input.ownerHumanName)}
agent_name  = ${tomlString(input.agentName)}
bridge_name = ${tomlString(bridgeName)}

[room]
server_url = ${tomlString(input.serverUrl)}
room_id    = ${tomlString(input.roomId)}
token_env  = "AGENT_ROOM_BRIDGE_TOKEN"

[policy]
read_only_default                  = true
allow_agent_to_send_text           = true
allow_agent_to_upload_files        = false
require_human_approval_for_uploads = true
max_upload_bytes_without_approval  = 1048576
max_upload_bytes_absolute          = 104857600

[filesystem]
roots         = ["/path/to/project"]
deny_globs    = []
downloads_dir = "~/.clausroom/downloads"
`;
}

export function exportTokenLine(bridgeToken: string): string {
  return `export AGENT_ROOM_BRIDGE_TOKEN="${bridgeToken}"`;
}

/**
 * The `claude mcp add` line for an agent connected via the one-command join flow.
 * Once `clausroom-bridge` is published to npm the bridge is spawned with `npx`
 * (no repo path to edit), and `clausroom-bridge join <blob>` has already written
 * ~/.clausroom/bridge.toml and exported AGENT_ROOM_BRIDGE_TOKEN. This registers
 * the bridge with Claude Code — the equivalent of what `join` prints (§13 step 4).
 */
export function claudeMcpAddJoin(): string {
  return [
    'claude mcp add --transport stdio clausroom \\',
    '  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \\',
    '  -- npx -y clausroom-bridge mcp --config ~/.clausroom/bridge.toml',
  ].join('\n');
}

/**
 * The one-link guest join URL: `<serverUrl>/join#i=<invite>`. The invite rides in
 * the URL fragment (never the query string) so it stays out of server logs and
 * the Referer header (docs/API-CONTRACT.md §1 "Web join links"). Single-use.
 */
export function guestJoinLink(serverUrl: string, inviteToken: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/join#i=${inviteToken}`;
}

export function claudeMcpAddCommand(): string {
  // `clausroom-bridge` is a private workspace bin and is never on PATH, so the
  // snippet must spawn the built entry point directly (same form as README.md
  // and examples/claude-code-setup.md). The path placeholder is the only part
  // the remote human has to edit. Once the bridge is published to npm, the
  // commented npx line replaces the node path invocation.
  return [
    'claude mcp add --transport stdio clausroom \\',
    '  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \\',
    '  -- node /path/to/clausroom/apps/bridge/dist/index.js mcp --config ~/.clausroom/bridge.toml',
    '# Once clausroom-bridge is published to npm, use npx instead of the node path:',
    '#   -- npx clausroom-bridge mcp --config ~/.clausroom/bridge.toml',
  ].join('\n');
}

export function agentOnboardingText(input: AgentSnippetInput): string {
  return [
    '# 1. Save this as ~/.clausroom/bridge.toml (edit filesystem.roots):',
    '',
    bridgeToml(input),
    '# 2. Put the bridge token in the environment (shown once — store it safely):',
    '',
    exportTokenLine(input.bridgeToken),
    '',
    '# 3. Connect Claude Code to the bridge (replace /path/to/clausroom with',
    '#    the directory where the clausroom repo is cloned and built):',
    '',
    claudeMcpAddCommand(),
    '',
  ].join('\n');
}

export interface HumanSnippetInput {
  serverUrl: string;
  roomName: string;
  inviteToken: string;
}

export function humanOnboardingText(input: HumanSnippetInput): string {
  return [
    `You're invited to the clausroom "${input.roomName}".`,
    '',
    'Open this one-time link — it signs you in and drops you straight into the room:',
    '',
    `   ${guestJoinLink(input.serverUrl, input.inviteToken)}`,
    '',
    `If the link doesn't open, go to ${input.serverUrl}/ and paste this token on the`,
    `sign-in screen instead: ${input.inviteToken}`,
    '',
    'The link (and token) work exactly once and sign you in as yourself.',
  ].join('\n');
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
