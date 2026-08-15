ALTER TABLE "League" ADD COLUMN "rankResetEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "rankResetCooldownDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE "PlayerRankReset" (
    "id" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "actorDiscordId" TEXT NOT NULL,
    "targetDiscordId" TEXT,
    "staffOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerRankReset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlayerRankReset_leagueId_playerId_createdAt_idx" ON "PlayerRankReset"("leagueId", "playerId", "createdAt");
CREATE INDEX "PlayerRankReset_leagueId_createdAt_idx" ON "PlayerRankReset"("leagueId", "createdAt");

ALTER TABLE "PlayerRankReset" ADD CONSTRAINT "PlayerRankReset_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayerRankReset" ADD CONSTRAINT "PlayerRankReset_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
