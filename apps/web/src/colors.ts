/**
 * Participant accent colors. The canonical two-humans-two-agents room gets
 * fixed colors (host human amber, host agent rose, guest human emerald, guest
 * agent sky); any extra participants cycle a warm-friendly palette. "Host" is
 * the room owner; "guest" is the next human to join.
 */
import type { Participant } from '@clausroom/protocol';

export const HOST_HUMAN_COLOR = '#fbbf24';
export const HOST_AGENT_COLOR = '#fb7185';
export const GUEST_HUMAN_COLOR = '#34d399';
export const GUEST_AGENT_COLOR = '#38bdf8';
export const SYSTEM_COLOR = '#a39684';

export const EXTRA_PALETTE: readonly string[] = [
  '#fb923c',
  '#f472b6',
  '#facc15',
  '#a3e635',
  '#2dd4bf',
  '#fda4af',
];

function byJoined(a: Participant, b: Participant): number {
  if (a.user.created_at !== b.user.created_at) {
    return a.user.created_at < b.user.created_at ? -1 : 1;
  }
  return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

export function buildColorMap(participants: Participant[]): Map<string, string> {
  const map = new Map<string, string>();
  const ordered = [...participants].sort(byJoined);

  const humans = ordered.filter((p) => p.user.kind === 'human');
  humans.sort((a, b) => {
    const aOwner = a.role === 'owner' ? 0 : 1;
    const bOwner = b.role === 'owner' ? 0 : 1;
    return aOwner - bOwner || byJoined(a, b);
  });
  const hostHuman = humans[0];
  const guestHuman = humans[1];
  if (hostHuman) map.set(hostHuman.user_id, HOST_HUMAN_COLOR);
  if (guestHuman) map.set(guestHuman.user_id, GUEST_HUMAN_COLOR);

  let hostAgentTaken = false;
  let guestAgentTaken = false;
  for (const p of ordered) {
    if (p.user.kind !== 'agent') continue;
    if (!hostAgentTaken && hostHuman && p.user.owner_user_id === hostHuman.user_id) {
      map.set(p.user_id, HOST_AGENT_COLOR);
      hostAgentTaken = true;
    } else if (!guestAgentTaken && guestHuman && p.user.owner_user_id === guestHuman.user_id) {
      map.set(p.user_id, GUEST_AGENT_COLOR);
      guestAgentTaken = true;
    }
  }

  let extra = 0;
  for (const p of ordered) {
    if (map.has(p.user_id)) continue;
    map.set(p.user_id, EXTRA_PALETTE[extra % EXTRA_PALETTE.length] ?? SYSTEM_COLOR);
    extra += 1;
  }
  return map;
}

export function colorFor(map: Map<string, string>, userId: string): string {
  return map.get(userId) ?? SYSTEM_COLOR;
}
