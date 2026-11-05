-- Customer-written description of the problem, stored with the booking request (additive, nullable).
ALTER TABLE "Booking" ADD COLUMN "problemDescription" TEXT;

-- Worker portfolio photographs (public images of past work).
CREATE TABLE "WorkerPortfolioItem" (
    "id" TEXT NOT NULL,
    "workerProfileId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerPortfolioItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerPortfolioItem_storagePath_key" ON "WorkerPortfolioItem"("storagePath");
CREATE INDEX "WorkerPortfolioItem_workerProfileId_sortOrder_idx" ON "WorkerPortfolioItem"("workerProfileId", "sortOrder");

ALTER TABLE "WorkerPortfolioItem" ADD CONSTRAINT "WorkerPortfolioItem_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "WorkerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
