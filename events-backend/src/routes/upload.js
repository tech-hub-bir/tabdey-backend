const router = require('express').Router();
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');
const s3 = require('../../config/minio');

const upload = multer({
  storage: multerS3({
    s3,
    bucket: 'events-uploads',
    metadata: (_req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.post('/', requireAuth, requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image uploaded or invalid file type.' });
  }
  const internalUrl = req.file.location;
  const publicUrl = internalUrl.replace('http://minio-service.default.svc.cluster.local:9000', process.env.MINIO_PUBLIC_URL);  res.json({ success: true, url: publicUrl });
});

module.exports = router;
