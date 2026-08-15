ALTER TABLE "Match" ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "Match_leagueId_completedAt_idx" ON "Match"("leagueId", "completedAt");

CREATE TYPE "MatchRatingEntityKind" AS ENUM ('GLOBAL', 'HERO');

CREATE TABLE "MatchRatingSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "entityKind" "MatchRatingEntityKind" NOT NULL,
    "heroId" INTEGER NOT NULL,
    "mu" DOUBLE PRECISION NOT NULL,
    "sigma" DOUBLE PRECISION NOT NULL,
    "matchesPlayed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchRatingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MatchRatingSnapshot_matchId_playerId_entityKind_heroId_key"
  ON "MatchRatingSnapshot"("matchId", "playerId", "entityKind", "heroId");
CREATE INDEX "MatchRatingSnapshot_matchId_idx" ON "MatchRatingSnapshot"("matchId");

ALTER TABLE "MatchRatingSnapshot"
  ADD CONSTRAINT "MatchRatingSnapshot_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MatchRatingSnapshot"
  ADD CONSTRAINT "MatchRatingSnapshot_playerId_fkey"
  FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
