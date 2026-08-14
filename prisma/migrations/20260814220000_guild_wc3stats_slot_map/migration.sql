-- CreateTable
CREATE TABLE "GuildWc3statsSlotMap" (
    "guildId" TEXT NOT NULL,
    "wc3statsSlot" INTEGER NOT NULL,
    "heroId" INTEGER NOT NULL,

    CONSTRAINT "GuildWc3statsSlotMap_pkey" PRIMARY KEY ("guildId","wc3statsSlot")
);

-- CreateIndex
CREATE INDEX "GuildWc3statsSlotMap_guildId_idx" ON "GuildWc3statsSlotMap"("guildId");

-- CreateIndex
CREATE INDEX "GuildWc3statsSlotMap_guildId_heroId_idx" ON "GuildWc3statsSlotMap"("guildId", "heroId");

-- AddForeignKey
ALTER TABLE "GuildWc3statsSlotMap" ADD CONSTRAINT "GuildWc3statsSlotMap_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "GuildConfig"("guildId") ON DELETE CASCADE ON UPDATE CASCADE;
