CREATE TYPE "LeagueStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

ALTER TABLE "League" ADD COLUMN "status" "LeagueStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "League" ADD COLUMN "predecessorLeagueId" TEXT;
ALTER TABLE "League" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "League" ADD CONSTRAINT "League_predecessorLeagueId_fkey"
  FOREIGN KEY ("predecessorLeagueId") REFERENCES "League"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LeagueRolloverDraft" (
  "id" TEXT NOT NULL,
  "sourceLeagueId" TEXT NOT NULL,
  "successorName" TEXT NOT NULL,
  "resetMode" TEXT NOT NULL,
  "compression" DOUBLE PRECISION,
  "actorDiscordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeagueRolloverDraft_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LeagueRolloverDraft" ADD CONSTRAINT "LeagueRolloverDraft_sourceLeagueId_fkey"
  FOREIGN KEY ("sourceLeagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LeagueRolloverDraft_sourceLeagueId_actorDiscordId_createdAt_idx"
  ON "LeagueRolloverDraft"("sourceLeagueId", "actorDiscordId", "createdAt");
