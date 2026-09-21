-- CreateTable
CREATE TABLE "GameHero" (
    "gameId" TEXT NOT NULL,
    "objectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameHero_pkey" PRIMARY KEY ("gameId","objectId")
);

-- CreateIndex
CREATE INDEX "GameHero_gameId_idx" ON "GameHero"("gameId");

-- AddForeignKey
ALTER TABLE "GameHero" ADD CONSTRAINT "GameHero_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
