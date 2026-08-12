-- AlterTable
ALTER TABLE "Match" ADD COLUMN "discordChannelId" TEXT,
ADD COLUMN "discordMessageId" TEXT,
ADD COLUMN "hostDiscordId" TEXT;

-- Backfill existing rows (pre-live-lobby matches have no Discord metadata)
UPDATE "Match"
SET
  "hostDiscordId" = COALESCE("hostDiscordId", 'unknown'),
  "discordChannelId" = COALESCE("discordChannelId", 'unknown')
WHERE "hostDiscordId" IS NULL OR "discordChannelId" IS NULL;

-- Make required columns NOT NULL
ALTER TABLE "Match" ALTER COLUMN "discordChannelId" SET NOT NULL,
ALTER COLUMN "hostDiscordId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Match_discordMessageId_key" ON "Match"("discordMessageId");

-- CreateIndex
CREATE INDEX "Match_status_createdAt_idx" ON "Match"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Match_hostDiscordId_idx" ON "Match"("hostDiscordId");
