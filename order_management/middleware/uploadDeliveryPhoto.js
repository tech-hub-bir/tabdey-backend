const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

/* ===================== CONFIG ===================== */

// ✅ Root upload dir.
// For K8s, prefer process.env.UPLOAD_ROOT = /uploads
// For local, fallback to ./uploads
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

const SUBFOLDER = "order_delivery_photos";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

const MAX_PHOTOS = Number(process.env.DELIVERY_PHOTO_MAX || 6);

const MAX_BYTES = Number(
  process.env.DELIVERY_PHOTO_MAX_BYTES || 5 * 1024 * 1024,
); // 5MB upload limit before compression

const TARGET_KB = Number(process.env.DELIVERY_PHOTO_TARGET_KB || 100);

/* ===================== DIR HELPERS ===================== */

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
}

try {
  ensureDirSync(UPLOAD_ROOT);
  ensureDirSync(DEST);
} catch (err) {
  console.error(`❌ Failed to create directory ${DEST}:`, err.message);
}

/* ===================== IMAGE HELPERS ===================== */

const allowedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",

  // ✅ iPhone camera formats
  "image/heic",
  "image/heif",

  // fallback for some clients
  "application/octet-stream",
]);

const allowedExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",

  // ✅ iPhone camera formats
  ".heic",
  ".heif",
]);

function isLikelyImage(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  return allowedMimeTypes.has(mimetype) || allowedExtensions.has(ext);
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

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

async function getInputBufferForSharp(file) {
  const inputBuffer = fs.readFileSync(file.path);

  if (!isHeicFile(file)) {
    return inputBuffer;
  }

  console.log("[DELIVERY PHOTO HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
    fieldname: file.fieldname,
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

  // ✅ Validate actual image content after possible HEIC conversion
  await sharp(inputBuffer).metadata();

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

        console.log("[DELIVERY PHOTO COMPRESSED]", {
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

  // Save smallest generated version even if still above target.
  fs.writeFileSync(outputPath, finalBuffer);

  console.log("[DELIVERY PHOTO COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/* ===================== MULTER STORAGE ===================== */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      ensureDirSync(DEST);
      cb(null, DEST);
    } catch (e) {
      cb(e);
    }
  },

  filename: (_req, _file, cb) => {
    // ✅ Save final compressed image as webp.
    cb(null, `delivery_${Date.now()}_${crypto.randomUUID()}.webp`);
  },
});

const fileFilter = (_req, file, cb) => {
  console.log("[DELIVERY PHOTO RECEIVED]", {
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

/* ===================== UPLOAD MIDDLEWARE ===================== */

function uploadDeliveryPhotosFactory() {
  const uploader = multer({
    storage,
    fileFilter,
    limits: {
      fileSize: MAX_BYTES,
      files: MAX_PHOTOS,
    },
  }).fields([
    { name: "delivery_photo", maxCount: MAX_PHOTOS },
    { name: "delivery_photos", maxCount: MAX_PHOTOS },
    { name: "delivery_photo[]", maxCount: MAX_PHOTOS },
    { name: "image", maxCount: MAX_PHOTOS },
    { name: "images", maxCount: MAX_PHOTOS },
  ]);

  return (req, res, next) => {
    uploader(req, res, async (err) => {
      if (err) {
        console.error("[uploadDeliveryPhotos] multer error:", err);

        return res.status(400).json({
          success: false,
          message: err.message || "Upload failed",
          code: err.code,
          field: err.field,
        });
      }

      const any = req.files || {};

      const list = []
        .concat(any.delivery_photo || [])
        .concat(any.delivery_photos || [])
        .concat(any["delivery_photo[]"] || [])
        .concat(any.image || [])
        .concat(any.images || []);

      if (list.length > MAX_PHOTOS) {
        console.error("[uploadDeliveryPhotos] Too many files:", list.length);

        return res.status(400).json({
          success: false,
          message: `You can upload up to ${MAX_PHOTOS} photos only.`,
          received: list.length,
        });
      }

      try {
        req.deliveryPhotoCompression = [];

        for (const file of list) {
          if (!file?.path) continue;

          const inputBuffer = await getInputBufferForSharp(file);

          const compression = await compressImageBufferToTargetKB(
            inputBuffer,
            file.path,
            {
              targetKB: TARGET_KB,
            },
          );

          const stat = fs.statSync(file.path);

          // Keep multer file object updated after compression
          file.size = stat.size;
          file.mimetype = "image/webp";
          file.compression = compression;

          req.deliveryPhotoCompression.push({
            fieldname: file.fieldname,
            originalname: file.originalname,
            filename: file.filename,
            path: file.path,
            targetKB: TARGET_KB,
            sizeKB: compression.sizeKB,
            quality: compression.quality,
            width: compression.width,
            height: compression.height,
          });
        }

        req.deliveryPhotos = list;

        console.log("[uploadDeliveryPhotos] uploaded count:", list.length);
        console.log(
          "[uploadDeliveryPhotos] compression:",
          req.deliveryPhotoCompression,
        );

        return next();
      } catch (compressionErr) {
        console.error(
          "[uploadDeliveryPhotos] compression error:",
          compressionErr,
        );

        // Delete uploaded files if compression fails
        for (const file of list) {
          deleteFileIfExists(file?.path);
        }

        return res.status(400).json({
          success: false,
          message:
            "Only valid image files are allowed. This image type could not be converted on the server.",
          error: compressionErr.message || "Image compression failed",
        });
      }
    });
  };
}

/* ===================== WEB PATH HELPERS ===================== */

function toWebPath(fileObj) {
  if (!fileObj?.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

function toWebPaths(filesArr) {
  const arr = Array.isArray(filesArr) ? filesArr : [];
  return arr.map(toWebPath).filter(Boolean).slice(0, MAX_PHOTOS);
}

/* ===================== EXPORTS ===================== */

const uploadMiddleware = uploadDeliveryPhotosFactory();

module.exports = {
  uploadDeliveryPhotos: uploadMiddleware,
  toWebPath,
  toWebPaths,
  MAX_PHOTOS,
  SUBFOLDER,
  DEST,
  UPLOAD_ROOT,
  TARGET_KB,
};