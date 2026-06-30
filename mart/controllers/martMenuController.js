const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  createMartMenuItem,
  getMartMenuItemById,
  listMartMenuItems,
  listMartMenuByBusiness,
  updateMartMenuItem,
  deleteMartMenuItem,
  upsertMartProductInfo,
  getMartProductInfoByMenuId,
  deleteMartProductInfoByMenuId,
} = require("../models/martMenuModel");

const { toWebPath, DEST } = require("../middlewares/uploadMartMenuImage");

// ------------ file helpers ------------
const isUploadsPath = (p) =>
  typeof p === "string" &&
  /^\/?uploads\/mart-menu\//i.test(String(p).replace(/^\/+/, ""));
const toAbsPath = (webPath) =>
  path.join(process.cwd(), String(webPath).replace(/^\//, ""));

function safeDeleteFile(oldWebPath) {
  if (!oldWebPath) return;
  const normalized = String(oldWebPath).trim();
  if (!isUploadsPath(normalized)) return;
  const abs = toAbsPath(normalized);
  const uploadsRoot = path.join(process.cwd(), "uploads");
  const absNorm = path.normalize(abs);
  const rootNorm = path.normalize(uploadsRoot);
  if (!absNorm.startsWith(rootNorm)) return;
  fs.stat(absNorm, (err, st) => {
    if (err || !st?.isFile()) return;
    fs.unlink(absNorm, () => {});
  });
}

// Save base64 data URL to uploads and return web path
function saveBase64ImageIfPresent(body) {
  const raw = (body?.item_image || body?.image || "").toString().trim();
  const m = raw.match(
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i,
  );
  if (!m) return null;

  const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const data = m[2];
  const buf = Buffer.from(data, "base64");

  const base =
    (body?.item_name || "item")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "item";

  const fileName = `${Date.now()}-${crypto.randomUUID()}-${base}.${ext}`;
  const abs = path.join(DEST, fileName);
  fs.writeFileSync(abs, buf);
  return `/uploads/mart-menu/${fileName}`;
}

function extractStorableImagePath(req) {
  if (req.file) return toWebPath(req.file);

  const raw = (req.body?.item_image || req.body?.image || "").toString().trim();
  if (raw.startsWith("/uploads/mart-menu/")) return raw;

  const saved = saveBase64ImageIfPresent(req.body);
  if (saved) return saved;

  return null;
}

// Add this new function to extract multiple image paths
function extractStorableMultipleImagePaths(req) {
  if (!req.additionalFiles || req.additionalFiles.length === 0) return [];

  return req.additionalFiles.map((file) => toWebPath(file)).filter(Boolean);
}

// Update processProductImages function
function processProductImages(req, mainImagePath) {
  const allImages = [];

  // Add main image first if exists
  if (mainImagePath) {
    allImages.push(mainImagePath);
  }

  // Get additional images from uploaded files
  const additionalFilePaths = extractStorableMultipleImagePaths(req);
  allImages.push(...additionalFilePaths);

  // Also check for product_images from form data (URLs)
  const productImagesUrls = req.body.product_images || "";
  if (productImagesUrls && typeof productImagesUrls === "string") {
    const extraImages = productImagesUrls
      .split(",")
      .map((img) => img.trim())
      .filter((img) => img);
    allImages.push(...extraImages);
  }

  return allImages.length > 0 ? allImages.join(",") : null;
}

// ------------- CREATE -------------
async function createMartMenuCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = extractStorableImagePath(req);

    // Process all images (main + additional)
    const allImages = processProductImages(req, img);

    const payload = {
      business_id: b.business_id,
      category_name: b.category_name,
      item_name: b.item_name,
      description: b.description,
      item_image: img,
      actual_price: b.actual_price,
      discount_percentage: b.discount_percentage,
      tax_rate: b.tax_rate,
      is_veg: b.is_veg,
      spice_level: b.spice_level,
      is_available: b.is_available,
      stock_limit: b.stock_limit,
      sort_order: b.sort_order,
    };

    const result = await createMartMenuItem(payload);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    // Handle clothing/footwear specific fields
    const menuId = result.data.id;
    const sizeStandard = b.size_standard || null;
    const availableSizes = b.available_sizes || null;

    if (sizeStandard || availableSizes || allImages) {
      await upsertMartProductInfo({
        menu_id: menuId,
        size_standard: sizeStandard,
        available_sizes: availableSizes,
        product_images: allImages,
      });

      const updatedResult = await getMartMenuItemById(menuId);
      return res.status(201).json({
        success: true,
        message: "Mart item created successfully with size options.",
        data: updatedResult.data,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Mart item created successfully.",
      data: result.data,
    });
  } catch (error) {
    console.error("Create mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create mart item. Please try again.",
    });
  }
}

// ------------- LIST (filters) -------------
async function listMartMenuCtrl(req, res) {
  try {
    const business_id = req.query.business_id;
    const category_name = req.query.category_name;
    const result = await listMartMenuItems({ business_id, category_name });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Mart items fetched successfully.",
      data: result.data,
    });
  } catch (error) {
    console.error("List mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch mart items.",
    });
  }
}

// ------------- BY BUSINESS -------------
async function listMartMenuByBusinessCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const result = await listMartMenuByBusiness(business_id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Mart items for business fetched successfully.",
      data: result.data,
    });
  } catch (error) {
    console.error("List business mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch mart items.",
    });
  }
}

// ------------- GET ONE -------------
async function getMartMenuByIdCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const result = await getMartMenuItemById(id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Mart item fetched successfully.",
      data: result.data,
    });
  } catch (error) {
    console.error("Get mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch mart item.",
    });
  }
}

// ------------- UPDATE -------------
async function updateMartMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    const newImg = extractStorableImagePath(req);
    const wantsClear =
      b.item_image === null || b.item_image === "null" || b.item_image === "";

    const fields = {
      ...(b.business_id !== undefined && { business_id: b.business_id }),
      ...(b.category_name !== undefined && { category_name: b.category_name }),
      ...(b.item_name !== undefined && { item_name: b.item_name }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.actual_price !== undefined && { actual_price: b.actual_price }),
      ...(b.discount_percentage !== undefined && {
        discount_percentage: b.discount_percentage,
      }),
      ...(b.tax_rate !== undefined && { tax_rate: b.tax_rate }),
      ...(b.is_veg !== undefined && { is_veg: b.is_veg }),
      ...(b.spice_level !== undefined && { spice_level: b.spice_level }),
      ...(b.is_available !== undefined && { is_available: b.is_available }),
      ...(b.stock_limit !== undefined && { stock_limit: b.stock_limit }),
      ...(b.sort_order !== undefined && { sort_order: b.sort_order }),
    };

    if (newImg) fields.item_image = newImg;
    else if (wantsClear) fields.item_image = null;

    const result = await updateMartMenuItem(id, fields);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    // Update product info for clothing/footwear
    const finalImage = newImg || result.data.item_image;
    const allImages = processProductImages(req, finalImage);

    // Get existing product info
    const existingInfo = await getMartProductInfoByMenuId(id);

    // Check if any clothing/footwear fields are being updated
    const hasSizeFields =
      b.size_standard !== undefined || b.available_sizes !== undefined;
    const hasImageUpdate = allImages !== null;

    if (hasSizeFields || hasImageUpdate || existingInfo) {
      let sizeStandard = existingInfo?.size_standard || null;
      let availableSizes = existingInfo?.available_sizes || null;
      let productImages = existingInfo?.product_images || null;

      if (b.size_standard !== undefined) sizeStandard = b.size_standard || null;
      if (b.available_sizes !== undefined)
        availableSizes = b.available_sizes || null;
      if (allImages !== null) productImages = allImages;
      else if (hasImageUpdate && !allImages && finalImage) {
        // If only main image updated but no additional images
        productImages = finalImage;
      }

      await upsertMartProductInfo({
        menu_id: id,
        size_standard: sizeStandard,
        available_sizes: availableSizes,
        product_images: productImages,
      });
    }

    // If image changed (or cleared), remove old file
    if (
      result.old_image &&
      result.new_image &&
      result.old_image !== result.new_image
    ) {
      safeDeleteFile(result.old_image);
    }
    if (fields.item_image === null && result.old_image) {
      safeDeleteFile(result.old_image);
    }

    const updatedResult = await getMartMenuItemById(id);

    return res.status(200).json({
      success: true,
      message: "Mart item updated successfully.",
      data: updatedResult.data,
    });
  } catch (error) {
    console.error("Update mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update mart item.",
    });
  }
}

// ------------- DELETE -------------
async function deleteMartMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);

    // Get product info before deleting
    const productInfo = await getMartProductInfoByMenuId(id);

    const result = await deleteMartMenuItem(id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message,
      });
    }

    // Delete associated product info if exists
    if (productInfo) {
      await deleteMartProductInfoByMenuId(id);
    }

    if (result.old_image) safeDeleteFile(result.old_image);

    return res.status(200).json({
      success: true,
      message: "Mart item deleted successfully.",
    });
  } catch (error) {
    console.error("Delete mart menu error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete mart item.",
    });
  }
}

module.exports = {
  createMartMenuCtrl,
  listMartMenuCtrl,
  listMartMenuByBusinessCtrl,
  getMartMenuByIdCtrl,
  updateMartMenuCtrl,
  deleteMartMenuCtrl,
};
