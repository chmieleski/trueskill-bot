-- Rename Anime Choice Arena catalog entry to WOS (FKs use ON UPDATE CASCADE).
UPDATE "Game"
SET "id" = 'warcraft3_wos', "displayName" = 'WOS'
WHERE "id" = 'warcraft3_anime_choice_arena';
