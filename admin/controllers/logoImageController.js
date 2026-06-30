const fs = require("fs");
const path = require("path");

const LogoImageModel = require("../models/logoImageModel");

const {
  UPLOAD_ROOT,
  compressImageToTargetKB,
  isValidImageFile,
} = require("../middleware/upload");

/* ---------------- helpers ---------------- */

function toIntOrNull(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getActor(req) {
  const user = req.user || {};
  const body = req.body || {};

  return {
    user_id:
      toIntOrNull(user.user_id) ||
      toIntOrNull(user.id) ||
      toIntOrNull(user.userId) ||
      toIntOrNull(user.admin_id) ||
      toIntOrNull(req.headers["x-admin-id"]) ||
      toIntOrNull(body.user_id) ||
      null,

    admin_name:
      user.admin_name ||
      user.user_name ||
      user.name ||
      user.full_name ||
      user.email ||
      req.headers["x-admin-name"] ||
      body.admin_name ||
      null,
  };
}

function deleteFileIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted file:", filePath);
    }
  } catch (error) {
    console.error("Error deleting file:", error);
  }
}

function imageUrlToFilePath(imageUrl) {
  if (!imageUrl) return null;

  const cleanUrl = String(imageUrl).replace(/\\/g, "/");

  /**
   * DB image_url example:
   * /uploads/logo_and_image/logo_123.webp
   *
   * UPLOAD_ROOT example:
   * /admin/uploads
   *
   * final path:
   * /admin/uploads/logo_and_image/logo_123.webp
   */
  const relativePath = cleanUrl.replace(/^\/uploads\//, "");

  return path.join(UPLOAD_ROOT, relativePath);
}

function getUploadedImage(req) {
  if (req.file) return req.file;

  if (Array.isArray(req.files)) {
    return (
      req.files.find((file) => file.fieldname === "image") ||
      req.files[0] ||
      null
    );
  }

  if (req.files && typeof req.files === "object") {
    const imageFiles = req.files.image;

    if (Array.isArray(imageFiles) && imageFiles.length > 0) {
      return imageFiles[0];
    }
  }

  return null;
}

function debugLogoRequest(label, req, actor, imageFile) {
  console.log(`[${label}]`, {
    contentType: req.headers["content-type"],
    body: req.body || {},
    filesType: Array.isArray(req.files)
      ? "array"
      : req.files
        ? "object"
        : "none",
    filesCount: Array.isArray(req.files) ? req.files.length : undefined,
    file: imageFile
      ? {
          fieldname: imageFile.fieldname,
          originalname: imageFile.originalname,
          mimetype: imageFile.mimetype,
          filename: imageFile.filename,
          path: imageFile.path,
          size: imageFile.size,
        }
      : null,
    jwt_user: req.user || null,
    actor,
  });
}

async function compressLogoImageOrFail(imageFile) {
  if (!imageFile?.path) {
    throw new Error("Uploaded image path not found.");
  }

  return await compressImageToTargetKB(imageFile.path, {
    file: imageFile, // ✅ required for HEIC/HEIF detection and conversion
    targetKB: 100,
    startQuality: 80,
    minQuality: 35,
    startWidth: 900,
    startHeight: 900,
    minWidth: 300,
    minHeight: 300,
  });
}

/* ---------------- controller ---------------- */

const LogoImageController = {
  /**
   * POST /api/logo-images
   *
   * multipart/form-data:
   * name = text
   * service_type = text
   * image = file
   */
  async create(req, res) {
    let uploadedFilePath = null;

    try {
      const body = req.body || {};
      const actor = getActor(req);
      const imageFile = getUploadedImage(req);

      debugLogoRequest("LOGO CREATE DEBUG", req, actor, imageFile);

      const name = cleanString(body.name);
      const service_type = cleanString(body.service_type);

      if (imageFile?.path) {
        uploadedFilePath = imageFile.path;
      }

      if (!imageFile) {
        return res.status(400).json({
          success: false,
          message:
            "Image file is required. Use multipart/form-data with file field name exactly 'image'.",
        });
      }

      if (!isValidImageFile(imageFile)) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message: `Only image files are allowed. Received field=${imageFile.fieldname}, originalname=${imageFile.originalname}, mimetype=${imageFile.mimetype}`,
        });
      }

      if (!name) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message: "Name is required",
        });
      }

      if (!service_type) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message: "Service type is required",
        });
      }

      const compression = await compressLogoImageOrFail(imageFile);

      const image_url = `/uploads/logo_and_image/${imageFile.filename}`;

      const result = await LogoImageModel.create(
        {
          name,
          image_url,
          service_type,
        },
        actor.user_id,
        actor.admin_name,
      );

      if (result.validation || result.duplicate) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(result.duplicate ? 409 : 400).json({
          success: false,
          message: result.message,
        });
      }

      return res.status(201).json({
        success: true,
        message: "Logo/Image created successfully",
        actor_logged: {
          user_id: actor.user_id,
          admin_name: actor.admin_name,
        },
        compression,
        data: result.data,
      });
    } catch (error) {
      deleteFileIfExists(uploadedFilePath);

      console.error("Error creating logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/logo-images
   */
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        search = "",
        service_type = "",
      } = req.query || {};

      const result = await LogoImageModel.findAll({
        page,
        limit,
        search,
        service_type,
      });

      return res.status(200).json({
        success: true,
        data: result.items,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    } catch (error) {
      console.error("Error fetching logos/images:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/logo-images/:id
   */
  async getById(req, res) {
    try {
      const { id } = req.params;

      const item = await LogoImageModel.findById(id);

      if (!item) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: item,
      });
    } catch (error) {
      console.error("Error fetching logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  /**
   * PUT /api/logo-images/:id
   *
   * multipart/form-data:
   * name = text optional
   * service_type = text optional
   * image = file optional
   *
   * If image is uploaded:
   * - DB image_url remains same.
   * - Physical image file gets replaced.
   */
  async update(req, res) {
    let uploadedFilePath = null;

    try {
      const { id } = req.params;
      const body = req.body || {};
      const actor = getActor(req);
      const imageFile = getUploadedImage(req);

      debugLogoRequest("LOGO UPDATE DEBUG", req, actor, imageFile);

      const name = cleanString(body.name);
      const service_type = cleanString(body.service_type);

      if (imageFile?.path) {
        uploadedFilePath = imageFile.path;
      }

      if (imageFile && !isValidImageFile(imageFile)) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(400).json({
          success: false,
          message: `Only image files are allowed. Received field=${imageFile.fieldname}, originalname=${imageFile.originalname}, mimetype=${imageFile.mimetype}`,
        });
      }

      const existingItem = await LogoImageModel.findById(id);

      if (!existingItem) {
        deleteFileIfExists(uploadedFilePath);

        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const updateData = {};

      if (name) {
        updateData.name = name;
      }

      if (service_type) {
        updateData.service_type = service_type;
      }

      let compression = null;

      if (imageFile) {
        if (!existingItem.image_url) {
          deleteFileIfExists(uploadedFilePath);

          return res.status(400).json({
            success: false,
            message: "Existing image URL not found. Cannot replace image.",
          });
        }

        const oldImagePath = imageUrlToFilePath(existingItem.image_url);

        try {
          const oldImageDir = path.dirname(oldImagePath);

          if (!fs.existsSync(oldImageDir)) {
            fs.mkdirSync(oldImageDir, { recursive: true });
          }

          compression = await compressLogoImageOrFail(imageFile);

          /**
           * Replace old physical file with compressed new file.
           * Keep same image_url in DB.
           */
          fs.copyFileSync(uploadedFilePath, oldImagePath);

          deleteFileIfExists(uploadedFilePath);
          uploadedFilePath = null;

          console.log(
            "✅ Replaced image but kept same URL:",
            existingItem.image_url,
          );
        } catch (fileError) {
          deleteFileIfExists(uploadedFilePath);

          console.error("Error replacing old image:", fileError);

          return res.status(500).json({
            success: false,
            message: "Failed to replace image file",
            error: fileError.message,
          });
        }
      }

      if (!updateData.name && !updateData.service_type && !imageFile) {
        return res.status(400).json({
          success: false,
          message: "Nothing to update",
        });
      }

      const result = await LogoImageModel.update(
        id,
        updateData,
        actor.user_id,
        actor.admin_name,
      );

      if (result.notFound) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      if (result.validation || result.duplicate) {
        return res.status(result.duplicate ? 409 : 400).json({
          success: false,
          message: result.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Logo/Image updated successfully",
        actor_logged: {
          user_id: actor.user_id,
          admin_name: actor.admin_name,
        },
        compression,
        data: {
          ...result.data,
          image_url: existingItem.image_url,
        },
      });
    } catch (error) {
      deleteFileIfExists(uploadedFilePath);

      console.error("Error updating logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  /**
   * DELETE /api/logo-images/:id
   */
  async delete(req, res) {
    try {
      const { id } = req.params;
      const actor = getActor(req);

      console.log("[LOGO DELETE DEBUG]", {
        id,
        jwt_user: req.user || null,
        actor,
      });

      const existingItem = await LogoImageModel.findById(id);

      if (!existingItem) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const result = await LogoImageModel.delete(
        id,
        actor.user_id,
        actor.admin_name,
      );

      if (result.notFound) {
        return res.status(404).json({
          success: false,
          message: "Logo/Image not found",
        });
      }

      const imagePath = imageUrlToFilePath(existingItem.image_url);
      deleteFileIfExists(imagePath);

      return res.status(200).json({
        success: true,
        message: "Logo/Image deleted successfully",
        actor_logged: {
          user_id: actor.user_id,
          admin_name: actor.admin_name,
        },
      });
    } catch (error) {
      console.error("Error deleting logo/image:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },

  /**
   * POST /api/logo-images/bulk-delete
   */
  async bulkDelete(req, res) {
    try {
      const body = req.body || {};
      const { ids } = body;
      const actor = getActor(req);

      console.log("[LOGO BULK DELETE DEBUG]", {
        body,
        jwt_user: req.user || null,
        actor,
      });

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Valid IDs array is required",
        });
      }

      const result = await LogoImageModel.bulkDelete(
        ids,
        actor.user_id,
        actor.admin_name,
      );

      if (result.items && result.items.length > 0) {
        result.items.forEach((item) => {
          const imagePath = imageUrlToFilePath(item.image_url);
          deleteFileIfExists(imagePath);
        });
      }

      return res.status(200).json({
        success: true,
        message: `${result.count} item(s) deleted successfully`,
        deletedCount: result.count,
        actor_logged: {
          user_id: actor.user_id,
          admin_name: actor.admin_name,
        },
      });
    } catch (error) {
      console.error("Error bulk deleting logos/images:", error);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error.message,
      });
    }
  },
};

module.exports = LogoImageController;