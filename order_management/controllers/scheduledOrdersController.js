// controllers/scheduledOrdersController.js
// ✅ Prisma-safe scheduled order controller
// ✅ No raw db.query() in this controller
// ✅ Redis scheduled order model functions are kept unchanged
// ✅ Supports multipart payload + delivery photos
// ✅ Supports ACCEPTED / REJECTED scheduled order status flow

const { prisma } = require("../lib/prisma");
const { isAdminRole } = require("../middleware/authUser");

async function callerOwnsBusiness(req, businessId) {
  if (isAdminRole(req.user?.role)) return true;

  const business = await prisma.merchant_business_details.findFirst({
    where: {
      business_id: BigInt(businessId),
      user_id: Number(req.user?.user_id),
    },
    select: { business_id: true },
  });

  return !!business;
}

const {
  MAX_PHOTOS: UPLOAD_MAX_PHOTOS,
  toWebPaths,
} = require("../middleware/uploadDeliveryPhoto");

const {
  addScheduledOrder,
  getScheduledOrdersByUser,
  cancelScheduledOrderForUser,
  getScheduledOrdersByBusiness,
  parseScheduledToEpochMs,
  epochToBhutanIso,

  buildJobKey,
  PENDING_ZSET_KEY,
  ACCEPTED_ZSET_KEY,
  REJECTED_ZSET_KEY,
  ZSET_KEY,
} = require("../models/scheduledOrderModel");

const ALLOWED_SERVICE_TYPES = new Set(["FOOD", "MART"]);
const MAX_PHOTOS = Number(UPLOAD_MAX_PHOTOS || 6);
const REJECTED_VISIBLE_MS = 30 * 60 * 1000;

/* ============================================================
   Generic helpers
============================================================ */

function safeJsonParse(v) {
  if (v == null) return v;
  if (typeof v !== "string") return v;

  const s = v.trim();
  if (!s) return v;

  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      return JSON.parse(s);
    } catch {
      return v;
    }
  }

  return v;
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeBool(v) {
  if (typeof v === "boolean") return v;

  const s = String(v || "").trim().toLowerCase();

  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;

  return v;
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toBigIntId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

function getFilesFromRequest(req) {
  const files = [];

  // Main source from uploadDeliveryPhotos middleware
  if (Array.isArray(req.deliveryPhotos)) {
    files.push(...req.deliveryPhotos);
  }

  // Fallback source from multer.fields()
  if (req.files && typeof req.files === "object" && !Array.isArray(req.files)) {
    files.push(...(req.files.delivery_photo || []));
    files.push(...(req.files.delivery_photos || []));
    files.push(...(req.files["delivery_photo[]"] || []));
    files.push(...(req.files.image || []));
    files.push(...(req.files.images || []));
  }

  // Safety if another multer setup uses array
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  }

  // Remove duplicates by file path
  const seen = new Set();

  return files.filter((file) => {
    const key = file?.path || file?.filename;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeStatus(v) {
  return String(v || "").trim().toUpperCase();
}

/* ============================================================
   Prisma lookup helpers
============================================================ */

async function fetchMenuImages(serviceType, menuIds = []) {
  const ids = Array.from(
    new Set(
      (menuIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const imageMap = new Map();

  if (!ids.length) return imageMap;

  const type = String(serviceType || "").trim().toUpperCase();

  const modelName = type === "FOOD" ? "food_menu" : "mart_menu";
  const model = prisma[modelName];

  if (!model || typeof model.findMany !== "function") {
    console.error(`[scheduledOrders] Prisma model ${modelName} not found.`);
    return imageMap;
  }

  try {
    const rows = await model.findMany({
      where: {
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        item_image: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);
      imageMap.set(Number(r.id), r.item_image || null);
    }

    return imageMap;
  } catch (err) {
    /*
      Some introspected schemas use BigInt ids.
      Retry with BigInt ids if normal Number ids fail.
    */
    try {
      const rows = await model.findMany({
        where: {
          id: {
            in: ids.map((id) => BigInt(id)),
          },
        },
        select: {
          id: true,
          item_image: true,
        },
      });

      for (const raw of rows || []) {
        const r = serializeRow(raw);
        imageMap.set(Number(r.id), r.item_image || null);
      }
    } catch (e) {
      console.error(
        `[scheduledOrders] Failed to fetch ${modelName} item images:`,
        e?.message || e,
      );
    }

    return imageMap;
  }
}

async function fetchBusinessNameMap(businessIds = []) {
  const ids = Array.from(
    new Set(
      (businessIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await prisma.merchant_business_details.findMany({
      where: {
        business_id: {
          in: ids.map((id) => BigInt(id)),
        },
      },
      select: {
        business_id: true,
        business_name: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);
      map.set(Number(r.business_id), r.business_name || null);
    }
  } catch (err) {
    console.error(
      "[scheduledOrders] Failed to fetch business names:",
      err?.message || err,
    );
  }

  return map;
}

async function fetchBusinessDetailsMap(businessIds = []) {
  const ids = Array.from(
    new Set(
      (businessIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await prisma.merchant_business_details.findMany({
      where: {
        business_id: {
          in: ids.map((id) => BigInt(id)),
        },
      },
      select: {
        business_id: true,
        business_name: true,
        business_logo: true,
        address: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);

      map.set(Number(r.business_id), {
        business_id: Number(r.business_id),
        business_name: r.business_name || null,
        business_logo: r.business_logo || null,
        address: r.address || null,
      });
    }
  } catch (err) {
    console.error(
      "[scheduledOrders] Failed to fetch business details:",
      err?.message || err,
    );
  }

  return map;
}

async function fetchUserNameMap(userIds = []) {
  const ids = Array.from(
    new Set(
      (userIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  );

  const map = new Map();

  if (!ids.length) return map;

  try {
    const rows = await prisma.users.findMany({
      where: {
        user_id: {
          in: ids,
        },
      },
      select: {
        user_id: true,
        user_name: true,
      },
    });

    for (const raw of rows || []) {
      const r = serializeRow(raw);
      map.set(Number(r.user_id), r.user_name || null);
    }
  } catch (err) {
    console.error(
      "[scheduledOrders] Failed to fetch user names:",
      err?.message || err,
    );
  }

  return map;
}

/* ============================================================
   Enrichment helpers
============================================================ */

async function enrichItemsWithImages(orderPayload) {
  if (!Array.isArray(orderPayload.items) || !orderPayload.items.length) {
    return orderPayload;
  }

  const serviceType = String(orderPayload.service_type || "").trim().toUpperCase();

  const menuIds = orderPayload.items
    .map((item) => item.menu_id)
    .filter((id) => id != null && !Number.isNaN(Number(id)));

  if (!menuIds.length) return orderPayload;

  try {
    const imageMap = await fetchMenuImages(serviceType, menuIds);

    orderPayload.items = orderPayload.items.map((item) => ({
      ...item,
      item_image: imageMap.get(Number(item.menu_id)) || item.item_image || null,
    }));
  } catch (err) {
    console.error("[scheduleOrder] Failed to enrich item images:", err);
  }

  return orderPayload;
}

async function enrichItemsWithBusinessName(orderPayload) {
  if (!Array.isArray(orderPayload.items) || !orderPayload.items.length) {
    return orderPayload;
  }

  const globalBusinessId = orderPayload.business_id || null;
  const globalBusinessName = orderPayload.business_name || null;

  orderPayload.items = orderPayload.items.map((item) => ({
    ...item,
    business_id: item.business_id || item.businessId || globalBusinessId,
    business_name:
      item.business_name || item.businessName || globalBusinessName || null,
  }));

  const missingBusinessIds = [
    ...new Set(
      orderPayload.items
        .filter((item) => !item.business_name && item.business_id)
        .map((item) => Number(item.business_id))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];

  if (!missingBusinessIds.length) return orderPayload;

  try {
    const businessNameMap = await fetchBusinessNameMap(missingBusinessIds);

    orderPayload.items = orderPayload.items.map((item) => ({
      ...item,
      business_name:
        item.business_name ||
        businessNameMap.get(Number(item.business_id)) ||
        null,
    }));
  } catch (err) {
    console.error("[scheduleOrder] Failed to fetch business names:", err);
  }

  return orderPayload;
}

/* ============================================================
   Controllers
============================================================ */

exports.scheduleOrder = async (req, res) => {
  try {
    const body = req.body || {};

    console.log("[scheduleOrder] content-type:", req.headers["content-type"]);
    console.log("[scheduleOrder] req.body keys:", Object.keys(body || {}));
    console.log("[scheduleOrder] req.files keys:", Object.keys(req.files || {}));

    let mergedBody = { ...body };

    // Supports multipart FormData with payload as JSON string.
    if (typeof body.payload === "string") {
      const parsed = safeJsonParse(body.payload);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mergedBody = {
          ...mergedBody,
          ...parsed,
        };

        // Important: do not save escaped payload string into Redis.
        delete mergedBody.payload;

        if (Array.isArray(parsed.items)) {
          mergedBody.items = parsed.items.map((item) => ({
            ...item,
            business_name: item.business_name || item.businessName || null,
            business_id: item.business_id || item.businessId || null,
          }));
        }
      }
    }

    // The order is always scheduled for the authenticated caller —
    // a client-supplied user_id must never be trusted (IDOR).
    const userId = Number(req.user?.user_id);

    const scheduled_at =
      mergedBody.scheduled_at ?? mergedBody.scheduledAt ?? mergedBody.scheduled;

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid authenticated user.",
      });
    }

    if (!scheduled_at) {
      return res.status(400).json({
        success: false,
        message: "scheduled_at is required.",
      });
    }

    const epochMs = parseScheduledToEpochMs(scheduled_at);

    if (!Number.isFinite(epochMs)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid scheduled_at format. Use ISO with +06:00 or without timezone for Bhutan local.",
      });
    }

    if (epochMs <= Date.now()) {
      return res.status(400).json({
        success: false,
        message: "Scheduled time must be in the future.",
      });
    }

    const orderPayload = { ...mergedBody };

    delete orderPayload.payload;

    delete orderPayload.user_id;
    delete orderPayload.userId;
    delete orderPayload.userid;

    delete orderPayload.scheduled_at;
    delete orderPayload.scheduledAt;
    delete orderPayload.scheduled;

    orderPayload.items = safeJsonParse(orderPayload.items);
    orderPayload.totals = safeJsonParse(orderPayload.totals);
    orderPayload.delivery_address = safeJsonParse(orderPayload.delivery_address);
    orderPayload.special_photos = safeJsonParse(orderPayload.special_photos);

    if (orderPayload.priority != null) {
      orderPayload.priority = normalizeBool(orderPayload.priority);
    }

    if (orderPayload.delivery_lat != null) {
      orderPayload.delivery_lat = asNumber(orderPayload.delivery_lat);
    }

    if (orderPayload.delivery_lng != null) {
      orderPayload.delivery_lng = asNumber(orderPayload.delivery_lng);
    }

    if (orderPayload.business_id != null) {
      orderPayload.business_id = asNumber(orderPayload.business_id);
    }

    if (!Array.isArray(orderPayload.items) || !orderPayload.items.length) {
      return res.status(400).json({
        success: false,
        message: "Order items are required.",
      });
    }

    const serviceType = String(orderPayload.service_type || "").trim().toUpperCase();

    if (!serviceType || !ALLOWED_SERVICE_TYPES.has(serviceType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    orderPayload.service_type = serviceType;

    await enrichItemsWithImages(orderPayload);
    await enrichItemsWithBusinessName(orderPayload);

    const existingPhotos = [];

    const pushPhoto = (value) => {
      const s = value == null ? "" : String(value).trim();
      if (s) existingPhotos.push(s);
    };

    const deliveryPhotoUrls = safeJsonParse(orderPayload.delivery_photo_urls);
    const deliveryPhotoUrl = safeJsonParse(orderPayload.delivery_photo_url);
    const specialPhotos = safeJsonParse(orderPayload.special_photos);

    if (Array.isArray(deliveryPhotoUrls)) {
      deliveryPhotoUrls.forEach(pushPhoto);
    } else {
      pushPhoto(deliveryPhotoUrls);
    }

    if (Array.isArray(deliveryPhotoUrl)) {
      deliveryPhotoUrl.forEach(pushPhoto);
    } else {
      pushPhoto(deliveryPhotoUrl);
    }

    if (Array.isArray(specialPhotos)) {
      specialPhotos.forEach(pushPhoto);
    } else {
      pushPhoto(specialPhotos);
    }

    const files = getFilesFromRequest(req);

    // This converts compressed uploaded files to:
    // /uploads/order_delivery_photos/filename.webp
    const uploadedUris = toWebPaths(files);

    const allPhotos = [...existingPhotos, ...uploadedUris]
      .map((u) => String(u || "").trim())
      .filter(Boolean);

    const mergedPhotos = [...new Set(allPhotos)];

    if (mergedPhotos.length > MAX_PHOTOS) {
      return res.status(400).json({
        success: false,
        message: `Max ${MAX_PHOTOS} photos allowed.`,
        received: mergedPhotos.length,
      });
    }

    orderPayload.delivery_photo_urls = mergedPhotos;
    orderPayload.delivery_photo_url = mergedPhotos[0] || null;
    orderPayload.special_photos = mergedPhotos;

    const saved = await addScheduledOrder(scheduled_at, orderPayload, userId);

    return res.json({
      success: true,
      message: "Order scheduled successfully.",
      job_id: saved.job_id,
      scheduled_at_utc: saved.scheduled_at,
      scheduled_at_local: saved.scheduled_at_local,
      accept_expires_at: saved.accept_expires_at,
      queue: "PENDING",
      service_type: saved.order_payload?.service_type || serviceType,
      photo_count: mergedPhotos.length,
      photos: mergedPhotos,
    });
  } catch (err) {
    console.error("scheduleOrder error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.listScheduledOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);

    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id parameter.",
      });
    }

    const list = await getScheduledOrdersByUser(userId);

    if (!list.length) {
      return res.json({ success: true, data: [] });
    }

    const businessIds = [
      ...new Set(
        list
          .map((job) => job.business_id)
          .filter((bid) => bid != null && Number.isFinite(Number(bid)))
          .map((x) => Number(x)),
      ),
    ];

    const businessData = await fetchBusinessDetailsMap(businessIds);

    const foodMenuIds = new Set();
    const martMenuIds = new Set();

    for (const job of list) {
      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = job?.order_payload?.items;
      if (!Array.isArray(items)) continue;

      for (const it of items) {
        const mid = Number(it?.menu_id);
        if (!Number.isFinite(mid) || mid <= 0) continue;

        if (serviceType === "FOOD") foodMenuIds.add(mid);
        else if (serviceType === "MART") martMenuIds.add(mid);
      }
    }

    const foodImageById = await fetchMenuImages("FOOD", [...foodMenuIds]);
    const martImageById = await fetchMenuImages("MART", [...martMenuIds]);

    const enriched = list.map((job) => {
      const business = businessData.get(Number(job.business_id)) || {};
      const businessLogo = business.business_logo || null;
      const businessAddress = business.address || null;

      const serviceType = String(job?.order_payload?.service_type || "")
        .trim()
        .toUpperCase();

      const items = Array.isArray(job?.order_payload?.items)
        ? job.order_payload.items
        : [];

      const enrichedItems = items.map((it) => {
        const mid = Number(it?.menu_id);
        let itemImage = it?.item_image || null;

        if (Number.isFinite(mid) && mid > 0) {
          if (serviceType === "FOOD") {
            itemImage = foodImageById.get(mid) || itemImage;
          } else if (serviceType === "MART") {
            itemImage = martImageById.get(mid) || itemImage;
          }
        }

        return {
          ...it,
          item_image: itemImage,
        };
      });

      const status = job?.order_payload?.status || "PENDING";

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        business_id: job.business_id ?? null,
        business_logo: businessLogo,
        business_address: businessAddress,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        accept_expires_at: job.accept_expires_at ?? null,
        created_at_utc: job.created_at ?? null,

        order_payload: {
          ...job.order_payload,
          status,
          rejection_reason: job?.order_payload?.rejection_reason || null,
          rejected_at: job?.order_payload?.rejected_at || null,
          accepted_at: job?.order_payload?.accepted_at || null,
          items: enrichedItems,
          item_images: enrichedItems.map((it) => it.item_image || null),
        },
      };
    });

    return res.json({
      success: true,
      data: enriched,
    });
  } catch (err) {
    console.error("listScheduledOrders error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.listScheduledOrdersByBusiness = async (req, res) => {
  try {
    const businessId = Number(req.params.businessId);

    if (!Number.isFinite(businessId) || businessId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid businessId parameter.",
      });
    }

    if (!(await callerOwnsBusiness(req, businessId))) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this business's orders.",
      });
    }

    const list = await getScheduledOrdersByBusiness(businessId);

    if (!list.length) {
      return res.json({ success: true, data: [] });
    }

    const userIds = [
      ...new Set(
        list
          .map((j) => j.user_id)
          .filter((uid) => uid != null && Number.isFinite(Number(uid)))
          .map((x) => Number(x)),
      ),
    ];

    const userNameById = await fetchUserNameMap(userIds);

    const sorted = [...list].sort(
      (a, b) => (b.scheduled_epoch_ms ?? 0) - (a.scheduled_epoch_ms ?? 0),
    );

    const mapped = sorted.map((job) => {
      const uid = Number(job.user_id);

      const items = Array.isArray(job?.order_payload?.items)
        ? job.order_payload.items
        : [];

      const status = job?.order_payload?.status || "PENDING";

      return {
        job_id: job.job_id,
        user_id: job.user_id,
        name: userNameById.get(uid) || null,
        business_id: job.business_id ?? null,

        scheduled_at_utc: job.scheduled_at ?? null,
        scheduled_at_local:
          job.scheduled_at_local ??
          (Number.isFinite(job.scheduled_epoch_ms)
            ? epochToBhutanIso(job.scheduled_epoch_ms)
            : null),

        accept_expires_at: job.accept_expires_at ?? null,
        created_at_utc: job.created_at ?? null,

        order_payload: {
          ...job.order_payload,
          status,
          rejection_reason: job?.order_payload?.rejection_reason || null,
          rejected_at: job?.order_payload?.rejected_at || null,
          accepted_at: job?.order_payload?.accepted_at || null,
          items,
          item_images: items.map((it) => it.item_image || null),
        },
      };
    });

    return res.json({
      success: true,
      data: mapped,
    });
  } catch (err) {
    console.error("listScheduledOrdersByBusiness error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.cancelScheduledOrder = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const jobId = String(req.params.jobId || "").trim();

    if (!Number.isFinite(userId) || userId <= 0 || !jobId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id or jobId.",
      });
    }

    const ok = await cancelScheduledOrderForUser(jobId, userId);

    if (!ok) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found for this user.",
      });
    }

    return res.json({
      success: true,
      message: "Scheduled order cancelled.",
      job_id: jobId,
    });
  } catch (err) {
    console.error("cancelScheduledOrder error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};

exports.updateScheduledOrderStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const body = req.body || {};

    const status = normalizeStatus(body.status);
    const reason = body.reason;
    const estimated_minutes = body.estimated_minutes;

    if (!jobId || !["ACCEPTED", "REJECTED"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid jobId or status. ACCEPTED or REJECTED required.",
      });
    }

    if (status === "REJECTED" && (!reason || !String(reason).trim())) {
      return res.status(400).json({
        success: false,
        message: "Reason is required when rejecting a scheduled order.",
      });
    }

    const redis = require("../config/redis");

    const {
      sendUserNotification,
    } = require("../services/expoNotificationService");

    const jobKey = buildJobKey(jobId);
    const raw = await redis.get(jobKey);

    if (!raw) {
      return res.status(404).json({
        success: false,
        message: "Scheduled order not found.",
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(500).json({
        success: false,
        message: "Scheduled order data is corrupted.",
      });
    }

    const orderBusinessId = data?.order_payload?.business_id ?? data?.business_id;

    if (
      orderBusinessId != null &&
      !(await callerOwnsBusiness(req, orderBusinessId))
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this scheduled order.",
      });
    }

    const currentStatus = data.order_payload?.status || "PENDING";

    if (currentStatus !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Order already ${currentStatus}.`,
      });
    }

    const userId = data.user_id;

    if (status === "ACCEPTED") {
      const estimatedMins = Number(estimated_minutes);

      if (
        estimated_minutes == null ||
        !Number.isFinite(estimatedMins) ||
        estimatedMins <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "estimated_minutes is required and must be a positive number.",
        });
      }

      data.order_payload.status = "ACCEPTED";
      data.order_payload.estimated_minutes = estimatedMins;
      data.order_payload.accepted_at = new Date().toISOString();
      data.updated_at = new Date().toISOString();

      const scheduledScore = Number(data.scheduled_epoch_ms);

      if (!Number.isFinite(scheduledScore)) {
        return res.status(400).json({
          success: false,
          message: "Invalid scheduled time for this scheduled order.",
        });
      }

      await redis
        .multi()
        .set(jobKey, JSON.stringify(data))
        .zrem(PENDING_ZSET_KEY, jobId)
        .zrem(REJECTED_ZSET_KEY, jobId)
        .zrem(ZSET_KEY, jobId)
        .zadd(ACCEPTED_ZSET_KEY, scheduledScore, jobId)
        .exec();

      await sendUserNotification({
        user_id: userId,
        title: "Order Accepted",
        body:
          "Your scheduled order has been accepted and will be processed at the scheduled time.",
      });

      return res.json({
        success: true,
        message: "Scheduled order accepted.",
        job_id: jobId,
        status: "ACCEPTED",
        queue: "ACCEPTED",
        scheduled_at_utc: data.scheduled_at,
        scheduled_at_local: data.scheduled_at_local,
        estimated_minutes: estimatedMins,
      });
    }

    if (status === "REJECTED") {
      const cleanReason = String(reason).trim();

      data.order_payload.status = "REJECTED";
      data.order_payload.rejection_reason = cleanReason;
      data.order_payload.rejected_at = new Date().toISOString();
      data.updated_at = new Date().toISOString();

      const deleteAtMs = Date.now() + REJECTED_VISIBLE_MS;

      await redis
        .multi()
        .set(jobKey, JSON.stringify(data))
        .zrem(PENDING_ZSET_KEY, jobId)
        .zrem(ACCEPTED_ZSET_KEY, jobId)
        .zrem(ZSET_KEY, jobId) // legacy safety
        .zadd(REJECTED_ZSET_KEY, deleteAtMs, jobId)
        .exec();

      await sendUserNotification({
        user_id: userId,
        title: "Order Rejected",
        body: `Your scheduled order has been rejected. Reason: ${cleanReason}. This order will be automatically removed after 30 minutes.`,
      });

      return res.json({
        success: true,
        message: "Scheduled order rejected. Will be removed after 30 minutes.",
        job_id: jobId,
        status: "REJECTED",
        reason: cleanReason,
        queue: "REJECTED",
        visible_until_minutes: 30,
      });
    }

    return res.status(400).json({
      success: false,
      message: "Unsupported status.",
    });
  } catch (err) {
    console.error("updateScheduledOrderStatus error:", err);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || "Unknown error",
    });
  }
};