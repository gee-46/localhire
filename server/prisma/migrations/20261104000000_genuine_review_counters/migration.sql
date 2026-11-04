-- A worker with no reviews must not carry a rating. The old column default (5.00) and some seeded
-- counters showed placeholder ratings / review counts that no real Review row backed.
-- 1) New profiles start at 0 instead of 5.00.
ALTER TABLE "WorkerProfile" ALTER COLUMN "rating" SET DEFAULT 0;

-- 2) Re-derive every counter from the real Review table. For genuine data this is a no-op (the review
--    controller maintains exactly these values); fabricated counters are corrected. No rows are added or removed.
UPDATE "WorkerProfile" wp
SET "reviewsCount" = (SELECT count(*) FROM "Review" r WHERE r."workerId" = wp."userId"),
    "rating" = COALESCE((SELECT round(avg(r."rating")::numeric, 2) FROM "Review" r WHERE r."workerId" = wp."userId"), 0);
