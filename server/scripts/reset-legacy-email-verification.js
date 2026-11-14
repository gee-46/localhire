// LocalHire - one-off: clear the false "email verified" flag on pre-Supabase-Auth accounts.
//
// Before email verification existed, registration set isEmailVerified=true for everyone. Those
// accounts were never verified, but resetting them locks the user out until they verify through
// "Resend verification email" on the login page. Run this deliberately, not as part of a deploy.
//
//   node scripts/reset-legacy-email-verification.js                 preview only (default, changes nothing)
//   node scripts/reset-legacy-email-verification.js --apply         reset every affected account
//   node scripts/reset-legacy-email-verification.js --apply --skip-active
//                                                                   leave accounts with an in-flight
//                                                                   booking / escrow untouched for now
//
// Never touched: ADMIN accounts and accounts already linked to Supabase Auth (supabaseAuthId set).
// No account or related record is deleted. Rollback (for a batch you just applied):
//   UPDATE "User" SET "isEmailVerified" = true WHERE id IN (<ids printed by --apply>);

const path = require('path');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const apply = process.argv.includes('--apply');
const skipActive = process.argv.includes('--skip-active');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (server/.env).');
    process.exit(1);
  }
  const prisma = new PrismaClient({ log: ['error'] });
  try {
    const candidates = await prisma.user.findMany({
      where: { role: { not: 'ADMIN' }, supabaseAuthId: null, isEmailVerified: true },
      select: { id: true, email: true, role: true }
    });

    const ids = candidates.map((u) => u.id);
    const [bookings, escrows] = ids.length
      ? await Promise.all([
          prisma.booking.findMany({
            where: {
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              OR: [{ customerId: { in: ids } }, { workerId: { in: ids } }]
            },
            select: { customerId: true, workerId: true }
          }),
          prisma.payment.findMany({
            where: {
              state: { in: ['AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED'] },
              settlement: { is: { status: { in: ['PENDING_COMPLETION', 'BLOCKED', 'ELIGIBLE', 'PAYOUT_PROCESSING'] } } },
              OR: [{ customerId: { in: ids } }, { workerId: { in: ids } }]
            },
            select: { customerId: true, workerId: true }
          })
        ])
      : [[], []];

    const active = new Set();
    [...bookings, ...escrows].forEach((r) => { active.add(r.customerId); active.add(r.workerId); });

    const activeCandidates = candidates.filter((u) => active.has(u.id));
    const targets = skipActive ? candidates.filter((u) => !active.has(u.id)) : candidates;

    console.log(`Accounts flagged verified without verification (non-admin, not linked): ${candidates.length}`);
    console.log(`  of which have an in-flight booking or open escrow:                    ${activeCandidates.length}`);
    activeCandidates.forEach((u) => console.log(`    - ${u.email} (${u.role})`));
    console.log(`Accounts this run would reset${skipActive ? ' (--skip-active)' : ''}:                          ${targets.length}`);

    if (!apply) {
      console.log('\nPREVIEW ONLY - nothing was changed. Re-run with --apply to perform the reset.');
      return;
    }
    if (!targets.length) {
      console.log('\nNothing to reset.');
      return;
    }
    const result = await prisma.user.updateMany({
      where: { id: { in: targets.map((u) => u.id) } },
      data: { isEmailVerified: false }
    });
    console.log(`\nReset isEmailVerified on ${result.count} account(s). IDs (keep for rollback):`);
    console.log(targets.map((u) => u.id).join(','));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
