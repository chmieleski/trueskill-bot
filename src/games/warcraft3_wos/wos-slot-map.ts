/** wc3stats player slot index (pid) → bot lobby slot (1–10) for WOS. */
export type WosWc3statsSlotMapping = {
  wc3statsSlot: number;
  heroId: number;
};

/**
 * WOS player colors (wc3stats index → bot slot), verified on Anime_WOS2_0.30:
 * Team A (wc3 team 0): red, blue, teal, purple, yellow → slots 1–5
 * Team B (wc3 team 1): orange, green, pink, gray, light_blue → slots 6–10
 */
export const WOS_WC3STATS_SLOT_MAP: ReadonlyArray<WosWc3statsSlotMapping> = [
  { wc3statsSlot: 0, heroId: 1 },
  { wc3statsSlot: 1, heroId: 2 },
  { wc3statsSlot: 2, heroId: 3 },
  { wc3statsSlot: 3, heroId: 4 },
  { wc3statsSlot: 4, heroId: 5 },
  { wc3statsSlot: 5, heroId: 6 },
  { wc3statsSlot: 6, heroId: 7 },
  { wc3statsSlot: 7, heroId: 8 },
  { wc3statsSlot: 8, heroId: 9 },
  { wc3statsSlot: 9, heroId: 10 },
];
