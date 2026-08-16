import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from './games.js';

export type HeroBinding = 'slot_bound' | 'optional_in_game';
export type GameImportKind = 'none' | 'wc3stats';

export type GameProfile = {
  gameId: string;
  displayName: string;
  slotCount: number;
  teamAMaxSlot: number;
  heroBinding: HeroBinding;
  import: GameImportKind;
  teamNames: { 1: string; 2: string };
};

export class UnknownGameIdError extends Error {
  constructor(gameId: string) {
    super(`Unknown game id: ${gameId}`);
    this.name = 'UnknownGameIdError';
  }
}

const GAME_PROFILES: Record<string, GameProfile> = {
  [WARCRAFT3_UDBR_GAME_ID]: {
    gameId: WARCRAFT3_UDBR_GAME_ID,
    displayName: 'Ultimate Dragon Ball Reborn',
    slotCount: 12,
    teamAMaxSlot: 6,
    heroBinding: 'slot_bound',
    import: 'wc3stats',
    teamNames: { 1: 'Z Fighters', 2: 'Evil' },
  },
  [WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID]: {
    gameId: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
    displayName: 'Anime Choice Arena',
    slotCount: 10,
    teamAMaxSlot: 5,
    heroBinding: 'optional_in_game',
    import: 'none',
    teamNames: { 1: 'Team A', 2: 'Team B' },
  },
};

/** Returns the catalog profile for a known game id. */
export function getGameProfile(gameId: string): GameProfile {
  const profile = GAME_PROFILES[gameId];
  if (!profile) {
    throw new UnknownGameIdError(gameId);
  }
  return profile;
}

/** True when slot is an integer in [1, profile.slotCount]. */
export function isSlotInProfile(profile: GameProfile, slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= profile.slotCount;
}

/** Returns team 1 or 2 for a valid slot; throws RangeError otherwise. */
export function teamForSlot(profile: GameProfile, slot: number): 1 | 2 {
  if (!isSlotInProfile(profile, slot)) {
    throw new RangeError(`Slot ${slot} is out of range for ${profile.gameId}`);
  }
  return slot <= profile.teamAMaxSlot ? 1 : 2;
}

/** Returns slot as hero id when slot_bound; otherwise null. */
export function rosterHeroId(profile: GameProfile, slot: number): number | null {
  if (profile.heroBinding === 'slot_bound') {
    return slot;
  }
  return null;
}

/** User-facing message for an invalid slot on this game. */
export function invalidSlotMessage(profile: GameProfile): string {
  return `Invalid slot. This game uses slots 1–${profile.slotCount}.`;
}
