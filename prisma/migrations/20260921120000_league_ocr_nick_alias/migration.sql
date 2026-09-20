-- CreateTable
CREATE TABLE "LeagueOcrNickAlias" (
    "leagueId" TEXT NOT NULL,
    "fromNick" TEXT NOT NULL,
    "toNick" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueOcrNickAlias_pkey" PRIMARY KEY ("leagueId","fromNick")
);

-- CreateIndex
CREATE INDEX "LeagueOcrNickAlias_leagueId_idx" ON "LeagueOcrNickAlias"("leagueId");

-- AddForeignKey
ALTER TABLE "LeagueOcrNickAlias" ADD CONSTRAINT "LeagueOcrNickAlias_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE CASCADE ON UPDATE CASCADE;
