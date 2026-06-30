const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  createFoodMenuItem,
  getFoodMenuItemById,
  listFoodMenuItems,
  listFoodMenuByBusiness,
  updateFoodMenuItem,
  deleteFoodMenuItem,
} = require("../models/foodMenuModel");

const { toWebPath, DEST } = require("../middlewares/uploadFoodMenuImage");

// ------------ file helpers ------------
const isUploadsPath = (p) =>
  typeof p === "string" && /^\/?uploads\//i.test(String(p).replace(/^\/+/, ""));
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
  return `/uploads/food-menu/${fileName}`;
}

/**
 * Accept ONLY:
 *  1) req.file uploaded by multer -> /uploads/food-menu/<name>
 *  2) body with already-server-stored path starting with /uploads/food-menu/
 *  3) base64 data URL in body (data:image/...;base64,...) -> will be saved and return path
 * Everything else (file:///..., http://device/..., etc.) => ignored (null)
 */
function extractStorableImagePath(req) {
  if (req.file) return toWebPath(req.file);

  // Accept already server-stored path
  const raw = (req.body?.item_image || req.body?.image || "").toString().trim();
  if (raw.startsWith("/uploads/food-menu/")) return raw;

  // Accept base64 data URL
  const saved = saveBase64ImageIfPresent(req.body);
  if (saved) return saved;

  // Reject device-local URIs like file:///...
  return null;
}

// ------------- CREATE -------------
async function createFoodMenuCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = extractStorableImagePath(req);

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

    const out = await createFoodMenuItem(payload);

    // Check if the operation was successful
    if (!out.success) {
      return res.status(400).json({
        success: false,
        message: out.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Food item created successfully.",
      data: out.data,
    });
  } catch (e) {
    console.error("Create food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to create food item. Please try again.",
    });
  }
}

// ------------- LIST (filters) -------------
async function listFoodMenuCtrl(req, res) {
  try {
    const business_id = req.query.business_id;
    const category_name = req.query.category_name;
    const out = await listFoodMenuItems({ business_id, category_name });

    if (!out.success) {
      return res.status(400).json({
        success: false,
        message: out.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Food items fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    console.error("List food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to fetch food items.",
    });
  }
}

// ------------- BY BUSINESS -------------
async function listFoodMenuByBusinessCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const out = await listFoodMenuByBusiness(business_id);

    if (!out.success) {
      return res.status(400).json({
        success: false,
        message: out.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Food items for business fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    console.error("List business food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to fetch food items.",
    });
  }
}

// ------------- GET ONE -------------
async function getFoodMenuByIdCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await getFoodMenuItemById(id);

    if (!out.success) {
      return res.status(404).json({
        success: false,
        message: out.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Food item fetched successfully.",
      data: out.data,
    });
  } catch (e) {
    console.error("Get food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to fetch food item.",
    });
  }
}

// ------------- UPDATE -------------
async function updateFoodMenuCtrl(req, res) {
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

    const out = await updateFoodMenuItem(id, fields);

    if (!out.success) {
      return res.status(400).json({
        success: false,
        message: out.message,
      });
    }

    // If image changed (or cleared), remove old file
    if (out.old_image && out.new_image && out.old_image !== out.new_image) {
      safeDeleteFile(out.old_image);
    }
    if (fields.item_image === null && out.old_image) {
      safeDeleteFile(out.old_image);
    }

    return res.status(200).json({
      success: true,
      message: "Food item updated successfully.",
      data: out.data,
    });
  } catch (e) {
    console.error("Update food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to update food item.",
    });
  }
}

// ------------- DELETE -------------
async function deleteFoodMenuCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const out = await deleteFoodMenuItem(id);

    if (!out.success) {
      return res.status(404).json({
        success: false,
        message: out.message,
      });
    }

    if (out.deleted_item?.item_image) {
      safeDeleteFile(out.deleted_item.item_image);
    }

    return res.status(200).json({
      success: true,
      message: "Food item deleted successfully.",
    });
  } catch (e) {
    console.error("Delete food menu error:", e);
    return res.status(500).json({
      success: false,
      message: e.message || "Failed to delete food item.",
    });
  }
}

module.exports = {
  createFoodMenuCtrl,
  listFoodMenuCtrl,
  listFoodMenuByBusinessCtrl,
  getFoodMenuByIdCtrl,
  updateFoodMenuCtrl,
  deleteFoodMenuCtrl,
};
