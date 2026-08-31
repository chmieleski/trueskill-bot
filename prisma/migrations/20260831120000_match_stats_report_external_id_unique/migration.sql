-- Prevent the same WOS bot match report from being attached to multiple bot matches.
CREATE UNIQUE INDEX "MatchStatsReport_externalId_key" ON "MatchStatsReport"("externalId");
