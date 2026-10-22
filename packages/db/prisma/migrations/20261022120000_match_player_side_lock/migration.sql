-- Side lock: Balance keeps this player on their current team (any slot on that team).
ALTER TABLE "MatchPlayer" ADD COLUMN "sideLocked" BOOLEAN NOT NULL DEFAULT false;
