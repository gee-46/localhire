// LocalHire - verifies the PRIVATE worker-documents bucket against your real Supabase Storage.
//
//   node scripts/verify-worker-storage.js
//
// Non-destructive: creates the private bucket if missing, stores one tiny throwaway object under
// "_verify/", checks access rules, then deletes that object. It never deletes or alters the bucket,
// and never prints keys. Exit code is non-zero if any check FAILS.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const supabaseConfig = require('../config/supabase');
const storage = require('../services/documentStorage');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`); };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

(async () => {
  if (!supabaseConfig.supabaseAdmin) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env');
    process.exitCode = 1;
    return;
  }
  const base = `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1`;
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const objectPath = `_verify/${Date.now()}.png`;
  try {
    await storage.ensureBucket();
    const bucket = await supabaseConfig.supabaseAdmin.storage.getBucket(storage.BUCKET);
    check(`bucket "${storage.BUCKET}" exists and is PRIVATE`, Boolean(bucket.data) && bucket.data.public === false);
    check('bucket limits uploads to 8 MB and PDF/JPG/PNG/WebP', Boolean(bucket.data) && bucket.data.file_size_limit === storage.MAX_BYTES && (bucket.data.allowed_mime_types || []).includes('application/pdf'),
      bucket.data && bucket.data.file_size_limit ? '' : 'created without limits? set them in Storage -> worker-documents -> settings');

    await storage.putObject(objectPath, PNG, 'image/png');
    check('service role can store a document', true);

    const signed = await fetch(await storage.signedUrl(objectPath));
    const bytes = Buffer.from(await signed.arrayBuffer());
    check('signed URL returns the stored file', signed.status === 200 && bytes.equals(PNG), `HTTP ${signed.status}`);

    const pub = await fetch(`${base}/object/public/${storage.BUCKET}/${objectPath}`);
    check('public URL for the object is refused', pub.status >= 400, `HTTP ${pub.status}`);
    const anonRes = await fetch(`${base}/object/${storage.BUCKET}/${objectPath}`, anon ? { headers: { apikey: anon, Authorization: `Bearer ${anon}` } } : {});
    check('anonymous download is refused', anonRes.status >= 400, `HTTP ${anonRes.status}`);

    // The public photo bucket: intentionally public for reading, but limited, and NOT writable by anonymous visitors.
    const profile = await supabaseConfig.supabaseAdmin.storage.getBucket('profile-photos');
    const pb = profile.data;
    check('"profile-photos" bucket exists', Boolean(pb), profile.error ? profile.error.message : '');
    check('"profile-photos" is public (customers must see photos) with a 5 MB limit and JPG/PNG/WebP only',
      Boolean(pb) && pb.public === true && pb.file_size_limit === 5 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp'].every((m) => (pb.allowed_mime_types || []).includes(m)) && !(pb.allowed_mime_types || []).some((m) => /svg|html|pdf/i.test(m)),
      pb ? `public=${pb.public} limit=${pb.file_size_limit} types=${(pb.allowed_mime_types || []).join(',')}` : '');
    if (anon) {
      const probe = `_verify/anon-${Date.now()}.png`;
      const up = await fetch(`${base}/object/profile-photos/${probe}`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'image/png' }, body: PNG });
      check('anonymous (anon key) upload to "profile-photos" is refused', up.status >= 400, `HTTP ${up.status}`);
      if (up.status < 400) await supabaseConfig.supabaseAdmin.storage.from('profile-photos').remove([probe]);
      const list = await fetch(`${base}/object/list/${storage.BUCKET}`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 5 }) });
      const listed = list.status < 400 ? await list.json().catch(() => []) : [];
      check('anonymous listing of "worker-documents" shows nothing', list.status >= 400 || (Array.isArray(listed) && listed.length === 0), `HTTP ${list.status}`);
    } else {
      check('anonymous access checks (needs SUPABASE_ANON_KEY)', false, 'SUPABASE_ANON_KEY is not set');
    }
  } catch (e) {
    check('storage checks ran without error', false, e.message);
  } finally {
    await storage.removeObject(objectPath);
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'NOT READY' : 'READY'}: ${failed} failure(s). Also confirm in the Supabase dashboard (Storage) that "${storage.BUCKET}" shows as private.`);
  process.exitCode = failed ? 1 : 0;
})();
