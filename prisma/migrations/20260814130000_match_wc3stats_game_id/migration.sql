-- AlterTable
ALTER TABLE "Match" ADD COLUMN "wc3statsGameId" TEXT;

-- CreateIndex
CREATE INDEX "Match_wc3statsGameId_idx" ON "Match"("wc3statsGameId");
