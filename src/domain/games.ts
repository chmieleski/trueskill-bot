/** Catalog id for Ultimate Dragon Ball Reborn (Warcraft III). */
export const WARCRAFT3_UDBR_GAME_ID = 'warcraft3_udbr' as const;

/** Catalog id for WOS (Warcraft III 1.26). */
export const WARCRAFT3_WOS_GAME_ID = 'warcraft3_wos' as const;

export type KnownGameId = typeof WARCRAFT3_UDBR_GAME_ID | typeof WARCRAFT3_WOS_GAME_ID;
