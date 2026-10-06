import type { GameProfile } from '../../domain/game-profile.js';
import { formatBangSwap, wc3InGameSlot } from '../../games/warcraft3/bang-swap.js';
import type { Wc3statsHeroSlotMap } from '../wc3stats/wc3stats-slot-map.js';
import { planSwapMoves, type InGameRosterEntry } from './in-game-roster.js';
import type { LobbyPlayer } from './lobby-ocr.js';

/**
 * Copy-paste in-game commands turning the last game read into the Discord roster,
 * ordered by in-game slot. Empty when the game has no swap command.
 */
export function buildSwapCommandLines(input: {
  profile: GameProfile;
  target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>;
  snapshot: ReadonlyArray<InGameRosterEntry>;
  leagueSlotMap: Wc3statsHeroSlotMap | null;
}): string[] {
  if (input.profile.lobbySwapCommand === 'none') {
    return [];
  }
  return planSwapMoves(input.target, input.snapshot)
    .map((move) => ({
      name: move.name,
      inGameSlot: wc3InGameSlot(input.profile, input.leagueSlotMap, move.botSlot),
    }))
    .sort((a, b) => a.inGameSlot - b.inGameSlot)
    .map((move) => formatBangSwap(move.name, move.inGameSlot));
}
