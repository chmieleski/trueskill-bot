-- AlterTable
ALTER TABLE "League" ADD COLUMN "heroChampionRolesDirty" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastHeroChampionSyncAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "League_heroChampionRolesEnabled_heroChampionRolesDirty_idx" ON "League"("heroChampionRolesEnabled", "heroChampionRolesDirty");
