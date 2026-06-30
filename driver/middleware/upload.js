// middleware/upload.js
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

/* ---------------- folders ---------------- */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const profileDir = path.join(UPLOAD_ROOT, "profiles");
const documentDir = path.join(UPLOAD_ROOT, "documents");

makeDir(UPLOAD_ROOT);
makeDir(profileDir);
makeDir(documentDir);

/* ---------------- helpers ---------------- */

const allowedImageMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/octet-stream", // fallback for some clients
]);

const allowedImageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
]);

function isLikelyImage(file) {
  if (!file) return false;

  const mimetype = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  return allowedImageMimeTypes.has(mimetype) || allowedImageExtensions.has(ext);
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

const fileFilter = (_req, file, cb) => {
  console.log("[DRIVER UPLOAD FILE]", {
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

async function getInputBufferForSharp(file) {
  const inputBuffer = fs.readFileSync(file.path);

  if (!isHeicFile(file)) {
    return inputBuffer;
  }

  console.log("[DRIVER HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
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

async function compressImageBufferToTargetKB(inputBuffer, outputPath, options = {}) {
  const {
    targetKB = 100,
    startQuality = 80,
    minQuality = 35,
    startWidth = 900,
    startHeight = 900,
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

        console.log("[DRIVER IMAGE COMPRESSED]", {
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

  console.log("[DRIVER IMAGE COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/**
 * Multer runs before compression.
 * This middleware compresses whatever multer has saved.
 */
function compressUploadedImages(options = {}) {
  const compressionOptions = {
    targetKB: 100,
    startQuality: 80,
    minQuality: 35,
    startWidth: 900,
    startHeight: 900,
    minWidth: 300,
    minHeight: 300,
    ...options,
  };

  return async (req, res, next) => {
    try {
      const files = [];

      if (req.file) {
        files.push(req.file);
      }

      if (Array.isArray(req.files)) {
        files.push(...req.files);
      }

      if (
        req.files &&
        typeof req.files === "object" &&
        !Array.isArray(req.files)
      ) {
        Object.values(req.files).forEach((value) => {
          if (Array.isArray(value)) files.push(...value);
        });
      }

      if (!files.length) return next();

      req.compressed_files = [];

      for (const file of files) {
        if (!file?.path) continue;

        try {
          const inputBuffer = await getInputBufferForSharp(file);

          // Validate real image after possible HEIC conversion.
          await sharp(inputBuffer).metadata();

          const compression = await compressImageBufferToTargetKB(
            inputBuffer,
            file.path,
            compressionOptions,
          );

          const stat = fs.statSync(file.path);

          file.size = stat.size;
          file.mimetype = "image/webp";
          file.compression = compression;

          req.compressed_files.push({
            fieldname: file.fieldname,
            originalname: file.originalname,
            filename: file.filename,
            path: file.path,
            sizeKB: compression.sizeKB,
            quality: compression.quality,
            width: compression.width,
            height: compression.height,
          });
        } catch (err) {
          console.error("[DRIVER IMAGE COMPRESSION ERROR]", {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            error: err.message,
          });

          deleteFileIfExists(file.path);

          return res.status(400).json({
            success: false,
            message:
              "Only valid image files are allowed. This image type could not be converted on the server.",
            error: err.message,
          });
        }
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/* ---------------- profile upload ---------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profileDir),

    filename: (_req, _file, cb) => {
      // Final compressed image is WebP.
      const fileName = `profile_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ---------------- document upload ---------------- */

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, documentDir),

    filename: (_req, _file, cb) => {
      // Final compressed image is WebP.
      const fileName = `doc_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter,

  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

/* ---------------- exports: keep old functionality ---------------- */

module.exports = upload;
module.exports.documentUpload = documentUpload;
module.exports.compressUploadedImages = compressUploadedImages;
module.exports.compressImageBufferToTargetKB = compressImageBufferToTargetKB;
module.exports.UPLOAD_ROOT = UPLOAD_ROOT;