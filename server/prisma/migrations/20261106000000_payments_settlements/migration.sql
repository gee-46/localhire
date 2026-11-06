-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING_COMPLETION', 'ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentTxType" AS ENUM ('ORDER_CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUND_INITIATED', 'REFUND_PROCESSED', 'REFUND_FAILED', 'DUPLICATE_PAYMENT_REFUNDED', 'COMPLETION_CONFIRMED', 'TRANSFER_CREATED', 'TRANSFER_PROCESSED', 'TRANSFER_FAILED', 'TRANSFER_REVERSED', 'TRANSFER_RELEASED', 'DISPUTE_OPENED', 'MIGRATED_FROM_LEGACY');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutAccountStatus" AS ENUM ('NOT_STARTED', 'CREATED', 'NEEDS_CLARIFICATION', 'UNDER_REVIEW', 'ACTIVATED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "priceConfirmedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "paymentNumber" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "serviceAmount" DECIMAL(10,2) NOT NULL,
    "platformFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "state" "PaymentState" NOT NULL DEFAULT 'CREATED',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "gatewayProvider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "gatewayOrderId" TEXT,
    "gatewayPaymentId" TEXT,
    "method" TEXT,
    "methodDetail" TEXT,
    "amountRefunded" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "authorizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureReason" TEXT,
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "disputeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" "PaymentTxType" NOT NULL,
    "amount" DECIMAL(10,2),
    "gatewayRef" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "receipt" TEXT NOT NULL,
    "gatewayRefundId" TEXT,
    "gatewayPaymentId" TEXT,
    "initiatedById" TEXT,
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerSettlement" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "serviceAmount" DECIMAL(10,2) NOT NULL,
    "commissionRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "refundAdjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING_COMPLETION',
    "payoutRail" TEXT,
    "gatewayTransferId" TEXT,
    "transferStatus" TEXT,
    "settlementStatus" TEXT,
    "failureReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "eligibleAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerPayoutAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gatewayAccountId" TEXT,
    "gatewayProductId" TEXT,
    "status" "PayoutAccountStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "requirements" JSONB,
    "legalName" TEXT,
    "bankLast4" TEXT,
    "bankVerification" TEXT,
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerPayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentNumber_key" ON "Payment"("paymentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_bookingId_key" ON "Payment"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayOrderId_key" ON "Payment"("gatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_gatewayPaymentId_key" ON "Payment"("gatewayPaymentId");

-- CreateIndex
CREATE INDEX "Payment_customerId_createdAt_idx" ON "Payment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_workerId_idx" ON "Payment"("workerId");

-- CreateIndex
CREATE INDEX "Payment_state_idx" ON "Payment"("state");

-- CreateIndex
CREATE INDEX "PaymentTransaction_paymentId_createdAt_idx" ON "PaymentTransaction"("paymentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_paymentId_type_gatewayRef_key" ON "PaymentTransaction"("paymentId", "type", "gatewayRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_receipt_key" ON "PaymentRefund"("receipt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_gatewayRefundId_key" ON "PaymentRefund"("gatewayRefundId");

-- CreateIndex
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentRefund_status_idx" ON "PaymentRefund"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerSettlement_paymentId_key" ON "WorkerSettlement"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerSettlement_gatewayTransferId_key" ON "WorkerSettlement"("gatewayTransferId");

-- CreateIndex
CREATE INDEX "WorkerSettlement_workerId_status_idx" ON "WorkerSettlement"("workerId", "status");

-- CreateIndex
CREATE INDEX "WorkerSettlement_bookingId_idx" ON "WorkerSettlement"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerPayoutAccount_userId_key" ON "WorkerPayoutAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerPayoutAccount_gatewayAccountId_key" ON "WorkerPayoutAccount"("gatewayAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_event_idx" ON "WebhookEvent"("event");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerSettlement" ADD CONSTRAINT "WorkerSettlement_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerSettlement" ADD CONSTRAINT "WorkerSettlement_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerPayoutAccount" ADD CONSTRAINT "WorkerPayoutAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Data: bookings that were already accepted count as price-confirmed, so nothing in flight is stranded.
-- ---------------------------------------------------------------------------
UPDATE "Booking"
SET "priceConfirmedAt" = "updatedAt"
WHERE "priceConfirmedAt" IS NULL
  AND "status" IN ('CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION', 'COMPLETED');

-- ---------------------------------------------------------------------------
-- Data: carry REAL Razorpay payments from the old escrow table into the new payment domain.
-- Rows created by the removed "simulated gateway" are NOT migrated: no money ever moved, so they must never
-- appear as captured payments or as worker balances. They remain in "EscrowPayment" as an archive.
-- Legacy "released" payments become settlements that are owed (ELIGIBLE): the old code never made a real transfer.
-- ---------------------------------------------------------------------------
INSERT INTO "Payment" ("id", "paymentNumber", "bookingId", "customerId", "workerId", "serviceAmount", "platformFee", "taxAmount", "totalAmount",
                       "currency", "state", "gatewayProvider", "gatewayOrderId", "gatewayPaymentId", "amountRefunded", "capturedAt",
                       "disputed", "disputeReason", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, e."invoiceNumber", e."bookingId", e."customerId", e."workerId", e."subtotalAmount", e."platformFee", e."taxAmount", e."totalAmount",
       e."currency",
       (CASE e."status" WHEN 'PENDING' THEN 'CREATED' WHEN 'FAILED' THEN 'FAILED' WHEN 'REFUNDED_TO_CUSTOMER' THEN 'REFUNDED' ELSE 'CAPTURED' END)::"PaymentState",
       'RAZORPAY', e."gatewayOrderId", e."gatewayPaymentId",
       CASE WHEN e."status" = 'REFUNDED_TO_CUSTOMER' THEN e."totalAmount" ELSE 0 END,
       CASE WHEN e."status" IN ('HELD_IN_ESCROW', 'RELEASED_TO_WORKER', 'DISPUTED', 'REFUNDED_TO_CUSTOMER') THEN COALESCE(e."heldAt", e."createdAt") END,
       (e."status" = 'DISPUTED'), CASE WHEN e."status" = 'DISPUTED' THEN e."refundReason" END,
       e."createdAt", CURRENT_TIMESTAMP
FROM "EscrowPayment" e
WHERE e."gatewayProvider" = 'RAZORPAY'
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."bookingId" = e."bookingId");

INSERT INTO "WorkerSettlement" ("id", "paymentId", "bookingId", "workerId", "serviceAmount", "commissionRate", "commission", "netAmount", "status", "eligibleAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."id", p."bookingId", p."workerId", e."subtotalAmount",
       CASE WHEN e."subtotalAmount" > 0 THEN ROUND(GREATEST(e."subtotalAmount" - e."workerPayoutAmount", 0) / e."subtotalAmount" * 100, 2) ELSE 0 END,
       GREATEST(e."subtotalAmount" - e."workerPayoutAmount", 0), e."workerPayoutAmount",
       (CASE e."status" WHEN 'RELEASED_TO_WORKER' THEN 'ELIGIBLE' WHEN 'DISPUTED' THEN 'BLOCKED' WHEN 'REFUNDED_TO_CUSTOMER' THEN 'CANCELLED' ELSE 'PENDING_COMPLETION' END)::"SettlementStatus",
       CASE WHEN e."status" = 'RELEASED_TO_WORKER' THEN COALESCE(e."releasedAt", e."updatedAt") END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "EscrowPayment" e
JOIN "Payment" p ON p."bookingId" = e."bookingId"
WHERE e."gatewayProvider" = 'RAZORPAY'
  AND e."status" IN ('HELD_IN_ESCROW', 'RELEASED_TO_WORKER', 'DISPUTED', 'REFUNDED_TO_CUSTOMER')
  AND NOT EXISTS (SELECT 1 FROM "WorkerSettlement" s WHERE s."paymentId" = p."id");

INSERT INTO "PaymentTransaction" ("id", "paymentId", "type", "amount", "gatewayRef", "note")
SELECT gen_random_uuid()::text, p."id", 'MIGRATED_FROM_LEGACY'::"PaymentTxType", p."totalAmount", COALESCE(p."gatewayPaymentId", ''),
       'Carried over from the legacy escrow table; the legacy record did not prove a payout or refund'
FROM "Payment" p
WHERE NOT EXISTS (SELECT 1 FROM "PaymentTransaction" t WHERE t."paymentId" = p."id" AND t."type" = 'MIGRATED_FROM_LEGACY');
