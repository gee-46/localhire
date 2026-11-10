-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ReviewReportReason" AS ENUM ('ABUSIVE', 'FAKE_OR_FRAUDULENT', 'NOT_MY_CUSTOMER', 'PRIVATE_INFORMATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReviewReportStatus" AS ENUM ('OPEN', 'DISMISSED', 'UPHELD');

-- CreateEnum
CREATE TYPE "ReviewModerationAction" AS ENUM ('HIDDEN', 'RESTORED', 'REPORT_DISMISSED', 'REPORT_UPHELD');

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "hiddenById" TEXT,
ADD COLUMN     "hiddenReason" TEXT,
ADD COLUMN     "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED';

-- CreateTable
CREATE TABLE "ReviewReport" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ReviewReportReason" NOT NULL,
    "details" TEXT,
    "status" "ReviewReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewModerationEvent" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "action" "ReviewModerationAction" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewModerationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewReport_status_createdAt_idx" ON "ReviewReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewReport_reviewId_idx" ON "ReviewReport"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReport_reviewId_reporterId_key" ON "ReviewReport"("reviewId", "reporterId");

-- CreateIndex
CREATE INDEX "ReviewModerationEvent_reviewId_createdAt_idx" ON "ReviewModerationEvent"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_workerId_status_idx" ON "Review"("workerId", "status");

-- CreateIndex
CREATE INDEX "Review_status_createdAt_idx" ON "Review"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewModerationEvent" ADD CONSTRAINT "ReviewModerationEvent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewModerationEvent" ADD CONSTRAINT "ReviewModerationEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Integrity rules enforced by the database itself (the API checks the same things first) ─────────────────
-- Ratings are 1..5 and comments are bounded. NOT VALID: rows written before this migration are not re-checked,
-- every new or updated row is.
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range_chk" CHECK ("rating" BETWEEN 1 AND 5) NOT VALID;
ALTER TABLE "Review" ADD CONSTRAINT "Review_comment_length_chk" CHECK (char_length("comment") <= 1000) NOT VALID;
-- A hidden review always records when and why.
ALTER TABLE "Review" ADD CONSTRAINT "Review_hidden_has_reason_chk" CHECK ("status" <> 'HIDDEN' OR ("hiddenAt" IS NOT NULL AND "hiddenReason" IS NOT NULL AND char_length(btrim("hiddenReason")) >= 5));
ALTER TABLE "ReviewModerationEvent" ADD CONSTRAINT "ReviewModerationEvent_reason_chk" CHECK (char_length(btrim("reason")) >= 5);
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_details_length_chk" CHECK ("details" IS NULL OR char_length("details") <= 1000);

-- One review per booking is already guaranteed by the unique index on "bookingId". On top of that, a review can only
-- be inserted for a COMPLETED booking, by that booking's customer, about that booking's professional.
CREATE OR REPLACE FUNCTION "review_requires_completed_booking"() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  SELECT "status", "customerId", "workerId" INTO b FROM "Booking" WHERE "id" = NEW."bookingId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'review_booking_missing: the booking does not exist' USING ERRCODE = '23503';
  END IF;
  IF b."status" <> 'COMPLETED' THEN
    RAISE EXCEPTION 'review_booking_not_completed: only a completed booking can be reviewed' USING ERRCODE = '23514';
  END IF;
  IF b."customerId" <> NEW."customerId" OR b."workerId" <> NEW."workerId" THEN
    RAISE EXCEPTION 'review_booking_mismatch: the review must be written by the booking customer about the booking professional' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Review_requires_completed_booking" BEFORE INSERT ON "Review"
  FOR EACH ROW EXECUTE FUNCTION "review_requires_completed_booking"();

-- The booking, customer, professional and rating of a review can never be rewritten afterwards.
CREATE OR REPLACE FUNCTION "review_identity_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."bookingId" <> OLD."bookingId" OR NEW."customerId" <> OLD."customerId" OR NEW."workerId" <> OLD."workerId"
     OR NEW."rating" <> OLD."rating" OR NEW."comment" <> OLD."comment" THEN
    RAISE EXCEPTION 'review_immutable: a submitted review cannot be edited; it can only be hidden or restored by a moderator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Review_identity_immutable" BEFORE UPDATE ON "Review"
  FOR EACH ROW EXECUTE FUNCTION "review_identity_immutable"();

-- Public rating counters count PUBLISHED reviews only. Re-derive them from the Review table (a no-op while every review is published).
UPDATE "WorkerProfile" wp
SET "reviewsCount" = (SELECT count(*) FROM "Review" r WHERE r."workerId" = wp."userId" AND r."status" = 'PUBLISHED'),
    "rating" = COALESCE((SELECT round(avg(r."rating")::numeric, 2) FROM "Review" r WHERE r."workerId" = wp."userId" AND r."status" = 'PUBLISHED'), 0);
