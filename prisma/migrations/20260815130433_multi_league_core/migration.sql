-- CreateEnum
CREATE TYPE "LeagueBindingKind" AS ENUM ('CHANNEL', 'CATEGORY');

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "leagueId" TEXT;

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "League" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueChannelBinding" (
    "leagueId" TEXT NOT NULL,
    "discordId" TEXT NOT NULL,
    "kind" "LeagueBindingKind" NOT NULL,

    CONSTRAINT "LeagueChannelBinding_pkey" PRIMARY KEY ("discordId")
);

-- CreateIndex
CREATE INDEX "League_guildId_idx" ON "League"("guildId");

-- CreateIndex
CREATE INDEX "League_gameId_idx" ON "League"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "League_guildId_gameId_name_key" ON "League"("guildId", "gameId", "name");

-- CreateIndex
CREATE INDEX "LeagueChannelBinding_leagueId_idx" ON "LeagueChannelBinding"("leagueId");

-- CreateIndex
CREATE INDEX "Match_leagueId_status_idx" ON "Match"("leagueId", "status");

-- CreateIndex
CREATE INDEX "Match_leagueId_wc3statsGameId_idx" ON "Match"("leagueId", "wc3statsGameId");

-- AddForeignKey
ALTER TABLE "League" ADD CONSTRAINT "League_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueChannelBinding" ADD CONSTRAINT "LeagueChannelBinding_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed default game catalog entry
INSERT INTO "Game" ("id", "displayName") VALUES ('warcraft3_udbr', 'Warcraft III — UDBR');
