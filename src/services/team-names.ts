/** Slots 1–6 = team 1; 7–12 = team 2 (same split as rating-math / lobby). */
const TEAM_A_MAX_SLOT = 6;

const TEAM_DISPLAY_NAMES = {
  1: 'Z Fighters',
  2: 'Evil',
} as const;

/** User-facing team label (hardcoded; later map/guild can swap this map). */
export function teamDisplayName(team: 1 | 2): string {
  return TEAM_DISPLAY_NAMES[team];
}

/** Display name for a lobby slot. */
export function teamDisplayNameForSlot(slot: number): string {
  return teamDisplayName(slot <= TEAM_A_MAX_SLOT ? 1 : 2);
}
