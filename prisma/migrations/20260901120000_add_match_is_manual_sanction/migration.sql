-- AlterTable
ALTER TABLE "Match" ADD COLUMN "isManualSanction" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Match_leagueId_isManualSanction_createdAt_idx" ON "Match"("leagueId", "isManualSanction", "createdAt");
