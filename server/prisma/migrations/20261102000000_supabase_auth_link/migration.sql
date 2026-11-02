-- Link the existing "User" table to Supabase Auth (no new user table) and add session invalidation.
-- All statements are additive / relaxing and idempotent; no rows are deleted.

-- Supabase Auth identity link (auth.users.id)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "supabaseAuthId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_supabaseAuthId_key" ON "User"("supabaseAuthId");

-- Server-side logout / password-reset invalidation of issued JWTs
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Accounts that authenticate only through Supabase (Google, or migrated passwords) have no local hash
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- NOTE: this migration deliberately does NOT modify any existing row. Existing non-admin accounts
-- were flagged isEmailVerified=true by the old registration without any email check; resetting that
-- flag locks users out until they re-verify, so it is a separate, explicit, dry-run-first step:
--   node scripts/reset-legacy-email-verification.js            (preview)
--   node scripts/reset-legacy-email-verification.js --apply    (perform)
