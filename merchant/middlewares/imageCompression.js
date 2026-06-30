// middlewares/imageCompression.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const heicConvert = require("heic-convert");

const TARGET_KB_DEFAULT = 100;

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/svg",

  // iPhone formats
  "image/heic",
  "image/heif",

  // fallback for some mobile/API clients
  "application/octet-stream",
]);

const allowedExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",

  // iPhone formats
  ".heic",
  ".heif",
]);

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

function collectUploadedFiles(req) {
  const files = [];

  if (req.file) files.push(req.file);

  if (Array.isArray(req.files)) {
    files.push(...req.files);
  }

  if (req.files && typeof req.files === "object" && !Array.isArray(req.files)) {
    Object.values(req.files).forEach((value) => {
      if (Array.isArray(value)) files.push(...value);
    });
  }

  // Remove duplicate files by path/filename
  const seen = new Set();

  return files.filter((file) => {
    const key = file?.path || file?.filename;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

  console.log("[HEIC CONVERT] converting HEIC/HEIF to JPEG buffer", {
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
    targetKB = TARGET_KB_DEFAULT,
    startQuality = 82,
    minQuality = 35,
    startWidth = 1000,
    startHeight = 1000,
    minWidth = 300,
    minHeight = 300,
  } = options;

  const targetBytes = targetKB * 1024;

  // Validate actual image content after possible HEIC conversion.
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

        console.log("[IMAGE COMPRESSED]", {
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

  console.log("[IMAGE COMPRESSED - ABOVE TARGET]", {
    file: outputPath,
    targetKB,
    ...finalMeta,
  });

  return finalMeta;
}

async function compressImageToTargetKB(inputPath, options = {}) {
  const {
    targetKB = TARGET_KB_DEFAULT,
    startQuality = 82,
    minQuality = 35,
    startWidth = 1000,
    startHeight = 1000,
    minWidth = 300,
    minHeight = 300,

    // optional full multer file object for HEIC detection
    file = null,
  } = options;

  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error("Image file not found for compression.");
  }

  const inputBuffer = file
    ? await getInputBufferForSharp(file)
    : await getInputBufferForSharp(inputPath);

  return await compressImageBufferToTargetKB(inputBuffer, inputPath, {
    targetKB,
    startQuality,
    minQuality,
    startWidth,
    startHeight,
    minWidth,
    minHeight,
  });
}

async function compressFilesFromRequest(req, options = {}) {
  const files = collectUploadedFiles(req);

  if (!files.length) return [];

  req.compressed_files = [];

  for (const file of files) {
    if (!file?.path) continue;

    if (!isLikelyImage(file)) {
      deleteFileIfExists(file.path);

      throw new Error(
        `Only image files are allowed. Received field=${file.fieldname}, originalname=${file.originalname}, mimetype=${file.mimetype}`,
      );
    }

    try {
      const compression = await compressImageToTargetKB(file.path, {
        file,
        targetKB: TARGET_KB_DEFAULT,
        ...options,
      });

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
      console.error("[IMAGE COMPRESSION ERROR]", {
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        error: err.message,
      });

      deleteFileIfExists(file.path);

      throw new Error(
        `Only valid image files are allowed. This image type could not be converted on the server. ${err.message}`,
      );
    }
  }

  return req.compressed_files;
}

function wrapMulterWithCompression(multerMiddleware, options = {}) {
  return (req, res, next) => {
    multerMiddleware(req, res, async (err) => {
      if (err) return next(err);

      try {
        await compressFilesFromRequest(req, {
          targetKB: TARGET_KB_DEFAULT,
          ...options,
        });

        return next();
      } catch (compressionErr) {
        return next(compressionErr);
      }
    });
  };
}

module.exports = {
  ensureDirSync,
  isLikelyImage,
  isHeicFile,
  compressImageToTargetKB,
  compressImageBufferToTargetKB,
  compressFilesFromRequest,
  wrapMulterWithCompression,
};