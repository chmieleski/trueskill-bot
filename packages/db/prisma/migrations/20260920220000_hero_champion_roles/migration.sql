-- AlterTable
ALTER TABLE "League" ADD COLUMN "heroChampionRolesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LeagueHeroChampionRole" (
    "leagueId" TEXT NOT NULL,
    "heroId" INTEGER NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "holderDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueHeroChampionRole_pkey" PRIMARY KEY ("leagueId","heroId")
);

-- CreateIndex
CREATE INDEX "LeagueHeroChampionRole_leagueId_idx" ON "LeagueHeroChampionRole"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueHeroChampionRole_leagueId_discordRoleId_key" ON "LeagueHeroChampionRole"("leagueId", "discordRoleId");

-- AddForeignKey
ALTER TABLE "LeagueHeroChampionRole" ADD CONSTRAINT "LeagueHeroChampionRole_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueHeroChampionRole" ADD CONSTRAINT "LeagueHeroChampionRole_heroId_fkey" FOREIGN KEY ("heroId") REFERENCES "Hero"("id") ON DELETE CASCADE ON UPDATE CASCADE;
