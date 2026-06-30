const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

/* ---------------- upload folders ---------------- */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.resolve(__dirname, "../uploads");

const makeDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // console.log("✅ Created folder:", dir);
  }
};

const logoImageDir = path.join(UPLOAD_ROOT, "logo_and_image");

makeDir(UPLOAD_ROOT);
makeDir(logoImageDir);

/* ---------------- config ---------------- */

const TARGET_KB = Number(process.env.LOGO_IMAGE_TARGET_KB || 100);
const MAX_BYTES = Number(process.env.LOGO_IMAGE_MAX_BYTES || 5 * 1024 * 1024);

/* ---------------- multer upload ---------------- */

/**
 * Important:
 * We do not reject in fileFilter.
 * Some clients may send strange mimetypes.
 * We validate properly in controller using isValidImageFile().
 */
const logoImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      makeDir(UPLOAD_ROOT);
      makeDir(logoImageDir);
      cb(null, logoImageDir);
    },

    filename: (_req, _file, cb) => {
      /**
       * Save temporary upload first.
       * After compression, final output remains this .webp file path.
       */
      const fileName = `logo_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.webp`;

      cb(null, fileName);
    },
  }),

  fileFilter: (_req, file, cb) => {
    console.log("[UPLOAD FILE RECEIVED]", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    cb(null, true);
  },

  limits: {
    fileSize: MAX_BYTES,
  },
});

/* ---------------- image validation ---------------- */

function isValidImageFile(file) {
  if (!file) return false;

  const allowedMimeTypes = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
    "application/octet-stream", // fallback for some API clients
  ]);

  const allowedExtensions = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".heic",
    ".heif",
  ]);

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

/* ---------------- HEIC conversion helper ---------------- */

async function getInputBufferForSharp(fileOrPath) {
  let file = null;
  let inputPath = null;

  if (typeof fileOrPath === "string") {
    inputPath = fileOrPath;
  } else {
    file = fileOrPath;
    inputPath = file?.path;
  }

  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error("Image file not found for compression.");
  }

  const inputBuffer = fs.readFileSync(inputPath);

  if (!file || !isHeicFile(file)) {
    return inputBuffer;
  }

  console.log("[LOGO HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
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

/* ---------------- compression helper ---------------- */

/**
 * Compress image to target KB.
 *
 * Supports:
 * - inputPath only: compress normal images using sharp
 * - inputPath + { file }: supports HEIC/HEIF conversion
 *
 * Example:
 * await compressImageToTargetKB(imageFile.path, { file: imageFile, targetKB: 100 });
 */
async function compressImageToTargetKB(inputPath, options = {}) {
  const {
    targetKB = TARGET_KB,
    startQuality = 80,
    minQuality = 35,
    startWidth = 900,
    startHeight = 900,
    minWidth = 300,
    minHeight = 300,
    file = null,
  } = options;

  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error("Image file not found for compression.");
  }

  const inputBuffer = file
    ? await getInputBufferForSharp(file)
    : await getInputBufferForSharp(inputPath);

  // Validate actual image content after possible HEIC conversion.
  await sharp(inputBuffer).metadata();

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
        fs.writeFileSync(inputPath, buffer);

        // console.log("[IMAGE COMPRESSED]", {
        //   file: inputPath,
        //   targetKB,
        //   ...finalMeta,
        // });

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

  fs.writeFileSync(inputPath, finalBuffer);

  // console.log("[IMAGE COMPRESSED - ABOVE TARGET]", {
  //   file: inputPath,
  //   targetKB,
  //   ...finalMeta,
  // });

  return finalMeta;
}

/* ---------------- exports ---------------- */

module.exports = {
  logoImageUpload,
  compressImageToTargetKB,
  isValidImageFile,
  UPLOAD_ROOT,
  TARGET_KB,
};