import type { GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import {
  toWc3statsHeroSlotMap,
  UDBR_WC3STATS_SLOT_MAP,
  WOS_WC3STATS_SLOT_MAP,
  type Wc3statsHeroSlotMap,
} from '../../services/wc3stats/wc3stats-slot-map.js';

/** Host-bot command: `!swap <name|slot> <name|slot>`; hero names are not accepted. */
export function formatBangSwap(name: string, inGameSlot: number): string {
  return `!swap ${name} ${inGameSlot}`;
}

const PRESET_MAPS: Record<string, Wc3statsHeroSlotMap> = {
  [WARCRAFT3_UDBR_GAME_ID]: toWc3statsHeroSlotMap(UDBR_WC3STATS_SLOT_MAP),
  [WARCRAFT3_WOS_GAME_ID]: toWc3statsHeroSlotMap(WOS_WC3STATS_SLOT_MAP),
};

function inGameSlotFromMap(map: Wc3statsHeroSlotMap | null | undefined, botSlot: number) {
  for (const [wc3statsIndex, heroSlot] of map ?? []) {
    if (heroSlot === botSlot) {
      return wc3statsIndex + 1;
    }
  }
  return undefined;
}

/**
 * Bot slot → Warcraft lobby slot number (wc3stats index + 1).
 * League slot map first, then the game's preset, then the bot slot itself.
 */
export function wc3InGameSlot(
  profile: GameProfile,
  leagueSlotMap: Wc3statsHeroSlotMap | null,
  botSlot: number,
): number {
  return (
    inGameSlotFromMap(leagueSlotMap, botSlot) ??
    inGameSlotFromMap(PRESET_MAPS[profile.gameId], botSlot) ??
    botSlot
  );
}
