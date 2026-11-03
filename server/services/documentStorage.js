// Private storage for worker verification documents (Supabase Storage, service-role access only).
// Objects live in a NON-public bucket; the only way to read one is a short-lived signed URL that
// the admin-only endpoint mints (and audit-logs). Public URLs are never generated for this bucket.
const supabaseConfig = require('../config/supabase');

const BUCKET = 'worker-documents';
const MAX_BYTES = 8 * 1024 * 1024;
const SIGNED_URL_SECONDS = 120;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXTENSION = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Identify the file from its leading bytes. The client-supplied Content-Type is not trusted.
const sniffMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};

class StorageError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

const admin = () => {
  const client = supabaseConfig.supabaseAdmin;
  if (!client) throw new StorageError('Document storage is not configured on the server.', 503);
  return client;
};

let bucketChecked = false;
// Creates the private bucket on first use; refuses to proceed if it exists and is public.
const ensureBucket = async () => {
  if (bucketChecked) return;
  const storage = admin().storage;
  const { data, error } = await storage.getBucket(BUCKET);
  if (error || !data) {
    const created = await storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ALLOWED_TYPES });
    if (created.error && !/already exists/i.test(created.error.message || '')) {
      throw new StorageError('Could not prepare the private document bucket.');
    }
    const again = await storage.getBucket(BUCKET);
    if (again.data && again.data.public) throw new StorageError('Document bucket is public; refusing to store identity documents in it.');
  } else if (data.public) {
    throw new StorageError('Document bucket is public; refusing to store identity documents in it. Make it private in Supabase Storage.');
  }
  bucketChecked = true;
};

const putObject = async (path, buffer, contentType) => {
  await ensureBucket();
  const { error } = await admin().storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw new StorageError('Failed to store the document.');
};

const signedUrl = async (path, seconds = SIGNED_URL_SECONDS) => {
  await ensureBucket();
  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error || !data || !data.signedUrl) throw new StorageError('Could not create a secure link for this document.');
  return data.signedUrl;
};

const removeObject = async (path) => {
  try { await admin().storage.from(BUCKET).remove([path]); } catch (e) { /* best effort cleanup */ }
};

const _resetForTests = () => { bucketChecked = false; };

module.exports = { BUCKET, MAX_BYTES, SIGNED_URL_SECONDS, ALLOWED_TYPES, EXTENSION, StorageError, sniffMime, ensureBucket, putObject, signedUrl, removeObject, _resetForTests };
