-- AlterTable
ALTER TABLE "PlayerRating" ADD COLUMN "isNewPlayer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MatchPlayer" ADD COLUMN "wasNewPlayer" BOOLEAN NOT NULL DEFAULT false;
