-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN "changelogChannelId" TEXT;
ALTER TABLE "GuildConfig" ADD COLUMN "changelogDraftChannelId" TEXT;

-- CreateEnum
CREATE TYPE "BotReleaseStatus" AS ENUM ('draft', 'published', 'skipped');

-- CreateTable
CREATE TABLE "BotRelease" (
    "version" TEXT NOT NULL,
    "engineeringNotes" TEXT NOT NULL,
    "playerNotes" TEXT NOT NULL,
    "status" "BotReleaseStatus" NOT NULL DEFAULT 'draft',
    "draftGuildId" TEXT,
    "draftChannelId" TEXT,
    "draftMessageId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotRelease_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "BotReleasePost" (
    "version" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,

    CONSTRAINT "BotReleasePost_pkey" PRIMARY KEY ("version","guildId")
);

-- AddForeignKey
ALTER TABLE "BotReleasePost" ADD CONSTRAINT "BotReleasePost_version_fkey" FOREIGN KEY ("version") REFERENCES "BotRelease"("version") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "BotReleasePost_guildId_idx" ON "BotReleasePost"("guildId");
