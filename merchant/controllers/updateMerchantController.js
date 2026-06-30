const fs = require("fs");
const path = require("path");
const {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
  clearSpecialCelebrationByBusinessId,
} = require("../models/updateMerchantModel");

/* ---------------- helpers ---------------- */
function safeUnlink(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch (e) {
    console.error("Failed to delete file:", absPath, e?.message || e);
  }
}

function absFromStored(storedPath) {
  if (!storedPath) return null;

  const cleaned = String(storedPath).replace(/\\/g, "/");

  // supports "/uploads/..." style
  if (cleaned.startsWith("/uploads/")) {
    return path.join(process.cwd(), cleaned.replace("/uploads/", "uploads/"));
  }

  // supports "uploads/..." or absolute
  return path.isAbsolute(cleaned) ? cleaned : path.join(process.cwd(), cleaned);
}

function toStoredPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

/* ---------------- controllers ---------------- */

// PUT /merchant-business/:business_id  (multipart: business_logo, license_image)
async function updateMerchantBusiness(req, res) {
  const business_id = Number(req.params.business_id);
  const updateFields = { ...req.body };

  try {
    const currentBusiness = await getMerchantBusinessDetailsById(business_id);
    if (!currentBusiness) {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }

    // upload.fields() => req.files[fieldname][0]
    const newBusinessLogo = req.files?.business_logo?.[0];
    const newLicenseImage = req.files?.license_image?.[0];

    if (newBusinessLogo) {
      safeUnlink(absFromStored(currentBusiness.business_logo));
      updateFields.business_logo = toStoredPath(newBusinessLogo.path);
    }

    if (newLicenseImage) {
      safeUnlink(absFromStored(currentBusiness.license_image));
      updateFields.license_image = toStoredPath(newLicenseImage.path);
    }

    // Normalize min_amount_for_fd (allow null / empty, keep numeric string)
    if (updateFields.min_amount_for_fd !== undefined) {
      const raw = String(updateFields.min_amount_for_fd ?? "").trim();
      updateFields.min_amount_for_fd = raw === "" ? null : raw;
    }

    // Special celebration validation
    if (updateFields.special_celebration !== undefined) {
      updateFields.special_celebration = updateFields.special_celebration || null;

      if (
        updateFields.special_celebration &&
        updateFields.special_celebration_discount_percentage === undefined
      ) {
        return res.status(400).json({
          success: false,
          message:
            "special_celebration_discount_percentage is required when special_celebration is provided.",
        });
      }
    }

    const updated = await updateMerchantBusinessDetails(
      business_id,
      updateFields
    );

    if (!updated) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided to update.",
      });
    }

    const latest = await getMerchantBusinessDetailsById(business_id);

    return res.status(200).json({
      success: true,
      message: "Merchant business details updated successfully.",
      data: latest,
    });
  } catch (err) {
    console.error("[updateMerchantBusiness] error:", err);
    
    // Handle Prisma specific errors
    if (err.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }
    
    return res.status(500).json({
      success: false,
      message: err.message || "Update failed.",
    });
  }
}

// GET /merchant-business/:business_id
async function getMerchantBusiness(req, res) {
  const business_id = Number(req.params.business_id);

  try {
    const business = await getMerchantBusinessDetailsById(business_id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: business,
    });
  } catch (err) {
    console.error("[getMerchantBusiness] error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch business details.",
    });
  }
}

// DELETE /merchant-business/:business_id/special-celebration
async function removeSpecialCelebration(req, res) {
  const business_id = Number(req.params.business_id);

  try {
    const business = await getMerchantBusinessDetailsById(business_id);
    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }

    // idempotent
    if (
      business.special_celebration == null &&
      business.special_celebration_discount_percentage == null
    ) {
      return res.status(200).json({
        success: true,
        message: "Special celebration already removed.",
      });
    }

    await clearSpecialCelebrationByBusinessId(business_id);

    const latest = await getMerchantBusinessDetailsById(business_id);

    return res.status(200).json({
      success: true,
      message: "Special celebration removed successfully.",
      data: latest,
    });
  } catch (err) {
    console.error("[removeSpecialCelebration] error:", err);
    
    if (err.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "Merchant business not found.",
      });
    }
    
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to remove special celebration.",
    });
  }
}

module.exports = {
  updateMerchantBusiness,
  getMerchantBusiness,
  removeSpecialCelebration,
};