-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventBindingKind" AS ENUM ('CHANNEL', 'CATEGORY');

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventChannelBinding" (
    "eventId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "kind" "EventBindingKind" NOT NULL,

    CONSTRAINT "EventChannelBinding_pkey" PRIMARY KEY ("discordId")
);

CREATE INDEX "Event_guildId_idx" ON "Event"("guildId");
CREATE INDEX "Event_gameId_idx" ON "Event"("gameId");
CREATE INDEX "Event_guildId_gameId_idx" ON "Event"("guildId", "gameId");
CREATE INDEX "EventChannelBinding_eventId_idx" ON "EventChannelBinding"("eventId");

ALTER TABLE "Event" ADD CONSTRAINT "Event_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EventChannelBinding" ADD CONSTRAINT "EventChannelBinding_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Match" ADD COLUMN "eventId" TEXT;
ALTER TABLE "Match" DROP CONSTRAINT "Match_leagueId_fkey";
ALTER TABLE "Match" ALTER COLUMN "leagueId" DROP NOT NULL;
ALTER TABLE "Match" ADD CONSTRAINT "Match_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Match_eventId_status_idx" ON "Match"("eventId", "status");
CREATE INDEX "Match_eventId_completedAt_idx" ON "Match"("eventId", "completedAt");
ALTER TABLE "Match" ADD CONSTRAINT "Match_league_xor_event_check" CHECK (
  ("leagueId" IS NOT NULL AND "eventId" IS NULL)
  OR ("leagueId" IS NULL AND "eventId" IS NOT NULL)
);
