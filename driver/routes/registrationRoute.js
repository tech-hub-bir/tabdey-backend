// routes/registrationRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const {
  registerUser,
  loginUser,
  logoutUser,
  verifyActiveSession,
  refreshAccessToken,
} = require("../controllers/registrationController");

const {
  documentUpload,
  compressUploadedImages,
} = require("../middleware/upload");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/* ---------------- validators ---------------- */
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);

  if (Number.isFinite(uid) && uid > 0) return next();

  return res.status(400).json({
    success: false,
    message: "Invalid user_id",
  });
};

/* ---------------- multer error handler ---------------- */
function handleUploadError(err, req, res, next) {
  if (!err) return next();

  console.error("[DOCUMENT UPLOAD ERROR]", {
    code: err.code,
    field: err.field,
    message: err.message,
    contentType: req.headers["content-type"],
  });

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Document image must be less than 5MB.",
      });
    }

    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        message: `Unexpected file field: ${err.field}. Use field name 'document'.`,
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message || "Upload error.",
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "File upload error.",
  });
}

/* ---------------- limiters ---------------- */
const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many registration attempts. Please try again later.",
});

const loginLimiter = makeLimiter({
  windowMs: 2 * 60 * 1000, // 2 min
  max: 20,
  message: "Too many login attempts. Please try again later.",
});

const logoutLimiter = makeLimiter({
  windowMs: 2 * 60 * 1000, // 2 min
  max: 60,
  message: "Too many requests. Please slow down.",
});

/* ---------------- document upload endpoint ---------------- */
/**
 * POST /upload-document
 *
 * multipart/form-data:
 * document = image file
 *
 * The uploaded image will be compressed to target 100 KB
 * by compressUploadedImages().
 */
router.post(
  "/upload-document",
  documentUpload.single("document"),
  handleUploadError,
  compressUploadedImages({ targetKB: 100 }),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    const compressedInfo =
      Array.isArray(req.compressed_files) && req.compressed_files.length > 0
        ? req.compressed_files[0]
        : null;

    return res.status(200).json({
      success: true,
      message: "Document uploaded successfully.",
      path: `/uploads/documents/${req.file.filename}`,
      compression: compressedInfo
        ? {
            sizeKB: compressedInfo.sizeKB,
            quality: compressedInfo.quality,
            width: compressedInfo.width,
            height: compressedInfo.height,
          }
        : null,
    });
  },
);

/* ---------------- registration endpoint ---------------- */
router.post("/register", registerLimiter, registerUser);

/* ---------------- login endpoint ---------------- */
router.post("/login", loginLimiter, loginUser);

/* ---------------- logout ---------------- */
router.post("/logout/:user_id", logoutLimiter, validUserId, logoutUser);

/* ---------------- verify active session ---------------- */
router.post("/verify-session", loginLimiter, verifyActiveSession);

/* ---------------- refresh token ---------------- */
router.post("/refresh-token", loginLimiter, refreshAccessToken);

module.exports = router;
