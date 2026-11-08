-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "arrivedAt" TIMESTAMP(3),
ADD COLUMN     "journeyStartedAt" TIMESTAMP(3),
ADD COLUMN     "trackAccuracy" DOUBLE PRECISION,
ADD COLUMN     "trackLatitude" DOUBLE PRECISION,
ADD COLUMN     "trackLongitude" DOUBLE PRECISION,
ADD COLUMN     "trackUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WorkerLocation" ADD COLUMN     "accuracyMeters" DOUBLE PRECISION;



-- Bookings already on the road when this ships: record when the journey started (best available: last change).
UPDATE "Booking" SET "journeyStartedAt" = "updatedAt" WHERE "status" = 'DISPATCHED' AND "journeyStartedAt" IS NULL;
