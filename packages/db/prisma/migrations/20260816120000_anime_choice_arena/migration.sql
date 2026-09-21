-- AlterTable
ALTER TABLE "MatchPlayer" ALTER COLUMN "heroId" DROP NOT NULL;

-- Seed Anime Choice Arena game catalog
INSERT INTO "Game" ("id", "displayName")
VALUES ('warcraft3_anime_choice_arena', 'Anime Choice Arena')
ON CONFLICT ("id") DO NOTHING;
