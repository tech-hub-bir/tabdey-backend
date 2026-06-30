// middlewares/businessTypesImage.js
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const {
  ensureDirSync,
  isLikelyImage,
  compressFilesFromRequest,
} = require("./imageCompression");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

const SUBFOLDER = "business-types";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

ensureDirSync(DEST);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },

  filename: (req, file, cb) => {
    const base =
      (req.body?.name || "bt")
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60) || "bt";

    const unique = `${Date.now()}-${crypto.randomUUID()}`;

    // Save compressed output as webp
    cb(null, `${unique}-${base}.webp`);
  },
});

const fileFilter = (_req, file, cb) => {
  console.log("[BUSINESS TYPE IMAGE RECEIVED]", {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  if (isLikelyImage(file)) return cb(null, true);

  return cb(
    new Error(
      `Only image files are allowed. Received mimetype=${file.mimetype}, file=${file.originalname}`,
    ),
  );
};

const rawUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single("image");

function uploadBusinessTypeImage(req, res, next) {
  rawUpload(req, res, async (err) => {
    if (err) return next(err);

    try {
      await compressFilesFromRequest(req, { targetKB: 100 });
      return next();
    } catch (compressionErr) {
      return next(compressionErr);
    }
  });
}

function toWebPath(fileObj) {
  return fileObj?.filename ? `/uploads/${SUBFOLDER}/${fileObj.filename}` : null;
}

module.exports = {
  uploadBusinessTypeImage,
  toWebPath,
  SUBFOLDER,
};