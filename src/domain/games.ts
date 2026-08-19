/** Catalog id for Ultimate Dragon Ball Reborn (Warcraft III). */
export const WARCRAFT3_UDBR_GAME_ID = 'warcraft3_udbr' as const;

/** Catalog id for Anime Choice Arena (Warcraft III 1.26). */
export const WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID = 'warcraft3_anime_choice_arena' as const;

export type KnownGameId =
  typeof WARCRAFT3_UDBR_GAME_ID | typeof WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID;
