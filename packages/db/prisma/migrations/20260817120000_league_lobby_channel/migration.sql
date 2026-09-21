-- AlterTable
ALTER TABLE "League" ADD COLUMN "lobbyChannelEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "lobbyChannelId" TEXT;
