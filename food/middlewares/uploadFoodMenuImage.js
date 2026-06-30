const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

// ✅ Use environment variable or fallback for local
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

const SUBFOLDER = "food-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

const TARGET_KB = Number(process.env.FOOD_MENU_IMAGE_TARGET_KB || 100);
const MAX_BYTES = Number(
  process.env.FOOD_MENU_IMAGE_MAX_BYTES || 5 * 1024 * 1024,
);

// 🔧 Ensure folder exists
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDirSync(DEST);

/* ---------------- helpers ---------------- */

function slugBase(value = "item") {
  return (
    String(value || "item")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "item"
  );
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function isHeicFile(file) {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();

  return (
    mimetype === "image/heic" ||
    mimetype === "image/heif" ||
    ext === ".heic" ||
    ext === ".heif"
  );
}

const allowedMimes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "application/octet-stream",
]);

const allowedExts = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
  ".heic",
  ".heif",
]);

function isLikelyImage(file) {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();

  return allowedMimes.has(mimetype) || allowedExts.has(ext);
}

async function getInputBufferForSharp(file) {
  const inputBuffer = fs.readFileSync(file.path);

  if (!isHeicFile(file)) {
    return inputBuffer;
  }

  console.log("[FOOD MENU HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  const jpegBuffer = await heicConvert({
    buffer: inputBuffer,
    format: "JPEG",
    quality: 0.9,
  });

  return Buffer.from(jpegBuffer);
}

async function compressImageBufferToTargetKB(
  inputBuffer,
  outputPath,
  options = {},
) {
  const {
    targetKB = TARGET_KB,
    startQuality = 82,
    minQuality = 35,
    startWidth = 1000,
    startHeight = 1000,
    minWidth = 300,
    minHeight = 300,
  } = options;

  const targetBytes = targetKB * 1024;

  let width = startWidth;
  let height = startHeight;
  let quality = startQuality;
  let finalBuffer = null;
  let finalMeta = null;

  while (width >= minWidth && height >= minHeight) {
    quality = startQuality;

    while (quality >= minQuality) {
      const buffer = await sharp(inputBuffer)
        .rotate()
        .resize({
          width,
          height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({
          quality,
          effort: 6,
        })
        .toBuffer();

      finalBuffer = buffer;

      finalMeta = {
        width,
        height,
        quality,
        sizeKB: Number((buffer.length / 1024).toFixed(2)),
      };

      if (buffer.length <= targetBytes) {
        fs.writeFileSync(outputPath, buffer);

        console.log("[FOOD MENU IMAGE COMPRESSED]", {
          file: outputPath,
          targetKB,
          ...finalMeta,
        });

        return finalMeta;
      }

      quality -= 5;
    }

    width = Math.floor(width * 0.85);
    height = Math.floor(height * 0.85);
  }

  if (!finalBuffer) {
    throw new Error("Image compression failed.");
  }

  fs.writeFileSync(outputPath, finalBuffer);

  console.log("[FOOD MENU IMAGE COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/* ---------------- storage ---------------- */

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
    const base = slugBase(req.body?.item_name || "item");
    const unique = `${Date.now()}-${crypto.randomUUID()}`;

    // Save temporary original upload first.
    // After compression, final file becomes .webp.
    cb(null, `${unique}-${base}.upload`);
  },
});

/* ---------------- file validation ---------------- */

const fileFilter = (_req, file, cb) => {
  console.log("[FOOD MENU IMAGE RECEIVED]", {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  if (isLikelyImage(file)) return cb(null, true);

  return cb(
    new Error(
      `Only image files are allowed. Received mimetype=${file.mimetype}, file=${file.originalname}`,
    ),
    false,
  );
};

/* ---------------- compression after upload ---------------- */

async function compressUploadedFoodMenuImage(req, res, next) {
  if (!req.file) return next();

  const oldPath = req.file.path;
  const oldFilename = req.file.filename;

  try {
    const inputBuffer = await getInputBufferForSharp(req.file);

    // Validate real image content after possible HEIC conversion.
    await sharp(inputBuffer).metadata();

    const finalFilename = oldFilename.replace(/\.upload$/i, ".webp");
    const finalPath = path.join(req.file.destination, finalFilename);

    const compression = await compressImageBufferToTargetKB(
      inputBuffer,
      finalPath,
      {
        targetKB: TARGET_KB,
      },
    );

    deleteFileIfExists(oldPath);

    const stat = fs.statSync(finalPath);

    req.file.filename = finalFilename;
    req.file.path = finalPath;
    req.file.size = stat.size;
    req.file.mimetype = "image/webp";
    req.file.compression = compression;

    return next();
  } catch (err) {
    console.error("[FOOD MENU IMAGE COMPRESSION ERROR]", {
      originalname: req.file?.originalname,
      mimetype: req.file?.mimetype,
      error: err.message,
    });

    deleteFileIfExists(oldPath);

    return res.status(400).json({
      success: false,
      message:
        "Only valid image files are allowed. This image type could not be converted on the server.",
      error: err.message,
    });
  }
}

/* ---------------- main upload middleware ---------------- */

function uploadFoodMenuImage(req, res, next) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  if (!ct.includes("multipart/form-data")) return next();

  const uploader = multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_BYTES,
      files: 1,
    },
  }).fields([
    { name: "item_image", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]);

  uploader(req, res, (err) => {
    if (err) {
      console.error("[FOOD MENU IMAGE MULTER ERROR]", {
        code: err.code,
        field: err.field,
        message: err.message,
      });

      err.statusCode = 400;
      return next(err);
    }

    const any = req.files || {};

    req.file =
      (Array.isArray(any.item_image) && any.item_image[0]) ||
      (Array.isArray(any.image) && any.image[0]) ||
      null;

    return compressUploadedFoodMenuImage(req, res, next);
  });
}

/* ---------------- public web path ---------------- */

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

module.exports = {
  uploadFoodMenuImage,
  toWebPath,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
  TARGET_KB,
};