-- New quits count toward the rollover quitter tax by default.
ALTER TABLE "MatchPlayer" ALTER COLUMN "isQuitterSeasonTax" SET DEFAULT true;

-- Quits finalized before v1.68.0 reached production (deploy finished 2026-10-06 08:16:21 UTC)
-- already took the old 3-loss penalty, so they stay out of the rollover tax. Everything else is taxable.
-- completedAt is only written at completion; cancelled matches have none and use createdAt, which is
-- earlier than the cancel — so a borderline match can only skip the tax, never be penalized twice.
UPDATE "MatchPlayer" AS mp
SET "isQuitterSeasonTax" = NOT (
  mp."isQuitter"
  AND m."status" IN ('COMPLETED', 'CANCELLED')
  AND COALESCE(m."completedAt", m."createdAt") < TIMESTAMP '2026-10-06 08:16:21'
)
FROM "Match" AS m
WHERE m."id" = mp."matchId";
