// middlewares/uploadMartMenuImage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

const SUBFOLDER = "mart-menu";
const DEST = path.join(UPLOAD_ROOT, SUBFOLDER);

const TARGET_KB = Number(process.env.MART_MENU_IMAGE_TARGET_KB || 100);
const MAX_BYTES = Number(
  process.env.MART_MENU_IMAGE_MAX_BYTES || 5 * 1024 * 1024,
);

const MAX_FILES = Number(process.env.MART_MENU_IMAGE_MAX_FILES || 15);

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
  "image/svg",
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

  console.log("[MART MENU HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
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

        console.log("[MART MENU IMAGE COMPRESSED]", {
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

  console.log("[MART MENU IMAGE COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

/* ---------------- storage ---------------- */

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
    const base = slugBase(req.body?.item_name || "item");
    const unique = `${Date.now()}-${crypto.randomUUID()}`;

    // Save original upload temporarily.
    // After compression, final filename becomes .webp.
    cb(null, `${unique}-${base}.upload`);
  },
});

/* ---------------- validation ---------------- */

const fileFilter = (_req, file, cb) => {
  console.log("[MART MENU IMAGE RECEIVED]", {
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

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_BYTES,
    files: MAX_FILES,
  },
});

/* ---------------- compression after upload ---------------- */

async function compressOneUploadedFile(file) {
  if (!file?.path) return null;

  const oldPath = file.path;
  const oldFilename = file.filename;

  const inputBuffer = await getInputBufferForSharp(file);

  // Validate real image content after possible HEIC conversion.
  await sharp(inputBuffer).metadata();

  const finalFilename = oldFilename.replace(/\.upload$/i, ".webp");
  const finalPath = path.join(file.destination, finalFilename);

  const compression = await compressImageBufferToTargetKB(inputBuffer, finalPath, {
    targetKB: TARGET_KB,
  });

  deleteFileIfExists(oldPath);

  const stat = fs.statSync(finalPath);

  file.filename = finalFilename;
  file.path = finalPath;
  file.size = stat.size;
  file.mimetype = "image/webp";
  file.compression = compression;

  return file;
}

async function compressUploadedMartMenuImages(req, res, next) {
  const files = Array.isArray(req.files) ? req.files : [];

  if (!files.length) return next();

  try {
    req.compressed_files = [];

    for (const file of files) {
      const compressedFile = await compressOneUploadedFile(file);

      if (compressedFile?.compression) {
        req.compressed_files.push({
          fieldname: compressedFile.fieldname,
          originalname: compressedFile.originalname,
          filename: compressedFile.filename,
          path: compressedFile.path,
          sizeKB: compressedFile.compression.sizeKB,
          quality: compressedFile.compression.quality,
          width: compressedFile.compression.width,
          height: compressedFile.compression.height,
        });
      }
    }

    return next();
  } catch (err) {
    console.error("[MART MENU IMAGE COMPRESSION ERROR]", {
      error: err.message,
    });

    for (const file of files) {
      deleteFileIfExists(file?.path);
    }

    return res.status(400).json({
      success: false,
      message:
        "Only valid image files are allowed. This image type could not be converted on the server.",
      error: err.message,
    });
  }
}

/* ---------------- main middleware ---------------- */

// ✅ Accept ANY fields, then normalize main and additional images.
function uploadMartMenuImage(req, res, next) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  if (!ct.includes("multipart/form-data")) {
    return next();
  }

  upload.any()(req, res, (err) => {
    if (err) {
      console.error("[MART MENU MULTER ERROR]", {
        code: err.code,
        field: err.field,
        message: err.message,
      });

      err.statusCode = 400;
      return next(err);
    }

    return compressUploadedMartMenuImages(req, res, () => {
      const files = req.files || [];

      // Find main image
      req.file = files.find(
        (f) =>
          f.fieldname === "item_image" ||
          f.fieldname === "image" ||
          f.fieldname === "file",
      );

      // Find additional images
      const additionalImages = files.filter(
        (f) => f.fieldname === "additional_images",
      );

      // Find product_images files if any; treat as additional images
      const productImageFiles = files.filter(
        (f) => f.fieldname === "product_images",
      );

      req.additionalFiles = [...additionalImages, ...productImageFiles];

      // Store all file paths for processing
      req.allUploadedFiles = files;

      return next();
    });
  });
}

/* ---------------- public web paths ---------------- */

function toWebPath(fileObj) {
  if (!fileObj || !fileObj.filename) return null;
  return `/uploads/${SUBFOLDER}/${fileObj.filename}`;
}

function toWebPaths(fileObjs) {
  if (!fileObjs || !fileObjs.length) return [];
  return fileObjs
    .map((file) => (file?.filename ? `/uploads/${SUBFOLDER}/${file.filename}` : null))
    .filter(Boolean);
}

module.exports = {
  uploadMartMenuImage,
  toWebPath,
  toWebPaths,
  DEST,
  SUBFOLDER,
  UPLOAD_ROOT,
  TARGET_KB,
};