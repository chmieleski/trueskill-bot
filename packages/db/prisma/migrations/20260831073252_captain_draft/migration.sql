-- CreateTable
CREATE TABLE "CaptainDraft" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "hostDiscordId" TEXT NOT NULL,
    "leagueId" TEXT,
    "status" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "draftMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptainDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptainDraftDisplay" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageIds" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptainDraftDisplay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaptainDraft_guildId_channelId_status_idx" ON "CaptainDraft"("guildId", "channelId", "status");

-- CreateIndex
CREATE INDEX "CaptainDraft_guildId_status_idx" ON "CaptainDraft"("guildId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CaptainDraftDisplay_draftId_key" ON "CaptainDraftDisplay"("draftId");

-- AddForeignKey
ALTER TABLE "CaptainDraftDisplay" ADD CONSTRAINT "CaptainDraftDisplay_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CaptainDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
