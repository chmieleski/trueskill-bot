-- AlterEnum
ALTER TYPE "MatchStatus" ADD VALUE 'WAITING_FOR_MITIGATION_APPROVAL';

-- AlterTable
ALTER TABLE "Match" ADD COLUMN "ratingMitigationPercent" INTEGER;
ALTER TABLE "Match" ADD COLUMN "mitigationApprovalMessageId" TEXT;
