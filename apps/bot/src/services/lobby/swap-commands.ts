import type { GameProfile } from '../../domain/game-profile.js';
import { formatBangSwap, wc3InGameSlot } from '../../games/warcraft3/bang-swap.js';
import { matchToLobbyPlayers, type MatchWithPlayers } from '../match/match-service.js';
import {
  loadLeagueWc3statsHeroSlotMap,
  type Wc3statsHeroSlotMap,
} from '../wc3stats/wc3stats-slot-map.js';
import {
  parseInGameRoster,
  parseInGameRosterSource,
  planSwapMoves,
  type InGameRosterEntry,
} from './in-game-roster.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import type { LobbySwapCommands } from './lobby-preview.js';

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

/** Swap commands for a PENDING lobby; undefined when there is no usable snapshot or nothing to do. */
export async function loadLobbySwapCommands(
  match: MatchWithPlayers,
  profile: GameProfile,
): Promise<LobbySwapCommands | undefined> {
  const snapshot = parseInGameRoster(match.inGameRoster);
  const source = parseInGameRosterSource(match.inGameRosterSource);
  if (!snapshot || !source || !match.inGameRosterAt || profile.lobbySwapCommand === 'none') {
    return undefined;
  }
  const leagueSlotMap = match.leagueId ? await loadLeagueWc3statsHeroSlotMap(match.leagueId) : null;
  const lines = buildSwapCommandLines({
    profile,
    target: matchToLobbyPlayers(match),
    snapshot,
    leagueSlotMap,
  });
  return lines.length > 0 ? { lines, source, observedAt: match.inGameRosterAt } : undefined;
}
