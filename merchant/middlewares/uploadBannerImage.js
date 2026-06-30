// middlewares/uploadBannerImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const {
  ensureDirSync,
  isLikelyImage,
  compressFilesFromRequest,
} = require("./imageCompression");

// ✅ Root upload dir
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

const SUBFOLDER = "banners";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

ensureDirSync(DEST);

function slugBase(v = "banner") {
  return (
    (String(v) || "banner")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "banner"
  );
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },

  filename: function (req, file, cb) {
    const base = slugBase(req.body?.title || "banner");
    const unique = `${Date.now()}-${crypto.randomUUID()}`;

    // Save compressed output as webp
    cb(null, `${unique}-${base}.webp`);
  },
});

const fileFilter = (_req, file, cb) => {
  console.log("[BANNER IMAGE RECEIVED]", {
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

/**
 * Accept either "banner_image" or "image", normalize to req.file
 */
function uploadBannerImage() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).fields([
    { name: "banner_image", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]);

  return (req, res, next) => {
    uploader(req, res, async (err) => {
      if (err) {
        err.statusCode = 400;
        return next(err);
      }

      const any = req.files || {};

      req.file =
        (Array.isArray(any.banner_image) && any.banner_image[0]) ||
        (Array.isArray(any.image) && any.image[0]) ||
        null;

      try {
        await compressFilesFromRequest(req, { targetKB: 100 });
        return next();
      } catch (compressionErr) {
        compressionErr.statusCode = 400;
        return next(compressionErr);
      }
    });
  };
}

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadBannerImage,
  toWebPath,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
};