-- AlterTable
ALTER TABLE "League" ADD COLUMN "lobbyCaptainDraftEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LobbyDraft" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "parentChannelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "hostDiscordId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "liveMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LobbyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LobbyDraft_matchId_status_idx" ON "LobbyDraft"("matchId", "status");
CREATE INDEX "LobbyDraft_guildId_status_idx" ON "LobbyDraft"("guildId", "status");
CREATE INDEX "LobbyDraft_threadId_idx" ON "LobbyDraft"("threadId");
