const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { prisma } = require("../lib/prisma");
const cache = require("../services/cacheService");

const {
  createBannerWithWalletCharge,
  getBannerById,
  listBanners,
  listAllBannersForBusiness,
  listActiveByKind,
  updateBanner,
  deleteBanner,
  getBannerBasePrice,
} = require("../models/bannerModel");

const {
  uploadBannerImage,
  toWebPath,
  DEST,
} = require("../middlewares/uploadBannerImage");

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

function saveBase64ImageIfPresent(body) {
  const raw = (body?.banner_image || body?.image || "").toString().trim();
  const m = raw.match(
    /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/i
  );
  if (!m) return null;
  const ext = m[1].toLowerCase().replace("jpeg", "jpg").replace("+xml", "");
  const data = m[2];
  const buf = Buffer.from(data, "base64");
  const base =
    (body?.title || "banner")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "banner";
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${base}.${ext}`;
  const abs = path.join(DEST, fileName);
  fs.writeFileSync(abs, buf);
  return `/uploads/banners/${fileName}`;
}

function extractStorableImagePath(req) {
  if (req.file) return toWebPath(req.file);
  const raw = (req.body?.banner_image || req.body?.image || "")
    .toString()
    .trim();
  if (raw.startsWith("/uploads/banners/")) return raw;
  const saved = saveBase64ImageIfPresent(req.body);
  if (saved) return saved;
  return null;
}

// Helper to generate cache key
function getCacheKey(...parts) {
  return parts.map(p => String(p).toLowerCase().replace(/[^a-z0-9_-]/g, '_')).join(':');
}

// Helper to invalidate banner caches when data changes
async function invalidateBannerCaches(business_id = null) {
  // Clear all banner list caches
  await cache.clearPattern("banners:list:*");
  await cache.clearPattern("banners:food:*");
  await cache.clearPattern("banners:mart:*");
  await cache.clearPattern("banners:base_price:*");
  
  // Clear business-specific caches
  if (business_id) {
    await cache.clearPattern(`banners:business:${business_id}:*`);
  }
  
  console.log(`🗑️ Banner caches invalidated${business_id ? ` for business ${business_id}` : ''}`);
}

// POST /api/banners
async function createBannerCtrl(req, res) {
  try {
    const b = req.body || {};
    const img = extractStorableImagePath(req);

    const user_id = Number(b.user_id);
    const total_amount = Number(b.total_amount);

    if (!Number.isInteger(user_id) || user_id <= 0) {
      return res.status(400).json({
        success: false,
        message: "user_id must be a positive integer",
      });
    }
    if (!Number.isFinite(total_amount) || total_amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "total_amount must be a positive number",
      });
    }

    const payload = {
      business_id: b.business_id,
      title: b.title,
      description: b.description,
      banner_image: img,
      is_active: b.is_active,
      start_date: b.start_date,
      end_date: b.end_date,
      owner_type: b.owner_type,
    };

    const out = await createBannerWithWalletCharge({
      banner: payload,
      payer_user_id: user_id,
      amount: total_amount,
    });

    if (!out.success) return res.status(400).json(out);

    // Invalidate caches after successful creation
    await invalidateBannerCaches(b.business_id);

    // Format date and time for payment card
    const now = new Date();
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const day = String(now.getDate()).padStart(2, "0");
    const month = months[now.getMonth()];
    const year = now.getFullYear();
    const dateStr = `${day} ${month} ${year}`;

    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const timeStr = `${String(hours).padStart(2, "0")}:${minutes}:${seconds} ${ampm}`;

    const pay = out.payment;
    const purpose = `Banner Fee from Business #${out.data.business_id} (${out.data.owner_type})`;

    const payment = {
      Amount: `Nu. ${Number(pay.amount).toFixed(2)}`,
      "Jrnl No": pay.journal_code,
      "From Account": pay.debited_from_wallet,
      "To Account": pay.credited_to_wallet,
      Purpose: purpose,
      Date: dateStr,
      Time: timeStr,
    };

    return res.status(201).json({
      success: true,
      message: "Banner created and payment processed successfully.",
      data: out.data,
      payment,
    });
  } catch (error) {
    console.error("createBannerCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to create banner.",
    });
  }
}

// GET /api/banners (with caching)
async function listBannersCtrl(req, res) {
  try {
    const { business_id, active_only, owner_type } = req.query || {};
    
    // Generate cache key
    const cacheKey = getCacheKey('banners', 'list', business_id || 'all', active_only || 'all', owner_type || 'all');
    
    // Try to get from cache
    let data = await cache.get(cacheKey);
    
    if (!data) {
      const out = await listBanners({ business_id, active_only, owner_type });
      data = out.data;
      
      // Cache for 5 minutes
      await cache.set(cacheKey, data, 300);
      console.log(`💾 Cached banners list: ${cacheKey}`);
    } else {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
    }
    
    return res.status(200).json({
      success: true,
      message: "Banners fetched successfully.",
      data: data,
    });
  } catch (error) {
    console.error("listBannersCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to fetch banners.",
    });
  }
}

// GET /api/banners/business/:business_id (with caching)
async function listAllBannersByBusinessCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const { owner_type } = req.query || {};
    
    // Generate cache key
    const cacheKey = getCacheKey('banners', 'business', business_id, owner_type || 'all');
    
    // Try to get from cache
    let data = await cache.get(cacheKey);
    
    if (!data) {
      const out = await listAllBannersForBusiness(business_id, owner_type);
      data = out.data;
      
      // Cache for 5 minutes
      await cache.set(cacheKey, data, 300);
      console.log(`💾 Cached business banners: ${cacheKey}`);
    } else {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
    }
    
    return res.status(200).json({
      success: true,
      message: "All banners fetched successfully.",
      data: data,
    });
  } catch (error) {
    console.error("listAllBannersByBusinessCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to fetch banners.",
    });
  }
}

// GET /api/banners/food (with caching)
async function listActiveFoodCtrl(req, res) {
  try {
    const { business_id } = req.query || {};
    
    // Generate cache key
    const cacheKey = getCacheKey('banners', 'food', business_id || 'all');
    
    // Try to get from cache
    let data = await cache.get(cacheKey);
    
    if (!data) {
      const out = await listActiveByKind("food", business_id);
      data = out.data;
      
      // Cache for 5 minutes
      await cache.set(cacheKey, data, 300);
      console.log(`💾 Cached food banners: ${cacheKey}`);
    } else {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
    }
    
    return res.status(200).json({
      success: true,
      message: "Active food banners fetched successfully.",
      data: data,
    });
  } catch (error) {
    console.error("listActiveFoodCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to fetch food banners.",
    });
  }
}

// GET /api/banners/mart (with caching)
async function listActiveMartCtrl(req, res) {
  try {
    const { business_id } = req.query || {};
    
    // Generate cache key
    const cacheKey = getCacheKey('banners', 'mart', business_id || 'all');
    
    // Try to get from cache
    let data = await cache.get(cacheKey);
    
    if (!data) {
      const out = await listActiveByKind("mart", business_id);
      data = out.data;
      
      // Cache for 5 minutes
      await cache.set(cacheKey, data, 300);
      console.log(`💾 Cached mart banners: ${cacheKey}`);
    } else {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
    }
    
    return res.status(200).json({
      success: true,
      message: "Active mart banners fetched successfully.",
      data: data,
    });
  } catch (error) {
    console.error("listActiveMartCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to fetch mart banners.",
    });
  }
}

// GET /api/banners/:id (with caching)
async function getBannerCtrl(req, res) {
  try {
    const id = req.params.id;
    
    // Generate cache key
    const cacheKey = getCacheKey('banner', 'single', id);
    
    // Try to get from cache
    let data = await cache.get(cacheKey);
    
    if (!data) {
      const out = await getBannerById(id);
      if (!out.success) {
        return res.status(404).json(out);
      }
      data = out.data;
      
      // Cache for 10 minutes (individual banner)
      await cache.set(cacheKey, data, 600);
      console.log(`💾 Cached banner ${id}: ${cacheKey}`);
    } else {
      console.log(`⚡ Cache HIT: ${cacheKey}`);
    }
    
    return res.status(200).json({
      success: true,
      data: data,
    });
  } catch (error) {
    console.error("getBannerCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to fetch banner.",
    });
  }
}

// PUT /api/banners/:id
async function updateBannerCtrl(req, res) {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    const newImg = extractStorableImagePath(req);
    const wantsClear =
      b.banner_image === null ||
      b.banner_image === "null" ||
      b.banner_image === "";

    const fields = {
      ...(b.business_id !== undefined && { business_id: b.business_id }),
      ...(b.title !== undefined && { title: b.title }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.is_active !== undefined && { is_active: b.is_active }),
      ...(b.start_date !== undefined && { start_date: b.start_date }),
      ...(b.end_date !== undefined && { end_date: b.end_date }),
      ...(b.owner_type !== undefined && { owner_type: b.owner_type }),
    };
    if (newImg) fields.banner_image = newImg;
    else if (wantsClear) fields.banner_image = null;

    const payer_user_id = b.user_id !== undefined ? Number(b.user_id) : undefined;
    const total_amount = b.total_amount !== undefined ? Number(b.total_amount) : undefined;
    const auto_price = String(b.auto_price || "").toLowerCase() === "true" || b.auto_price === true;

    const out = await updateBanner(id, fields, {
      payer_user_id,
      total_amount,
      auto_price,
    });

    if (!out.success) return res.status(400).json(out);

    // Invalidate caches after update
    await invalidateBannerCaches(fields.business_id || out.data?.business_id);
    // Also clear single banner cache
    await cache.del(getCacheKey('banner', 'single', id));

    return res.status(200).json({
      success: true,
      message: out.message || "Banner updated successfully.",
      data: out.data,
      ...(out.payment ? { payment: out.payment } : {}),
      ...(out.pricing ? { pricing: out.pricing } : {}),
    });
  } catch (error) {
    console.error("updateBannerCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update banner.",
    });
  }
}

// DELETE /api/banners/:id
async function deleteBannerCtrl(req, res) {
  try {
    const id = req.params.id;
    
    // Get banner info before deletion for cache invalidation
    const banner = await getBannerById(id);
    
    const out = await deleteBanner(id);
    if (!out.success) return res.status(404).json(out);
    
    if (out.old_image) safeDeleteFile(out.old_image);
    
    // Invalidate caches after deletion
    if (banner.success && banner.data) {
      await invalidateBannerCaches(banner.data.business_id);
    }
    await cache.del(getCacheKey('banner', 'single', id));
    
    return res.status(200).json({
      success: true,
      message: "Banner deleted successfully.",
    });
  } catch (error) {
    console.error("deleteBannerCtrl error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to delete banner.",
    });
  }
}

// GET /api/banners/base-price (with caching)
async function getBannerBasePriceCtrl(req, res) {
  try {
    const cacheKey = getCacheKey('banners', 'base_price');
    
    // Try to get from cache
    let result = await cache.get(cacheKey);
    
    if (!result) {
      result = await getBannerBasePrice();
      
      if (!result.success) {
        return res.status(404).json({
          success: false,
          message: result.message,
        });
      }
      
      // Cache for 1 hour (base price changes rarely)
      await cache.set(cacheKey, result, 3600);
      console.log(`💾 Cached banner base price`);
    } else {
      console.log(`⚡ Cache HIT: banner base price`);
    }
    
    return res.status(200).json({
      success: true,
      amount_per_day: result.amount_per_day,
    });
  } catch (error) {
    console.error("getBannerBasePriceCtrl error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch banner base price.",
    });
  }
}

module.exports = {
  uploadBannerImage,
  createBannerCtrl,
  listBannersCtrl,
  listAllBannersByBusinessCtrl,
  listActiveFoodCtrl,
  listActiveMartCtrl,
  getBannerCtrl,
  updateBannerCtrl,
  deleteBannerCtrl,
  getBannerBasePriceCtrl,
};