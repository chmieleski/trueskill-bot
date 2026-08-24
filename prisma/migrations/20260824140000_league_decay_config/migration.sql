-- AlterTable League: per-league nullable decay/crunch overrides (null = code defaults)
ALTER TABLE "League" ADD COLUMN "decayMidGraceDays" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayMidTier1Ki" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayMidTier2Ki" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayMidTier1SpanDays" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayMidStreakCapKi" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayCrunchGraceDays" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayCrunchTier1Ki" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayCrunchTier2Ki" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayCrunchTier1SpanDays" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayCrunchWindowDays" INTEGER;
ALTER TABLE "League" ADD COLUMN "decayPrizeLockEnabled" BOOLEAN;
