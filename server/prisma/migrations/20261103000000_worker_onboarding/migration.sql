-- CreateEnum
CREATE TYPE "WorkerVerificationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'RESUBMISSION_REQUIRED');

-- CreateEnum
CREATE TYPE "WorkerDocumentType" AS ENUM ('GOVT_ID_PASSPORT', 'GOVT_ID_DRIVING_LICENCE', 'GOVT_ID_VOTER_ID', 'GOVT_ID_PAN', 'GOVT_ID_AADHAAR_MASKED', 'GOVT_ID_OTHER', 'PROFESSIONAL_CERTIFICATE', 'SKILL_QUALIFICATION');

-- AlterTable
ALTER TABLE "WorkerProfile" ADD COLUMN     "city" TEXT,
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "locality" TEXT,
ADD COLUMN     "previousExperience" TEXT;

-- CreateTable
CREATE TABLE "WorkerProfileCategory" (
    "workerProfileId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerProfileCategory_pkey" PRIMARY KEY ("workerProfileId","categoryId")
);

-- CreateTable
CREATE TABLE "WorkerOnboarding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "status" "WorkerVerificationStatus",
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "decisionReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerOnboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "type" "WorkerDocumentType" NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "status" "WorkerVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerVerificationEvent" (
    "id" TEXT NOT NULL,
    "onboardingId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" "WorkerVerificationStatus",
    "toStatus" "WorkerVerificationStatus",
    "reason" TEXT,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerVerificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerProfileCategory_categoryId_idx" ON "WorkerProfileCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerOnboarding_userId_key" ON "WorkerOnboarding"("userId");

-- CreateIndex
CREATE INDEX "WorkerOnboarding_status_idx" ON "WorkerOnboarding"("status");

-- CreateIndex
CREATE INDEX "WorkerOnboarding_submittedAt_idx" ON "WorkerOnboarding"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDocument_storagePath_key" ON "WorkerDocument"("storagePath");

-- CreateIndex
CREATE INDEX "WorkerDocument_userId_isCurrent_idx" ON "WorkerDocument"("userId", "isCurrent");

-- CreateIndex
CREATE INDEX "WorkerDocument_onboardingId_idx" ON "WorkerDocument"("onboardingId");

-- CreateIndex
CREATE INDEX "WorkerDocument_status_idx" ON "WorkerDocument"("status");

-- CreateIndex
CREATE INDEX "WorkerVerificationEvent_onboardingId_createdAt_idx" ON "WorkerVerificationEvent"("onboardingId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkerProfileCategory" ADD CONSTRAINT "WorkerProfileCategory_workerProfileId_fkey" FOREIGN KEY ("workerProfileId") REFERENCES "WorkerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerProfileCategory" ADD CONSTRAINT "WorkerProfileCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerOnboarding" ADD CONSTRAINT "WorkerOnboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDocument" ADD CONSTRAINT "WorkerDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDocument" ADD CONSTRAINT "WorkerDocument_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "WorkerOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerVerificationEvent" ADD CONSTRAINT "WorkerVerificationEvent_onboardingId_fkey" FOREIGN KEY ("onboardingId") REFERENCES "WorkerOnboarding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Database-driven service categories (single source for every dropdown/filter).
-- Idempotent and non-destructive: existing categories keep their ids and relations.
-- ---------------------------------------------------------------------------

-- The requested taxonomy calls it "AC Repair"; rename the seeded "AC Technician" in place so its
-- service items and any workers stay attached (skipped if an "AC Repair" already exists).
UPDATE "ServiceCategory"
SET "name" = 'AC Repair', "slug" = 'ac-repair', "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'ac-technician'
  AND NOT EXISTS (SELECT 1 FROM "ServiceCategory" WHERE "slug" = 'ac-repair' OR "name" = 'AC Repair');

INSERT INTO "ServiceCategory" ("id", "name", "slug", "description", "displayOrder", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v.name, v.slug, v.description, v.ord, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('Painter',            'painter',            'Interior and exterior painting, waterproof coating and touch-ups.', 1),
  ('Carpenter',          'carpenter',          'Furniture repair, doors, locks, cabinetry and wood work.', 2),
  ('Plumber',            'plumber',            'Leak repair, pipe fitting, drain clearing and water heaters.', 3),
  ('Electrician',        'electrician',        'Wiring, lighting, panel upgrades and appliance hookups.', 4),
  ('Tutor',              'tutor',              'Home and online tuition across subjects and levels.', 5),
  ('Cleaner',            'cleaner',            'Home and office cleaning, deep cleaning and sanitisation.', 6),
  ('AC Repair',          'ac-repair',          'Air conditioner servicing, gas refill and repair.', 7),
  ('Appliance Repair',   'appliance-repair',   'Washing machine, refrigerator, microwave and kitchen appliance repair.', 8),
  ('Mechanic',           'mechanic',           'Two-wheeler and car repair and servicing.', 9),
  ('Pest Control',       'pest-control',       'Termite, rodent and insect control.', 10),
  ('Gardener',           'gardener',           'Garden maintenance, landscaping and plant care.', 11),
  ('Mason',              'mason',              'Brickwork, plastering, tiling and masonry repairs.', 12),
  ('Tailor',             'tailor',             'Stitching, alterations and garment repair.', 13),
  ('Movers and Packers', 'movers-and-packers', 'Packing, loading and relocation services.', 14),
  ('Beauty Services',    'beauty-services',    'Salon, grooming and beauty services at home.', 15)
) AS v(name, slug, description, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM "ServiceCategory" c WHERE c."slug" = v.slug OR lower(c."name") = lower(v.name)
);
