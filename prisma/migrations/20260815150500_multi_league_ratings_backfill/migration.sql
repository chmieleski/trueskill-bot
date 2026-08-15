-- Migration: multi_league_ratings_backfill
--
-- What this does:
--   1. Creates a League row (gameId='warcraft3_udbr', name='UDBR') for every GuildConfig.
--   2. Identifies the "legacy" league — all existing Matches and ratings attach to it.
--      Override before prod apply by running:
--        SET app.multi_league_legacy_guild_id = '<your_discord_guild_snowflake>';
--      or it falls back to the first GuildConfig guildId, or 'LEGACY_UNSET'.
--   3. Backfills Match.leagueId with legacy league, then sets NOT NULL.
--   4. Adds leagueId to PlayerRating + PlayerHeroRating, backfills, rebuilds PKs.
--   5. Adds FK constraints and replaces old indexes with league-scoped composite ones.

DO $$
DECLARE
  legacy_guild     text;
  legacy_league_id text;
  cfg_guild        text;
BEGIN
  -- ── Step 1: resolve legacy guild snowflake ──────────────────────────────────
  legacy_guild := COALESCE(
    NULLIF(current_setting('app.multi_league_legacy_guild_id', true), ''),
    (SELECT "guildId" FROM "GuildConfig" LIMIT 1),
    'LEGACY_UNSET'
  );

  -- ── Step 2: create UDBR leagues for every GuildConfig ──────────────────────
  FOR cfg_guild IN SELECT "guildId" FROM "GuildConfig" LOOP
    INSERT INTO "League" ("id", "guildId", "gameId", "name", "updatedAt")
    VALUES (gen_random_uuid()::text, cfg_guild, 'warcraft3_udbr', 'UDBR', NOW())
    ON CONFLICT ("guildId", "gameId", "name") DO NOTHING;
  END LOOP;

  -- Guarantee the legacy guild has a league even if GuildConfig is empty
  INSERT INTO "League" ("id", "guildId", "gameId", "name", "updatedAt")
  VALUES (gen_random_uuid()::text, legacy_guild, 'warcraft3_udbr', 'UDBR', NOW())
  ON CONFLICT ("guildId", "gameId", "name") DO NOTHING;

  -- ── Step 3: resolve legacy league id ───────────────────────────────────────
  SELECT "id" INTO legacy_league_id
  FROM "League"
  WHERE "guildId" = legacy_guild
    AND "gameId"  = 'warcraft3_udbr'
    AND "name"    = 'UDBR';

  -- ── Step 4: backfill Match.leagueId ────────────────────────────────────────
  UPDATE "Match" SET "leagueId" = legacy_league_id WHERE "leagueId" IS NULL;

  -- ── Step 5: add + backfill PlayerRating.leagueId ───────────────────────────
  EXECUTE 'ALTER TABLE "PlayerRating" ADD COLUMN IF NOT EXISTS "leagueId" TEXT';
  EXECUTE format(
    'UPDATE "PlayerRating" SET "leagueId" = %L WHERE "leagueId" IS NULL',
    legacy_league_id
  );
  EXECUTE 'ALTER TABLE "PlayerRating" ALTER COLUMN "leagueId" SET NOT NULL';

  -- Drop old single-column PK and replace with composite PK
  EXECUTE 'ALTER TABLE "PlayerRating" DROP CONSTRAINT "PlayerRating_pkey"';
  EXECUTE 'ALTER TABLE "PlayerRating" ADD CONSTRAINT "PlayerRating_pkey" PRIMARY KEY ("leagueId", "playerId")';

  -- ── Step 6: add + backfill PlayerHeroRating.leagueId ───────────────────────
  EXECUTE 'ALTER TABLE "PlayerHeroRating" ADD COLUMN IF NOT EXISTS "leagueId" TEXT';
  EXECUTE format(
    'UPDATE "PlayerHeroRating" SET "leagueId" = %L WHERE "leagueId" IS NULL',
    legacy_league_id
  );
  EXECUTE 'ALTER TABLE "PlayerHeroRating" ALTER COLUMN "leagueId" SET NOT NULL';

  -- Drop old (playerId, heroId) PK and replace with (leagueId, playerId, heroId)
  EXECUTE 'ALTER TABLE "PlayerHeroRating" DROP CONSTRAINT "PlayerHeroRating_pkey"';
  EXECUTE 'ALTER TABLE "PlayerHeroRating" ADD CONSTRAINT "PlayerHeroRating_pkey" PRIMARY KEY ("leagueId", "playerId", "heroId")';

  -- ── Step 7: make Match.leagueId NOT NULL ────────────────────────────────────
  EXECUTE 'ALTER TABLE "Match" ALTER COLUMN "leagueId" SET NOT NULL';

END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Drop old single-dimension indexes superseded by league-scoped composites
DROP INDEX IF EXISTS "PlayerHeroRating_playerId_idx";
DROP INDEX IF EXISTS "PlayerHeroRating_heroId_idx";

-- New league-scoped indexes
CREATE INDEX IF NOT EXISTS "PlayerRating_leagueId_idx" ON "PlayerRating"("leagueId");
CREATE INDEX IF NOT EXISTS "PlayerHeroRating_leagueId_playerId_idx" ON "PlayerHeroRating"("leagueId", "playerId");
CREATE INDEX IF NOT EXISTS "PlayerHeroRating_leagueId_heroId_idx" ON "PlayerHeroRating"("leagueId", "heroId");

-- ── FK constraints ────────────────────────────────────────────────────────────
ALTER TABLE "PlayerRating"
  ADD CONSTRAINT "PlayerRating_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlayerHeroRating"
  ADD CONSTRAINT "PlayerHeroRating_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
