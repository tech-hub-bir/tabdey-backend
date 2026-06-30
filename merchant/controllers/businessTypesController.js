const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const {
  getAllBusinessTypes,
  getBusinessTypeById,
  getBusinessTypesByType,
  addBusinessType,
  updateBusinessType,
  deleteBusinessType,
} = require("../models/businessTypesModel");

const { toWebPath } = require("../middlewares/businessTypesImage");

// Helper function to convert BigInt to Number
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

/* -------------------- helpers -------------------- */

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function actor(req) {
  return {
    user_id:
      toIntOrNull(req.user?.user_id) ??
      toIntOrNull(req.headers["x-admin-id"]) ??
      toIntOrNull(req.body?.user_id) ??
      null,
    admin_name:
      req.user?.admin_name ??
      req.headers["x-admin-name"] ??
      req.body?.admin_name ??
      null,
  };
}

function extractIncomingImage(req) {
  if (req.file) return toWebPath(req.file);
  const raw = (req.body?.image || "").toString().trim();
  if (!raw) return null;
  if (raw.startsWith("/uploads/")) return raw;
  if (raw.startsWith("uploads/")) return `/${raw}`;
  try {
    const u = new URL(raw);
    return u.pathname || raw;
  } catch {
    return raw;
  }
}

function isLocalUploadsPath(p) {
  return p && p.startsWith("/uploads/");
}

function toAbsoluteUploadsPath(webPath) {
  return path.join(process.cwd(), webPath.replace(/^\/+/, ""));
}

async function safeUnlink(absPath) {
  try {
    await fsp.unlink(absPath);
    return true;
  } catch {
    return false;
  }
}

/* -------------------- routes -------------------- */

exports.listBusinessTypes = async (_req, res) => {
  try {
    const out = await getAllBusinessTypes();
    // Serialize BigInt values before sending response
    const serializedData = serializeBigInt(out.data);
    res.status(out.success ? 200 : 404).json({
      success: out.success,
      data: serializedData,
    });
  } catch (e) {
    console.error("listBusinessTypes error:", e);
    res
      .status(500)
      .json({ success: false, message: "Unable to fetch business types." });
  }
};

exports.getBusinessType = async (req, res) => {
  try {
    const out = await getBusinessTypeById(req.params.id);
    if (out.success && out.data) {
      const serializedData = serializeBigInt(out.data);
      res.status(200).json({
        success: true,
        data: serializedData,
      });
    } else {
      res.status(404).json(out);
    }
  } catch (e) {
    console.error("getBusinessType error:", e);
    res
      .status(500)
      .json({ success: false, message: "Unable to fetch business type." });
  }
};

exports.listFoodBusinessTypes = async (_req, res) => {
  try {
    const out = await getBusinessTypesByType("food");
    const serializedData = serializeBigInt(out.data);
    res.status(out.success ? 200 : 404).json({
      success: out.success,
      data: serializedData,
    });
  } catch (e) {
    console.error("listFoodBusinessTypes error:", e);
    res.status(500).json({
      success: false,
      message: "Unable to fetch food business types.",
    });
  }
};

exports.listMartBusinessTypes = async (_req, res) => {
  try {
    const out = await getBusinessTypesByType("mart");
    const serializedData = serializeBigInt(out.data);
    res.status(out.success ? 200 : 404).json({
      success: out.success,
      data: serializedData,
    });
  } catch (e) {
    console.error("listMartBusinessTypes error:", e);
    res.status(500).json({
      success: false,
      message: "Unable to fetch mart business types.",
    });
  }
};

exports.createBusinessType = async (req, res) => {
  const { user_id, admin_name } = actor(req);
  const { name, description, types } = req.body || {};
  const newImage = extractIncomingImage(req);

  try {
    const out = await addBusinessType(
      name,
      description,
      types,
      newImage,
      user_id,
      admin_name,
    );
    res.status(out.success ? 201 : 400).json(out);
  } catch (e) {
    if (req.file && isLocalUploadsPath(newImage)) {
      await safeUnlink(toAbsoluteUploadsPath(newImage));
    }
    console.error("createBusinessType error:", e);
    res
      .status(500)
      .json({ success: false, message: "Unable to add business type." });
  }
};

exports.updateBusinessType = async (req, res) => {
  const { user_id, admin_name } = actor(req);
  const { name, description, types } = req.body || {};
  const incomingImage = extractIncomingImage(req);

  let current;
  try {
    const out = await getBusinessTypeById(req.params.id);
    if (!out.success) {
      if (req.file && isLocalUploadsPath(incomingImage)) {
        await safeUnlink(toAbsoluteUploadsPath(incomingImage));
      }
      return res.status(404).json(out);
    }
    current = out.data;
  } catch (e) {
    if (req.file && isLocalUploadsPath(incomingImage)) {
      await safeUnlink(toAbsoluteUploadsPath(incomingImage));
    }
    console.error("updateBusinessType fetch error:", e);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch current business type.",
    });
  }

  const imageToStore = incomingImage ?? current.image ?? null;

  try {
    const out = await updateBusinessType(
      req.params.id,
      name,
      description,
      types,
      imageToStore,
      user_id,
      admin_name,
    );

    if (!out.success) {
      if (req.file && isLocalUploadsPath(incomingImage)) {
        await safeUnlink(toAbsoluteUploadsPath(incomingImage));
      }
      return res.status(404).json(out);
    }

    if (
      incomingImage &&
      incomingImage !== current.image &&
      isLocalUploadsPath(current.image)
    ) {
      await safeUnlink(toAbsoluteUploadsPath(current.image));
    }

    res.status(200).json(out);
  } catch (e) {
    if (req.file && isLocalUploadsPath(incomingImage)) {
      await safeUnlink(toAbsoluteUploadsPath(incomingImage));
    }
    console.error("updateBusinessType error:", e);
    res
      .status(500)
      .json({ success: false, message: "Unable to update business type." });
  }
};

exports.removeBusinessType = async (req, res) => {
  const { user_id, admin_name } = actor(req);
  let current = null;

  try {
    const out = await getBusinessTypeById(req.params.id);
    if (out.success) current = out.data;
  } catch (_) {}

  try {
    const out = await deleteBusinessType(req.params.id, user_id, admin_name);
    if (!out.success) return res.status(404).json(out);

    if (current?.image && isLocalUploadsPath(current.image)) {
      await safeUnlink(toAbsoluteUploadsPath(current.image));
    }

    res.status(200).json(out);
  } catch (e) {
    if (e.message && e.message.includes("in use by merchants")) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete: business type is in use by merchants.",
      });
    }
    console.error("removeBusinessType error:", e);
    res
      .status(500)
      .json({ success: false, message: "Unable to delete business type." });
  }
};
