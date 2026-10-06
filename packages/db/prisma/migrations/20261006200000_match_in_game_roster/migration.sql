-- Last in-game roster read (screenshot OCR or wc3stats) for lobby swap commands.
ALTER TABLE "Match" ADD COLUMN "inGameRoster" JSONB;
ALTER TABLE "Match" ADD COLUMN "inGameRosterAt" TIMESTAMP(3);
ALTER TABLE "Match" ADD COLUMN "inGameRosterSource" TEXT;
