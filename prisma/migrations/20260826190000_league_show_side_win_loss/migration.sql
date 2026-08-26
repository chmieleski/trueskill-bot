-- AlterTable
ALTER TABLE "League" ADD COLUMN "showSideWinLoss" BOOLEAN NOT NULL DEFAULT false;

-- UDBR leagues show side W/L on /rank by default; ACA and others stay off.
UPDATE "League" SET "showSideWinLoss" = true WHERE "gameId" = 'warcraft3_udbr';
