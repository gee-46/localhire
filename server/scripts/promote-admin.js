// Promote an EXISTING account to Administrator. This is the production-safe way to create the first admin: the demo seed
// (prisma:seed) refuses to run in production because it creates fictional accounts with a published password.
//
//   1. The person signs up normally and verifies their e-mail (so Supabase Auth owns their password).
//   2. npm --prefix server run admin:promote -- person@example.com            (dry run: shows what would change)
//   3. npm --prefix server run admin:promote -- person@example.com --apply    (does it)
//
// It never creates users, never sets or prints passwords, refuses unverified or deactivated accounts, signs the person out
// everywhere (so the new role takes effect on their next sign-in) and writes an audit-log entry.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const prisma = require('../config/prisma');

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const email = String(args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    console.error('Usage: node scripts/promote-admin.js <email> [--apply]');
    process.exitCode = 2; return;
  }
  let host = 'unknown';
  try { host = new URL(String(process.env.DATABASE_URL || '').replace(/^postgres(ql)?:/, 'http:')).host; } catch (e) { /* keep unknown */ }
  console.log(`Database host: ${host}   Mode: ${apply ? 'APPLY' : 'dry run (no changes)'}`);

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, role: true, isActive: true, isEmailVerified: true } });
  if (!user) { console.error(`No account with e-mail ${email}. The person must sign up and verify their e-mail first.`); process.exitCode = 1; return; }
  if (user.role === 'ADMIN') { console.log(`${email} is already an Administrator. Nothing to do.`); return; }
  if (!user.isEmailVerified) { console.error(`${email} has not verified their e-mail. Refusing.`); process.exitCode = 1; return; }
  if (!user.isActive) { console.error(`${email} is deactivated/suspended. Refusing.`); process.exitCode = 1; return; }

  console.log(`Would change ${user.email} (${user.name}) from ${user.role} to ADMIN and sign them out everywhere.`);
  if (user.role === 'WORKER') console.log('Note: this account is a professional. An admin account cannot also take bookings; use a separate account if needed.');
  if (!apply) { console.log('Dry run only. Re-run with --apply to make the change.'); return; }

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN', tokenVersion: { increment: 1 } } }),
    prisma.auditLog.create({ data: { userId: null, action: 'ADMIN_PROMOTED_VIA_CLI', entityType: 'USER', entityId: user.id, details: { email: user.email, previousRole: user.role, via: 'scripts/promote-admin.js' } } })
  ]);
  console.log(`Done. ${email} is now an Administrator and must sign in again.`);
})().catch((e) => { console.error('Failed:', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
