-- Rename Anime Choice Arena catalog id to WOS
INSERT INTO "Game" ("id", "displayName")
VALUES ('warcraft3_wos', 'WOS')
ON CONFLICT ("id") DO UPDATE SET "displayName" = EXCLUDED."displayName";

UPDATE "League" SET "gameId" = 'warcraft3_wos' WHERE "gameId" = 'warcraft3_anime_choice_arena';
UPDATE "Event" SET "gameId" = 'warcraft3_wos' WHERE "gameId" = 'warcraft3_anime_choice_arena';
UPDATE "Player" SET "gameId" = 'warcraft3_wos' WHERE "gameId" = 'warcraft3_anime_choice_arena';

DELETE FROM "Game" WHERE "id" = 'warcraft3_anime_choice_arena';

-- Post-match stats (WOS2 bot report)
CREATE TABLE "MatchStatsReport" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "team1Rounds" INTEGER,
    "team2Rounds" INTEGER,
    "playerCount" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedByDiscordId" TEXT NOT NULL,

    CONSTRAINT "MatchStatsReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MatchPlayerStats" (
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "reportIndex" INTEGER NOT NULL,
    "reportPid" INTEGER NOT NULL,
    "reportWin" BOOLEAN,
    "kills" INTEGER NOT NULL,
    "deaths" INTEGER NOT NULL,
    "damagePhys" INTEGER NOT NULL,
    "damageMagic" INTEGER NOT NULL,
    "damageTotal" INTEGER NOT NULL,
    "heal" INTEGER NOT NULL,
    "takenPhys" INTEGER NOT NULL,
    "takenMagic" INTEGER NOT NULL,
    "takenTotal" INTEGER NOT NULL,
    "heroObjectId" INTEGER,
    "heroName" TEXT,
    "itemSlot1" INTEGER NOT NULL DEFAULT 0,
    "itemSlot2" INTEGER NOT NULL DEFAULT 0,
    "itemSlot3" INTEGER NOT NULL DEFAULT 0,
    "itemSlot4" INTEGER NOT NULL DEFAULT 0,
    "itemSlot5" INTEGER NOT NULL DEFAULT 0,
    "itemSlot6" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MatchPlayerStats_pkey" PRIMARY KEY ("matchId","playerId")
);

CREATE UNIQUE INDEX "MatchStatsReport_matchId_key" ON "MatchStatsReport"("matchId");

CREATE INDEX "MatchPlayerStats_matchId_idx" ON "MatchPlayerStats"("matchId");

ALTER TABLE "MatchStatsReport" ADD CONSTRAINT "MatchStatsReport_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MatchPlayerStats" ADD CONSTRAINT "MatchPlayerStats_matchId_playerId_fkey" FOREIGN KEY ("matchId", "playerId") REFERENCES "MatchPlayer"("matchId", "playerId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MatchPlayerStats" ADD CONSTRAINT "MatchPlayerStats_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MatchPlayerStats" ADD CONSTRAINT "MatchPlayerStats_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MatchStatsReport"("matchId") ON DELETE CASCADE ON UPDATE CASCADE;
