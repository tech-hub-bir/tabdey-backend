// routes/logoImageRoutes.js
const express = require("express");
const multer = require("multer");

const router = express.Router();

const LogoImageController = require("../controllers/logoImageController");
const { logoImageUpload } = require("../middleware/upload");
const { adminOrSuperAdminOnly } = require("../middleware/adminAuth");

/* ---------------- multer error handler ---------------- */
function handleMulterError(err, req, res, next) {
  if (!err) return next();

  console.error("[LOGO IMAGE MULTER ERROR]", {
    code: err.code,
    field: err.field,
    message: err.message,
    contentType: req.headers["content-type"],
  });

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Image file must be less than 5MB.",
      });
    }

    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        message: `Unexpected file field: ${err.field}. Use field name 'image'.`,
      });
    }

    return res.status(400).json({
      success: false,
      message: err.message || "Multer upload error.",
    });
  }

  return res.status(400).json({
    success: false,
    message: err.message || "File upload error.",
  });
}

/* ---------------- routes ---------------- */

// POST /api/logo-images
// multipart/form-data:
// name = text
// service_type = text
// image = file
router.post(
  "/",
  adminOrSuperAdminOnly,
  logoImageUpload.any(),
  handleMulterError,
  LogoImageController.create,
);

// GET /api/logo-images
router.get("/", LogoImageController.getAll);

// POST /api/logo-images/bulk-delete
// Keep this before "/:id"
router.post(
  "/bulk-delete",
  adminOrSuperAdminOnly,
  LogoImageController.bulkDelete,
);

// GET /api/logo-images/:id
router.get("/:id", LogoImageController.getById);

// PUT /api/logo-images/:id
// multipart/form-data:
// name = text optional
// service_type = text optional
// image = file optional
router.put(
  "/:id",
  adminOrSuperAdminOnly,
  logoImageUpload.any(),
  handleMulterError,
  LogoImageController.update,
);

// DELETE /api/logo-images/:id
router.delete(
  "/:id",
  adminOrSuperAdminOnly,
  LogoImageController.delete,
);

module.exports = router;