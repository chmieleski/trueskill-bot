-- CreateEnum
CREATE TYPE "QuitterLeaderboardDisplay" AS ENUM ('count', 'rate', 'both');

-- CreateEnum
CREATE TYPE "QuitterLeaderboardSort" AS ENUM ('count', 'rate');

-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN "quitterLeaderboardChannelId" TEXT,
ADD COLUMN "quitterLeaderboardMessageId" TEXT,
ADD COLUMN "quitterLeaderboardSize" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN "quitterLeaderboardDisplay" "QuitterLeaderboardDisplay" NOT NULL DEFAULT 'both',
ADD COLUMN "quitterLeaderboardSort" "QuitterLeaderboardSort" NOT NULL DEFAULT 'count';
