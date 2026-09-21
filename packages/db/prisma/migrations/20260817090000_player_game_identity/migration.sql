-- AlterTable
ALTER TABLE "Player" ADD COLUMN "gameId" TEXT;

-- Backfill legacy rows to UDBR (must exist in "Game")
UPDATE "Player" SET "gameId" = 'warcraft3_udbr' WHERE "gameId" IS NULL;

-- AlterTable
ALTER TABLE "Player" ALTER COLUMN "gameId" SET NOT NULL;

-- DropIndex (names may differ — use prisma migrate diff or \d if needed)
DROP INDEX IF EXISTS "Player_username_key";
DROP INDEX IF EXISTS "Player_discordId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Player_gameId_username_key" ON "Player"("gameId", "username");
CREATE UNIQUE INDEX "Player_gameId_discordId_key" ON "Player"("gameId", "discordId");
CREATE INDEX "Player_gameId_idx" ON "Player"("gameId");

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
