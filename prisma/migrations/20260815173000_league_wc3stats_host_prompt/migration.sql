-- AlterTable
ALTER TABLE "League" ADD COLUMN "wc3statsHostPromptEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "League" ADD COLUMN "wc3statsHostPromptChannelId" TEXT;
