/**
 * Participant accent colors, expressed as CSS variable references so every
 * theme (see styles.css) can restyle them: the canonical two-humans-two-agents
 * room gets fixed slots (host human / host agent / guest human / guest agent);
 * any extra participants cycle the --pc-extra-* palette. "Host" is the room
 * owner; "guest" is the next human to join. Consumers assign these strings to
 * the --pc custom property; derived tints use color-mix() in styles.css.
 */
import type { Participant } from '@clausroom/protocol';

export const HOST_HUMAN_COLOR = 'var(--pc-host-human)';
export const HOST_AGENT_COLOR = 'var(--pc-host-agent)';
export const GUEST_HUMAN_COLOR = 'var(--pc-guest-human)';
export const GUEST_AGENT_COLOR = 'var(--pc-guest-agent)';
export const SYSTEM_COLOR = 'var(--pc-system)';

export const EXTRA_PALETTE: readonly string[] = [
  'var(--pc-extra-0)',
  'var(--pc-extra-1)',
  'var(--pc-extra-2)',
  'var(--pc-extra-3)',
  'var(--pc-extra-4)',
  'var(--pc-extra-5)',
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
