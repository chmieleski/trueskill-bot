-- CreateTable
CREATE TABLE "GameItem" (
    "gameId" TEXT NOT NULL,
    "objectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameItem_pkey" PRIMARY KEY ("gameId","objectId")
);

-- CreateIndex
CREATE INDEX "GameItem_gameId_idx" ON "GameItem"("gameId");

-- AddForeignKey
ALTER TABLE "GameItem" ADD CONSTRAINT "GameItem_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
