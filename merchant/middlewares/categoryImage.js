// middlewares/categoryImage.js
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

function subfolderFor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "food") return "food-category";
  if (k === "mart") return "mart-category";
  return "category";
}

function slugBase(v = "cat") {
  return (
    (String(v) || "cat")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "cat"
  );
}

function storageFactory() {
  return multer.diskStorage({
    destination: function (req, _file, cb) {
      const kind = req.params.kind || req.query.kind || "category";
      const dest = path.join(UPLOAD_ROOT, subfolderFor(kind));
      ensureDirSync(dest);
      cb(null, dest);
    },

    filename: function (req, file, cb) {
      const base = slugBase(req.body?.category_name || "cat");
      const unique = `${Date.now()}-${crypto.randomUUID()}`;

      // Save compressed output as webp
      cb(null, `${unique}-${base}.webp`);
    },
  });
}

const fileFilter = (_req, file, cb) => {
  console.log("[CATEGORY IMAGE RECEIVED]", {
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

function uploadCategoryImage() {
  const uploader = multer({
    storage: storageFactory(),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  }).any();

  return (req, res, next) => {
    uploader(req, res, async (err) => {
      if (err) return next(err);

      const allowedNames = new Set(["category_image", "image"]);
      const files = Array.isArray(req.files) ? req.files : [];
      const picked = files.find((f) => allowedNames.has(f.fieldname));

      req.file = picked || null;

      try {
        await compressFilesFromRequest(req, { targetKB: 100 });
        return next();
      } catch (compressionErr) {
        return next(compressionErr);
      }
    });
  };
}

function toWebPathFromFile(req, fileObj) {
  if (!fileObj || !fileObj.filename) return null;

  const sub = subfolderFor(req.params.kind || req.query.kind);

  return `/uploads/${sub}/${fileObj.filename}`;
}

module.exports = {
  uploadCategoryImage,
  toWebPathFromFile,
  ensureDirSync,
  UPLOAD_ROOT,
};