-- AlterTable League
ALTER TABLE "League" ADD COLUMN "decayEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "League" ADD COLUMN "seasonEndsAt" TIMESTAMP(3);
ALTER TABLE "League" ADD COLUMN "crunchStartedAt" TIMESTAMP(3);

-- AlterTable PlayerRating
ALTER TABLE "PlayerRating" ADD COLUMN "lastQualifyingActivityAt" TIMESTAMP(3);
ALTER TABLE "PlayerRating" ADD COLUMN "idleDecayKiApplied" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlayerRating" ADD COLUMN "lastDecayAppliedAt" TIMESTAMP(3);

-- Backfill lastQualifyingActivityAt from completed non-quit matches
UPDATE "PlayerRating" AS pr
SET "lastQualifyingActivityAt" = src."maxCompletedAt"
FROM (
  SELECT mp."playerId", m."leagueId", MAX(m."completedAt") AS "maxCompletedAt"
  FROM "MatchPlayer" mp
  JOIN "Match" m ON m.id = mp."matchId"
  WHERE m.status = 'COMPLETED'
    AND mp."isQuitter" = false
    AND m."completedAt" IS NOT NULL
  GROUP BY mp."playerId", m."leagueId"
) AS src
WHERE pr."playerId" = src."playerId"
  AND pr."leagueId" = src."leagueId";
