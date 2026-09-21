-- CreateEnum
CREATE TYPE "GrieferLeaderboardDisplay" AS ENUM ('count', 'rate', 'both');

-- CreateEnum
CREATE TYPE "GrieferLeaderboardSort" AS ENUM ('count', 'rate');

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN "grieferLeaderboardChannelId" TEXT,
ADD COLUMN "grieferLeaderboardMessageId" TEXT,
ADD COLUMN "grieferLeaderboardSize" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "grieferLeaderboardDisplay" "GrieferLeaderboardDisplay" NOT NULL DEFAULT 'both',
ADD COLUMN "grieferLeaderboardSort" "GrieferLeaderboardSort" NOT NULL DEFAULT 'count';
