const fs = require("fs");
const path = require("path");
const {
  addCategory,
  getAllCategories,
  getCategoriesByBusinessType,
  getCategoryById,
  updateCategory,
  deleteCategory,
  getCategoriesForBusiness,
} = require("../models/categoryModel");

const { toWebPathFromFile } = require("../middlewares/categoryImage");

const isUploadsPath = (p) =>
  typeof p === "string" && /^\/?uploads\//i.test(p.replace(/^\/+/, ""));
const toAbsPath = (webPath) =>
  path.join(process.cwd(), webPath.replace(/^\//, ""));

function safeDeleteFile(oldWebPath) {
  if (!oldWebPath) return;
  const normalized = String(oldWebPath).trim();
  if (!isUploadsPath(normalized)) return;
  const abs = toAbsPath(normalized);
  const uploadsRoot = path.join(process.cwd(), "uploads");
  if (!abs.startsWith(uploadsRoot)) return;
  fs.stat(abs, (err, st) => {
    if (err || !st?.isFile()) return;
    fs.unlink(abs, () => {});
  });
}

// Helper to serialize BigInt
function serializeBigInt(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === "bigint") return Number(data);
  if (Array.isArray(data)) return data.map(serializeBigInt);
  if (typeof data === "object") {
    const serialized = {};
    for (const key in data) {
      serialized[key] = serializeBigInt(data[key]);
    }
    return serialized;
  }
  return data;
}

/* ---------- CREATE ---------- */
async function createCategoryCtrl(req, res) {
  try {
    const kind = req.params.kind;
    const body = req.body || {};
    const fileWebPath = toWebPathFromFile(req, req.file);

    const payload = {
      category_name: body.category_name,
      business_type: body.business_type,
      description: body.description || null,
      category_image: fileWebPath || body.category_image || null,
    };

    const out = await addCategory(kind, payload, body.user_id, body.admin_name);

    if (!out.success) {
      return res.status(400).json({ error: out.message });
    }

    return res.status(201).json({
      success: true,
      message: out.message,
      data: out.data,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || "Create failed" });
  }
}

/* ---------- GET ALL (by kind) ---------- */
async function listCategoriesCtrl(req, res) {
  try {
    const kind = req.params.kind;
    const rows = await getAllCategories(kind);
    const serializedData = serializeBigInt(rows.data);
    return res.status(200).json(serializedData);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Fetch failed" });
  }
}

/* ---------- GET by business_type NAME within kind ---------- */
async function listByBusinessTypeCtrl(req, res) {
  try {
    const kind = req.params.kind;
    const name = req.query.business_type;
    const rows = await getCategoriesByBusinessType(kind, name);
    const serializedData = serializeBigInt(rows.data);
    return res.status(200).json(serializedData);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Fetch failed" });
  }
}

/* ---------- UPDATE ---------- */
async function updateCategoryCtrl(req, res) {
  try {
    const kind = req.params.kind;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const body = req.body || {};
    const fileWebPath = toWebPathFromFile(req, req.file);

    const fields = {};
    if (body.category_name !== undefined)
      fields.category_name = body.category_name;
    if (body.business_type !== undefined)
      fields.business_type = body.business_type;
    if (body.description !== undefined) fields.description = body.description;
    if (fileWebPath) fields.category_image = fileWebPath;
    else if (body.category_image !== undefined)
      fields.category_image = body.category_image || null;

    const out = await updateCategory(
      kind,
      id,
      fields,
      body.user_id,
      body.admin_name,
    );

    if (!out.success) {
      return res.status(400).json({ error: out.message });
    }

    if (out.old_image && out.new_image && out.old_image !== out.new_image) {
      safeDeleteFile(out.old_image);
    }
    if (fields.category_image === null && out.old_image) {
      safeDeleteFile(out.old_image);
    }

    return res.status(200).json({
      success: true,
      message: out.message,
      data: out.data,
    });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : 400;
    return res.status(code).json({ error: e.message || "Update failed" });
  }
}

/* ---------- DELETE ---------- */
async function deleteCategoryCtrl(req, res) {
  try {
    const kind = req.params.kind;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const { user_id, admin_name } = req.body || {};
    const out = await deleteCategory(kind, id, user_id, admin_name);

    if (!out.success) {
      return res.status(404).json({ error: out.message });
    }

    if (out.success && out.old_image) safeDeleteFile(out.old_image);

    return res.status(200).json({
      success: true,
      message: out.message,
    });
  } catch (e) {
    const code = /not found/i.test(e.message) ? 404 : 400;
    return res.status(code).json({ error: e.message || "Delete failed" });
  }
}

/* ---------- GET categories for a business ---------- */
async function getCategoriesForBusinessCtrl(req, res) {
  try {
    const businessId = Number(req.params.businessId);
    if (!Number.isInteger(businessId) || businessId <= 0) {
      return res.status(400).json({ error: "Invalid businessId" });
    }
    const data = await getCategoriesForBusiness(businessId);
    const serializedData = serializeBigInt(data);
    return res.status(200).json(serializedData);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Fetch failed" });
  }
}

module.exports = {
  createCategoryCtrl,
  listCategoriesCtrl,
  listByBusinessTypeCtrl,
  updateCategoryCtrl,
  deleteCategoryCtrl,
  getCategoriesForBusinessCtrl,
};
