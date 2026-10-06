-- AlterTable
ALTER TABLE "League" ADD COLUMN "rankRolesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "rankRolesDirty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "lastRankRoleSyncAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "League_rankRolesEnabled_rankRolesDirty_idx" ON "League"("rankRolesEnabled", "rankRolesDirty");

-- CreateTable
CREATE TABLE "LeagueRankRole" (
    "leagueId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "holderDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueRankRole_pkey" PRIMARY KEY ("leagueId","rank")
);

-- CreateIndex
CREATE INDEX "LeagueRankRole_leagueId_idx" ON "LeagueRankRole"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueRankRole_leagueId_discordRoleId_key" ON "LeagueRankRole"("leagueId", "discordRoleId");

-- AddForeignKey
ALTER TABLE "LeagueRankRole" ADD CONSTRAINT "LeagueRankRole_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
