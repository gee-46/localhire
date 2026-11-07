-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('BOOKING', 'PAYMENT', 'MESSAGE', 'DISPUTE', 'EARNINGS', 'SYSTEM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_RESCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'WORKER_ON_THE_WAY';
ALTER TYPE "NotificationType" ADD VALUE 'WORKER_ARRIVED';
ALTER TYPE "NotificationType" ADD VALUE 'COMPLETION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_PROCESSED';
ALTER TYPE "NotificationType" ADD VALUE 'DISPUTE_UPDATE';
ALTER TYPE "NotificationType" ADD VALUE 'EARNINGS_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYOUT_UPDATE';

-- DropIndex
DROP INDEX "Conversation_user1Id_user2Id_key";

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "clientMessageId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "bookingId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "category" "NotificationCategory" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_senderId_clientMessageId_key" ON "ChatMessage"("senderId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_bookingId_key" ON "Conversation"("bookingId");

-- CreateIndex
CREATE INDEX "Conversation_user1Id_user2Id_idx" ON "Conversation"("user1Id", "user2Id");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_bookingId_idx" ON "Notification"("bookingId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ─── Data migration ──────────────────────────────────────────────────────────────────────────
-- Existing conversations were keyed by the pair of users. Attach each one to the most recent booking
-- between that pair so it is booking-scoped from now on. A conversation with no booking at all stays
-- unlinked (bookingId NULL): it is not listed and cannot be read or written through the new API.
UPDATE "Conversation" c
SET "bookingId" = b."id"
FROM (
  SELECT DISTINCT ON (LEAST("customerId", "workerId"), GREATEST("customerId", "workerId"))
         "id", LEAST("customerId", "workerId") AS u1, GREATEST("customerId", "workerId") AS u2
  FROM "Booking"
  ORDER BY LEAST("customerId", "workerId"), GREATEST("customerId", "workerId"), "createdAt" DESC
) b
WHERE c."user1Id" = b.u1 AND c."user2Id" = b.u2 AND c."bookingId" IS NULL;

-- Categorise existing notifications from their type (new types are categorised when created).
UPDATE "Notification" SET "category" = CASE "type"::text
  WHEN 'BOOKING_REQUEST' THEN 'BOOKING' WHEN 'BOOKING_CONFIRMED' THEN 'BOOKING' WHEN 'QUOTE_RECEIVED' THEN 'BOOKING'
  WHEN 'QUOTE_ACCEPTED' THEN 'BOOKING' WHEN 'JOB_COMPLETED' THEN 'BOOKING'
  WHEN 'PAYMENT_HELD' THEN 'PAYMENT' WHEN 'PAYMENT_RELEASED' THEN 'EARNINGS'
  WHEN 'NEW_MESSAGE' THEN 'MESSAGE' ELSE 'SYSTEM' END::"NotificationCategory";
UPDATE "Notification" SET "readAt" = "createdAt" WHERE "isRead" = true AND "readAt" IS NULL;
