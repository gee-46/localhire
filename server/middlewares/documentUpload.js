const multer = require('multer');
const { MAX_BYTES, ALLOWED_TYPES } = require('../services/documentStorage');

// Memory storage: the buffer is validated (magic bytes) and streamed to private Supabase Storage.
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => {
    if (!file || !ALLOWED_TYPES.includes(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Unsupported file type. Upload a PDF, JPG, PNG or WebP file.'));
    }
    cb(null, true);
  }
});

const handleDocumentUploadError = (err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File is too large. The maximum size is ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`
      : `Upload error: ${err.message}`;
    return res.status(400).json({ success: false, message });
  }
  return res.status(400).json({ success: false, message: err.message || 'Could not process the uploaded file.' });
};

module.exports = { documentUpload, handleDocumentUploadError };
