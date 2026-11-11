// Public image storage (worker portfolio photographs) in the EXISTING public "profile-photos" bucket.
// These are meant to be seen by customers, unlike the private identity-document bucket.
const crypto = require('crypto');
const supabaseConfig = require('../config/supabase');
const { sniffMime, StorageError } = require('./documentStorage');

const BUCKET = 'profile-photos';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const client = () => {
  const admin = supabaseConfig.supabaseAdmin;
  if (!admin) throw new StorageError('Image storage is not configured on the server.', 503);
  return admin.storage.from(BUCKET);
};

// Validates the bytes (not the declared type), uploads, and returns { url, path }.
const putPortfolioImage = async (userId, buffer) => {
  const type = sniffMime(buffer);
  if (!IMAGE_TYPES.includes(type)) throw new StorageError('The file is not a valid JPG, PNG or WebP image.', 400);
  const path = `${userId}/portfolio-${crypto.randomUUID()}.${EXTENSION[type]}`;
  const bucket = client();
  const { error } = await bucket.upload(path, buffer, { contentType: type, upsert: false });
  if (error) throw new StorageError('Failed to store the image.');
  const { data } = bucket.getPublicUrl(path);
  if (!data || !data.publicUrl) throw new StorageError('Could not resolve the image URL.');
  return { url: data.publicUrl, path };
};

// Category icons/images (admin-managed, shown publicly next to the category name).
const putCategoryImage = async (categoryId, buffer) => {
  const type = sniffMime(buffer);
  if (!IMAGE_TYPES.includes(type)) throw new StorageError('The file is not a valid JPG, PNG or WebP image.', 400);
  const path = `category-icons/${categoryId}-${crypto.randomUUID()}.${EXTENSION[type]}`;
  const bucket = client();
  const { error } = await bucket.upload(path, buffer, { contentType: type, upsert: false });
  if (error) throw new StorageError('Failed to store the image.');
  const { data } = bucket.getPublicUrl(path);
  if (!data || !data.publicUrl) throw new StorageError('Could not resolve the image URL.');
  return { url: data.publicUrl, path };
};

const removePortfolioImage = async (path) => {
  try { await client().remove([path]); } catch (e) { /* best effort; the DB row is the source of truth */ }
};

module.exports = { BUCKET, putPortfolioImage, putCategoryImage, removePortfolioImage };
