// Preloaded by `npm test` (node --require). The test suite creates and deletes real rows, so it must never be pointed
// at a production database by accident.
//   * NODE_ENV=production is refused outright.
//   * A hosted database (Supabase) is refused unless ALLOW_TESTS_ON_HOSTED_DB=yes is set deliberately, for example for a
//     dedicated staging project. Never set it for the production project.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const url = String(process.env.DATABASE_URL || '');
if (String(process.env.NODE_ENV || '').trim() === 'production') {
  console.error('[Tests] REFUSING TO RUN: NODE_ENV=production. The tests write and delete data; run them against a local or dedicated staging database.');
  process.exit(1);
}
if (/supabase\.(co|com)|pooler\.supabase/i.test(url) && process.env.ALLOW_TESTS_ON_HOSTED_DB !== 'yes') {
  console.error('[Tests] REFUSING TO RUN: DATABASE_URL points at a hosted Supabase database. The tests create and delete rows. Use a local database, or set ALLOW_TESTS_ON_HOSTED_DB=yes only for a dedicated staging project (never production).');
  process.exit(1);
}
