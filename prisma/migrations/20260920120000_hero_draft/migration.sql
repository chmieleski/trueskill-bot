-- CreateTable
CREATE TABLE "HeroDraft" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "parentChannelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "hostDiscordId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "timerSeconds" INTEGER NOT NULL DEFAULT 30,
    "state" JSONB NOT NULL,
    "liveMessageId" TEXT,
    "sourceCaptainDraftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HeroDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HeroDraft_guildId_status_idx" ON "HeroDraft"("guildId", "status");

-- CreateIndex
CREATE INDEX "HeroDraft_threadId_idx" ON "HeroDraft"("threadId");

-- CreateIndex
CREATE INDEX "HeroDraft_guildId_parentChannelId_status_idx" ON "HeroDraft"("guildId", "parentChannelId", "status");
