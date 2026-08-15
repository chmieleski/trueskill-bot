-- AlterTable
ALTER TABLE "GuildConfig" ADD COLUMN     "wc3statsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wc3statsMapPattern" TEXT,
ADD COLUMN     "wc3statsMapSha1" TEXT;
