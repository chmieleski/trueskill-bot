-- AlterEnum
ALTER TYPE "MatchStatus" ADD VALUE 'WAITING_FOR_APPROVAL';

-- AlterTable
ALTER TABLE "League" ADD COLUMN     "apiTokenCreatedAt" TIMESTAMP(3),
ADD COLUMN     "apiTokenHash" TEXT,
ADD COLUMN     "matchApprovalChannelId" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "approvalWinnerTeam" INTEGER;
