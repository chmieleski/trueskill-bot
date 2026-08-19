import { getGameProfile, teamForSlot, type GameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

function resolvedTeamNames(profile?: GameProfile): { 1: string; 2: string } {
  return (profile ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID)).teamNames;
}

/** User-facing team label. Omit profile for UDBR names (slash registration + OCR). */
export function teamDisplayName(team: 1 | 2, profile?: GameProfile): string {
  return resolvedTeamNames(profile)[team];
}

/**
 * Runtime winner copy for report / complete / flip. Profile is required so ACA
 * uses Team A / Team B instead of the UDBR slash-choice defaults.
 */
export function winnerLabel(team: 1 | 2, profile: GameProfile): string {
  return teamDisplayName(team, profile);
}

/** Display name for a lobby slot. Omit profile to use UDBR slot split and names. */
export function teamDisplayNameForSlot(slot: number, profile?: GameProfile): string {
  const resolved = profile ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID);
  return teamDisplayName(teamForSlot(resolved, slot), resolved);
}
