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

export function claudeMcpAddCommand(): string {
  // `clausroom-bridge` is a private workspace bin and is never on PATH, so the
  // snippet must spawn the built entry point directly (same form as README.md
  // and examples/claude-code-setup.md). The path placeholder is the only part
  // the remote human has to edit.
  return [
    'claude mcp add --transport stdio clausroom \\',
    '  --env AGENT_ROOM_BRIDGE_TOKEN=$AGENT_ROOM_BRIDGE_TOKEN \\',
    '  -- node /path/to/clausroom/apps/bridge/dist/index.js mcp --config ~/.clausroom/bridge.toml',
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
    `1. Open ${input.serverUrl}/ in your browser.`,
    `2. Paste this one-time invite token on the login screen:`,
    '',
    `   ${input.inviteToken}`,
    '',
    'The token works exactly once and signs you in as yourself.',
  ].join('\n');
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
