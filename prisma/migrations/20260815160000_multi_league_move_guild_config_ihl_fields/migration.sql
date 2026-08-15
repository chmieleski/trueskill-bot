-- Migration: multi_league_move_guild_config_ihl_fields
--
-- What this does:
--   1. Adds wc3stats/leaderboard/claim columns to League
--   2. Creates LeagueWc3statsSlotMap table (league-scoped replacement for GuildWc3statsSlotMap)
--   3. Copies GuildConfig IHL fields → matching UDBR League per guild
--      (prefers name='UDBR', falls back to any warcraft3_udbr league for the guild)
--   4. Copies GuildWc3statsSlotMap rows → LeagueWc3statsSlotMap for that league
--   5. Drops wc3stats/leaderboard/claim columns from GuildConfig
--   6. Drops GuildWc3statsSlotMap table

-- ── Step 1: Add IHL columns to League ─────────────────────────────────────────
ALTER TABLE "League"
  ADD COLUMN "wc3statsEnabled"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "wc3statsMapPattern"      TEXT,
  ADD COLUMN "wc3statsMapSha1"         TEXT,
  ADD COLUMN "leaderboardChannelId"    TEXT,
  ADD COLUMN "leaderboardMessageId"    TEXT,
  ADD COLUMN "lobbyPlayerClaimEnabled" BOOLEAN NOT NULL DEFAULT true;

-- ── Step 2: Create LeagueWc3statsSlotMap ──────────────────────────────────────
CREATE TABLE "LeagueWc3statsSlotMap" (
  "leagueId"     TEXT    NOT NULL,
  "wc3statsSlot" INTEGER NOT NULL,
  "heroId"       INTEGER NOT NULL,

  CONSTRAINT "LeagueWc3statsSlotMap_pkey" PRIMARY KEY ("leagueId", "wc3statsSlot")
);

CREATE INDEX "LeagueWc3statsSlotMap_leagueId_idx"
  ON "LeagueWc3statsSlotMap"("leagueId");

CREATE INDEX "LeagueWc3statsSlotMap_leagueId_heroId_idx"
  ON "LeagueWc3statsSlotMap"("leagueId", "heroId");

ALTER TABLE "LeagueWc3statsSlotMap"
  ADD CONSTRAINT "LeagueWc3statsSlotMap_leagueId_fkey"
  FOREIGN KEY ("leagueId") REFERENCES "League"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Step 3: Copy GuildConfig IHL fields → matching UDBR League ────────────────
-- For each guild with a GuildConfig row, find its preferred UDBR league
-- (name='UDBR' wins; otherwise earliest createdAt warcraft3_udbr league).
UPDATE "League" l
SET
  "wc3statsEnabled"         = COALESCE(gc."wc3statsEnabled",         false),
  "wc3statsMapPattern"      = gc."wc3statsMapPattern",
  "wc3statsMapSha1"         = gc."wc3statsMapSha1",
  "leaderboardChannelId"    = gc."leaderboardChannelId",
  "leaderboardMessageId"    = gc."leaderboardMessageId",
  "lobbyPlayerClaimEnabled" = COALESCE(gc."lobbyPlayerClaimEnabled", true)
FROM "GuildConfig" gc
WHERE l."guildId" = gc."guildId"
  AND l."gameId"  = 'warcraft3_udbr'
  AND l."id" = (
    SELECT l2."id"
    FROM "League" l2
    WHERE l2."guildId" = gc."guildId"
      AND l2."gameId"  = 'warcraft3_udbr'
    ORDER BY (l2."name" = 'UDBR') DESC, l2."createdAt" ASC
    LIMIT 1
  );

-- ── Step 4: Copy GuildWc3statsSlotMap → LeagueWc3statsSlotMap ────────────────
INSERT INTO "LeagueWc3statsSlotMap" ("leagueId", "wc3statsSlot", "heroId")
SELECT
  (
    SELECT l."id"
    FROM "League" l
    WHERE l."guildId" = sm."guildId"
      AND l."gameId"  = 'warcraft3_udbr'
    ORDER BY (l."name" = 'UDBR') DESC, l."createdAt" ASC
    LIMIT 1
  ) AS "leagueId",
  sm."wc3statsSlot",
  sm."heroId"
FROM "GuildWc3statsSlotMap" sm
WHERE (
  SELECT l."id"
  FROM "League" l
  WHERE l."guildId" = sm."guildId"
    AND l."gameId"  = 'warcraft3_udbr'
  ORDER BY (l."name" = 'UDBR') DESC, l."createdAt" ASC
  LIMIT 1
) IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Step 5: Drop IHL columns from GuildConfig ─────────────────────────────────
ALTER TABLE "GuildConfig"
  DROP COLUMN IF EXISTS "wc3statsEnabled",
  DROP COLUMN IF EXISTS "wc3statsMapPattern",
  DROP COLUMN IF EXISTS "wc3statsMapSha1",
  DROP COLUMN IF EXISTS "leaderboardChannelId",
  DROP COLUMN IF EXISTS "leaderboardMessageId",
  DROP COLUMN IF EXISTS "lobbyPlayerClaimEnabled";

-- ── Step 6: Drop GuildWc3statsSlotMap table ───────────────────────────────────
DROP TABLE IF EXISTS "GuildWc3statsSlotMap";
