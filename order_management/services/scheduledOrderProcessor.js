// services/scheduledOrderProcessor.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Redis queue logic remains unchanged
// ✅ Axios call to normal order API remains unchanged

const axios = require("axios");
const redis = require("../config/redis");
const { prisma } = require("../lib/prisma");

const {
  ACCEPTED_ZSET_KEY,
  PENDING_ZSET_KEY,
  REJECTED_ZSET_KEY,
  ZSET_KEY, // legacy cleanup safety
  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
  buildErrorKey,
} = require("../models/scheduledOrderModel");

const ORDER_CREATE_URL =
  process.env.ORDER_CREATE_URL || "http://localhost:1001/orders";

const POLL_INTERVAL_MS = 5000;
const BATCH_SIZE = 100;

const LOCK_TTL_SECONDS = 60;

// retries
const MAX_ATTEMPTS = 5;
const ATTEMPT_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const BASE_RETRY_DELAY_MS = 60 * 1000; // 1 minute
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hour

const BHUTAN_OFFSET_HOURS = 6;

const buildFailedKey = (jobId) => `scheduled_order_failed:${jobId}`;

/* ===================== Generic helpers ===================== */

function sum(nums) {
  return nums.reduce((s, n) => s + (Number(n) || 0), 0);
}

function safeJsonParse(s) {
  if (typeof s !== "string") return null;

  const t = s.trim();
  if (!t) return null;

  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toPositiveBigInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
}

function safeString(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
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

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v || {});
  } catch {
    return "{}";
  }
}

/* ===================== Prisma lookup helpers ===================== */

async function getBusinessNameMapByIds(businessIds = []) {
  const ids = Array.from(
    new Set(
      (businessIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
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
      const row = serializeRow(raw);
      map.set(Number(row.business_id), row.business_name || null);
    }
  } catch (err) {
    console.error("[SCHED] Failed to fetch business names:", err.message);
  }

  return map;
}

/* ===================== ETA helpers ===================== */

/**
 * Rule:
 * start time = scheduled_at_local
 * end time   = scheduled_at_local + estimated_minutes + 30 minutes
 *
 * Example:
 * scheduled_at_local = 2026-06-01T11:04:00+06:00
 * estimated_minutes = 30
 * result = 11:04 - 12:04 PM
 */
function formatScheduledEtaRange({
  scheduledEpochMs,
  scheduledAtLocal,
  estimatedMinutes,
  extraWindowMinutes = 30,
}) {
  const mins = Number(estimatedMinutes);

  if (!Number.isFinite(mins) || mins <= 0) {
    return null;
  }

  let startEpochMs = Number(scheduledEpochMs);

  if (!Number.isFinite(startEpochMs) || startEpochMs <= 0) {
    startEpochMs = Date.parse(String(scheduledAtLocal || ""));
  }

  if (!Number.isFinite(startEpochMs) || startEpochMs <= 0) {
    return null;
  }

  const endEpochMs =
    startEpochMs + (mins + Number(extraWindowMinutes || 30)) * 60 * 1000;

  const startDate = new Date(startEpochMs);
  const endDate = new Date(endEpochMs);

  const toBhutanParts = (d) => {
    const bhutanMs = d.getTime() + BHUTAN_OFFSET_HOURS * 60 * 60 * 1000;
    const bhutanDate = new Date(bhutanMs);

    const hour24 = bhutanDate.getUTCHours();
    const minute = bhutanDate.getUTCMinutes();
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;

    return {
      hour12,
      minute,
      meridiem,
    };
  };

  const start = toBhutanParts(startDate);
  const end = toBhutanParts(endDate);

  const startText = `${start.hour12}:${String(start.minute).padStart(2, "0")}`;
  const endText = `${end.hour12}:${String(end.minute).padStart(2, "0")}`;

  if (start.meridiem === end.meridiem) {
    return `${startText} - ${endText} ${end.meridiem}`;
  }

  return `${startText} ${start.meridiem} - ${endText} ${end.meridiem}`;
}

async function updateEstimatedArrivalTimeForScheduledOrder({
  orderId,
  scheduledEpochMs,
  scheduledAtLocal,
  estimatedMinutes,
}) {
  const oid = String(orderId || "").trim().toUpperCase();

  if (!oid) return null;

  const etaRange = formatScheduledEtaRange({
    scheduledEpochMs,
    scheduledAtLocal,
    estimatedMinutes,
    extraWindowMinutes: 30,
  });

  if (!etaRange) return null;

  await prisma.orders.updateMany({
    where: {
      order_id: oid,
    },
    data: {
      estimated_arrivial_time: etaRange,
      updated_at: new Date(),
    },
  });

  return etaRange;
}

/* ===================== Payload normalization ===================== */

async function normalizeCreateOrderPayload(raw = {}) {
  const p = { ...(raw || {}) };

  // Handle old nested payload string if any legacy scheduled order still has it.
  if (typeof p.payload === "string" && p.payload.trim()) {
    const parsedPayload = safeJsonParse(p.payload);

    if (parsedPayload && typeof parsedPayload === "object") {
      Object.keys(parsedPayload).forEach((key) => {
        if (p[key] === undefined || p[key] === null) {
          p[key] = parsedPayload[key];
        }
      });

      if (Array.isArray(parsedPayload.special_photos)) {
        p.special_photos = parsedPayload.special_photos;
      }

      if (parsedPayload.delivery_photo_url) {
        p.delivery_photo_url = parsedPayload.delivery_photo_url;
      }

      if (Array.isArray(parsedPayload.items)) {
        p.items = parsedPayload.items.map((item) => ({
          ...item,
          business_name: item.business_name || item.businessName || null,
          business_id: item.business_id || item.businessId || null,
          item_image: item.item_image || item.image || null,
          image: undefined,
        }));
      }

      delete p.payload;
    }
  }

  // Normalize items
  if (Array.isArray(p.items) && p.items.length > 0) {
    const globalBusinessId = p.business_id || null;
    const globalBusinessName = p.business_name || null;

    p.items = p.items.map((item) => ({
      ...item,
      business_id: item.business_id || item.businessId || globalBusinessId,
      business_name:
        item.business_name || item.businessName || globalBusinessName || null,
      menu_id: item.menu_id,
      item_name: item.name || item.item_name,
      item_image: item.item_image || item.image || null,
      quantity: Number(item.quantity) || 1,
      price: Number(item.price || item.unit_price) || 0,
      subtotal: Number(item.subtotal || item.line_subtotal || 0),
      tax_rate: Number(item.tax_rate || 0),
      tax_amount: Number(item.tax_amount || 0),
    }));

    // Fetch missing business names from DB using Prisma.
    const missingBusinessIds = [
      ...new Set(
        p.items
          .filter((item) => !item.business_name && item.business_id)
          .map((item) => Number(item.business_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];

    if (missingBusinessIds.length) {
      const businessNameMap = await getBusinessNameMapByIds(missingBusinessIds);

      p.items = p.items.map((item) => ({
        ...item,
        business_name:
          item.business_name ||
          businessNameMap.get(Number(item.business_id)) ||
          "Unknown Business",
      }));
    }
  }

  // Remove scheduler-only keys before sending to normal order API
  delete p.scheduled_at;
  delete p.scheduled_at_local;
  delete p.scheduled_epoch_ms;
  delete p.created_at;
  delete p.updated_at;
  delete p.job_id;
  delete p.business_details;
  delete p.retry_at;
  delete p.retry_count;
  delete p.last_error;
  delete p.accept_expires_at;
  delete p.accept_expires_epoch_ms;

  // Do not send estimated_minutes to normal order creation API.
  // We update orders.estimated_arrivial_time separately after order creation.
  delete p.estimated_minutes;

  if (p.service_type != null) {
    p.service_type = String(p.service_type).trim().toUpperCase();
  }

  if (p.payment_method != null) {
    p.payment_method = String(p.payment_method).trim().toUpperCase();
  }

  if (p.fulfillment_type != null) {
    const f = String(p.fulfillment_type).trim();
    p.fulfillment_type = f.toLowerCase() === "pickup" ? "Pickup" : "Delivery";
  } else {
    p.fulfillment_type = "Delivery";
  }

  if (!p.delivery_address && p.deliver_to) {
    p.delivery_address = p.deliver_to;
  }

  if (p.delivery_address && typeof p.delivery_address === "string") {
    const parsedAddress = safeJsonParse(p.delivery_address);
    if (parsedAddress) p.delivery_address = parsedAddress;
  }

  const items = Array.isArray(p.items) ? p.items : [];
  p.items = items;

  if (p.delivery_fee == null) {
    const perItemDeliveryFees = items.map((it) => it?.delivery_fee);
    p.delivery_fee = Number(sum(perItemDeliveryFees).toFixed(2));
  } else {
    p.delivery_fee = Number(p.delivery_fee);
  }

  if (p.platform_fee == null) p.platform_fee = 0;
  if (p.discount_amount == null) p.discount_amount = 0;
  if (p.tax_amount == null) p.tax_amount = 0;

  p.platform_fee = Number(p.platform_fee);
  p.discount_amount = Number(p.discount_amount);
  p.tax_amount = Number(p.tax_amount);

  if (p.total_amount == null) {
    const itemsSubtotal = sum(
      items.map((it) => it?.subtotal || it?.line_subtotal || 0),
    );

    p.total_amount = Number(
      (
        itemsSubtotal +
        (Number(p.delivery_fee) || 0) +
        (Number(p.platform_fee) || 0) +
        (Number(p.tax_amount) || 0) -
        (Number(p.discount_amount) || 0)
      ).toFixed(2),
    );
  } else {
    p.total_amount = Number(p.total_amount);
  }

  if (p.priority != null) {
    if (typeof p.priority === "boolean") {
      // keep as is
    } else {
      const s = String(p.priority).trim().toLowerCase();
      p.priority = s === "true" || s === "1" || s === "yes";
    }
  } else {
    p.priority = false;
  }

  // Actual created order should be confirmed.
  p.status = "CONFIRMED";

  const photos = Array.isArray(p.special_photos)
    ? p.special_photos
        .map((x) => (x == null ? "" : String(x).trim()))
        .filter(Boolean)
    : [];

  if (!p.delivery_photo_url) {
    p.delivery_photo_url = photos[0] || null;
  }

  p.special_photos = photos;

  console.log(
    "[SCHED] Final normalized payload:",
    JSON.stringify(
      {
        user_id: p.user_id,
        business_id: p.business_id,
        service_type: p.service_type,
        payment_method: p.payment_method,
        items_count: p.items.length,
        items_with_business_name: p.items.every((i) => i.business_name),
        total_amount: p.total_amount,
        status: p.status,
      },
      null,
      2,
    ),
  );

  return p;
}

/* ===================== Order API call ===================== */

async function createOrderFromScheduledPayload(orderPayload) {
  const payloadToSend = await normalizeCreateOrderPayload(orderPayload);

  if (!payloadToSend.user_id) {
    throw new Error("Missing user_id in scheduled order payload.");
  }

  if (!payloadToSend.business_id) {
    throw new Error("Missing business_id in scheduled order payload.");
  }

  if (!payloadToSend.service_type) {
    throw new Error("Missing service_type in scheduled order payload.");
  }

  if (!Array.isArray(payloadToSend.items) || !payloadToSend.items.length) {
    throw new Error("Missing items in scheduled order payload.");
  }

  const missingBusinessName = payloadToSend.items.some(
    (item) => !item.business_name,
  );

  if (missingBusinessName) {
    const businessIds = [
      ...new Set(
        payloadToSend.items
          .map((item) => Number(item.business_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    ];

    if (businessIds.length) {
      const businessMap = await getBusinessNameMapByIds(businessIds);

      payloadToSend.items = payloadToSend.items.map((item) => ({
        ...item,
        business_name:
          item.business_name ||
          businessMap.get(Number(item.business_id)) ||
          "Unknown Business",
      }));
    }
  }

  try {
    console.log(
      "[SCHED] Sending to orders API:",
      JSON.stringify(
        {
          url: ORDER_CREATE_URL,
          user_id: payloadToSend.user_id,
          business_id: payloadToSend.business_id,
          service_type: payloadToSend.service_type,
          items_count: payloadToSend.items?.length,
          has_business_names: payloadToSend.items?.every(
            (i) => i.business_name,
          ),
          total_amount: payloadToSend.total_amount,
        },
        null,
        2,
      ),
    );

    const response = await axios.post(ORDER_CREATE_URL, payloadToSend, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = response.data || {};

    if (data.success === false || data.ok === false) {
      throw new Error(
        data.message || data.error || "Order API returned success=false",
      );
    }

    const orderId =
      data.order_id || data.id || data?.data?.order_id || data?.data?.id;

    return orderId || null;
  } catch (err) {
    console.error("[SCHED] API Error Details:");
    console.error("- URL:", ORDER_CREATE_URL);
    console.error("- Message:", err.message);
    console.error("- Status:", err.response?.status);
    console.error(
      "- Response data:",
      JSON.stringify(err.response?.data, null, 2),
    );

    throw err;
  }
}

/* ===================== Notifications ===================== */

async function getMerchantUserIdByBusinessId(businessId) {
  const bid = toPositiveBigInt(businessId);

  if (!bid) return null;

  try {
    const row = await prisma.merchant_business_details.findUnique({
      where: {
        business_id: bid,
      },
      select: {
        user_id: true,
      },
    });

    const merchantUserId = row?.user_id != null ? Number(row.user_id) : null;

    return Number.isFinite(merchantUserId) && merchantUserId > 0
      ? merchantUserId
      : null;
  } catch (err) {
    console.error(
      `[SCHED] Failed to fetch merchant user_id for business_id ${businessId}:`,
      err.message,
    );

    return null;
  }
}

async function sendPushNotificationSafe({ user_id, title, body }) {
  const uid = toPositiveNumber(user_id);

  if (!uid) return;

  try {
    const {
      sendUserNotification,
    } = require("../services/expoNotificationService");

    await sendUserNotification({
      user_id: uid,
      title,
      body,
    });
  } catch (err) {
    console.error(
      `[SCHED] Push notification failed for user_id ${uid}:`,
      err.message,
    );
  }
}

async function insertDbNotificationSafe({ user_id, title, message, data }) {
  const uid = toPositiveBigInt(user_id);

  if (!uid) return;

  try {
    await prisma.notifications.create({
      data: {
        user_id: uid,
        type: "order_status",
        title: safeString(title, "Order status"),
        message: safeString(message, ""),
        data: safeJsonStringify(data),
        status: "unread",
        created_at: new Date(),
      },
    });
  } catch (err) {
    console.error(
      `[SCHED] DB notification failed for user_id ${String(user_id)}:`,
      err.message,
    );
  }
}

async function notifyScheduledOrderProcessed({
  data,
  orderId,
  jobId,
  estimatedArrivalTime,
}) {
  const customerUserId = toPositiveNumber(
    data?.user_id || data?.order_payload?.user_id,
  );

  const businessId =
    data?.business_id ||
    data?.order_payload?.business_id ||
    data?.order_payload?.businessId ||
    data?.order_payload?.items?.[0]?.business_id ||
    data?.order_payload?.items?.[0]?.businessId ||
    null;

  const merchantUserId = await getMerchantUserIdByBusinessId(businessId);

  const scheduledAt = data?.scheduled_at_local || data?.scheduled_at || null;

  const customerTitle = "Scheduled Order Processed";
  const customerMessage = estimatedArrivalTime
    ? `Your scheduled order has been processed successfully. Estimated arrival time: ${estimatedArrivalTime}.`
    : "Your scheduled order has been processed successfully. Please track the order accordingly.";

  const merchantTitle = "Scheduled Order Received";
  const merchantMessage = estimatedArrivalTime
    ? `A scheduled order is now active. Estimated arrival time: ${estimatedArrivalTime}.`
    : "A scheduled order has been processed successfully and is now active. Please prepare and manage it from your order dashboard.";

  const baseData = {
    job_id: jobId,
    order_id: orderId || null,
    business_id: businessId,
    scheduled_at: scheduledAt,
    estimated_arrivial_time: estimatedArrivalTime || null,
    status: "CONFIRMED",
  };

  // Customer push + DB notification
  await sendPushNotificationSafe({
    user_id: customerUserId,
    title: customerTitle,
    body: customerMessage,
  });

  await insertDbNotificationSafe({
    user_id: customerUserId,
    title: customerTitle,
    message: customerMessage,
    data: {
      ...baseData,
      recipient_type: "customer",
    },
  });

  // Merchant push + DB notification
  await sendPushNotificationSafe({
    user_id: merchantUserId,
    title: merchantTitle,
    body: merchantMessage,
  });

  await insertDbNotificationSafe({
    user_id: merchantUserId,
    title: merchantTitle,
    message: merchantMessage,
    data: {
      ...baseData,
      recipient_type: "merchant",
      customer_user_id: customerUserId,
    },
  });
}

/* ===================== Redis helpers ===================== */

async function fetchDueAcceptedJobIds(nowTs) {
  return redis.zrangebyscore(
    ACCEPTED_ZSET_KEY,
    0,
    nowTs,
    "LIMIT",
    0,
    BATCH_SIZE,
  );
}

async function getLockTTL(lockKey) {
  try {
    const ttl = await redis.ttl(lockKey);
    return typeof ttl === "number" ? ttl : -2;
  } catch {
    return -2;
  }
}

async function tryClaimJob(jobId) {
  const lockKey = buildLockKey(jobId);
  const lockValue = `${process.pid}:${Date.now()}`;

  const result = await redis.set(
    lockKey,
    lockValue,
    "NX",
    "EX",
    LOCK_TTL_SECONDS,
  );

  if (result === "OK") return true;

  const ttl = await getLockTTL(lockKey);

  // Repair lock with no expiry
  if (ttl === -1) {
    await redis.del(lockKey);

    const retry = await redis.set(
      lockKey,
      lockValue,
      "NX",
      "EX",
      LOCK_TTL_SECONDS,
    );

    if (retry === "OK") return true;
  }

  return false;
}

async function markFailed(jobId, errMessage, errBody = null) {
  const failedKey = buildFailedKey(jobId);

  const payload = {
    job_id: jobId,
    failed_at: new Date().toISOString(),
    error: String(errMessage || "").slice(0, 1000),
    response: errBody || null,
  };

  await redis.set(
    failedKey,
    JSON.stringify(payload),
    "EX",
    ATTEMPT_TTL_SECONDS,
  );
}

async function cleanupJobFromAllQueues(jobId, jobKey) {
  await redis
    .multi()
    .zrem(ACCEPTED_ZSET_KEY, jobId)
    .zrem(PENDING_ZSET_KEY, jobId)
    .zrem(REJECTED_ZSET_KEY, jobId)
    .zrem(ZSET_KEY, jobId) // legacy safety
    .del(jobKey)
    .del(buildLockKey(jobId))
    .del(buildAttemptsKey(jobId))
    .del(buildErrorKey(jobId))
    .exec();
}

async function removeFromAcceptedAndUnlock(jobId) {
  await redis
    .multi()
    .zrem(ACCEPTED_ZSET_KEY, jobId)
    .del(buildLockKey(jobId))
    .exec();
}

async function failAndMaybeStopRetry(jobId, err) {
  const attemptsKey = buildAttemptsKey(jobId);

  let attempts = await redis.get(attemptsKey);
  attempts = attempts ? parseInt(attempts, 10) + 1 : 1;

  await redis.set(attemptsKey, attempts, "EX", ATTEMPT_TTL_SECONDS);

  const status = err?.response?.status;
  const body = err?.response?.data || null;

  // 400 / 404 are permanent failures.
  if (status === 400 || status === 404) {
    await redis.set(
      buildErrorKey(jobId),
      String(err.message).slice(0, 1000),
      "EX",
      ATTEMPT_TTL_SECONDS,
    );

    await markFailed(jobId, err.message, body);

    await redis
      .multi()
      .zrem(ACCEPTED_ZSET_KEY, jobId)
      .zrem(PENDING_ZSET_KEY, jobId)
      .zrem(REJECTED_ZSET_KEY, jobId)
      .zrem(ZSET_KEY, jobId)
      .del(buildLockKey(jobId))
      .exec();

    console.log(`[SCHED] Permanent failure for ${jobId} due to ${status}`);

    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(jobId, err.message, body);

    await redis
      .multi()
      .zrem(ACCEPTED_ZSET_KEY, jobId)
      .zrem(PENDING_ZSET_KEY, jobId)
      .zrem(REJECTED_ZSET_KEY, jobId)
      .zrem(ZSET_KEY, jobId)
      .del(buildLockKey(jobId))
      .exec();

    console.log(
      `[SCHED] Permanent failure for ${jobId} after ${MAX_ATTEMPTS} attempts`,
    );

    return;
  }

  const delayMs = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );

  const retryAt = Date.now() + delayMs;
  const jobKey = buildJobKey(jobId);

  const raw = await redis.get(jobKey);

  if (raw) {
    try {
      const data = JSON.parse(raw);

      data.retry_at = new Date(retryAt).toISOString();
      data.retry_count = attempts;
      data.last_error = err.message;
      data.updated_at = new Date().toISOString();

      await redis
        .multi()
        .set(jobKey, JSON.stringify(data))
        .zadd(ACCEPTED_ZSET_KEY, retryAt, jobId)
        .del(buildLockKey(jobId))
        .exec();

      console.log(
        `[SCHED] Retry ${attempts}/${MAX_ATTEMPTS} for ${jobId} scheduled at ${new Date(
          retryAt,
        ).toISOString()}`,
      );

      return;
    } catch (parseErr) {
      console.error(
        `[SCHED] Failed parsing job during retry ${jobId}:`,
        parseErr.message,
      );
    }
  }

  await redis.del(buildLockKey(jobId));
}

/* ===================== Core processing ===================== */

async function processJob(jobId) {
  const jobKey = buildJobKey(jobId);

  try {
    const raw = await redis.get(jobKey);

    if (!raw) {
      await redis
        .multi()
        .zrem(ACCEPTED_ZSET_KEY, jobId)
        .zrem(PENDING_ZSET_KEY, jobId)
        .zrem(REJECTED_ZSET_KEY, jobId)
        .zrem(ZSET_KEY, jobId)
        .del(buildLockKey(jobId))
        .exec();

      console.log(`[SCHED] Job ${jobId} not found, removing from queues`);

      return;
    }

    const data = JSON.parse(raw);
    const { order_payload } = data;

    if (!order_payload) {
      throw new Error("Missing order_payload in scheduled job");
    }

    if (data.retry_at && new Date(data.retry_at).getTime() > Date.now()) {
      console.log(
        `[SCHED] Job ${jobId} scheduled for retry at ${data.retry_at}, skipping`,
      );

      await redis.del(buildLockKey(jobId));

      return;
    }

    const status = order_payload?.status || "PENDING";

    if (status !== "ACCEPTED") {
      console.log(
        `[SCHED] Job ${jobId} status is ${status}, removing from accepted queue`,
      );

      await removeFromAcceptedAndUnlock(jobId);

      return;
    }

    console.log(`[SCHED] 🚀 Processing accepted scheduled order ${jobId}`);

    const completePayload = {
      ...order_payload,
      user_id: data.user_id,
      business_id: data.business_id || order_payload.business_id,
      scheduled_at: data.scheduled_at,
      scheduled_at_local: data.scheduled_at_local,
    };

    console.log(
      `[SCHED] Order payload for ${jobId}:`,
      JSON.stringify(
        {
          user_id: completePayload.user_id,
          business_id: completePayload.business_id,
          service_type: completePayload.service_type,
          items_count: completePayload.items?.length,
          items_have_business_names: completePayload.items?.every(
            (i) => i.business_name,
          ),
          total_amount: completePayload.total_amount,
          scheduled_at_local: data.scheduled_at_local,
          estimated_minutes: order_payload.estimated_minutes,
        },
        null,
        2,
      ),
    );

    const orderId = await createOrderFromScheduledPayload(completePayload);

    const estimatedArrivalTime =
      await updateEstimatedArrivalTimeForScheduledOrder({
        orderId,
        scheduledEpochMs: Number(data.scheduled_epoch_ms),
        scheduledAtLocal: data.scheduled_at_local,
        estimatedMinutes: order_payload.estimated_minutes,
      });

    if (estimatedArrivalTime) {
      console.log(
        `[SCHED] ETA updated for order ${orderId}: ${estimatedArrivalTime}`,
      );
    } else {
      console.log(
        `[SCHED] ETA not updated for ${jobId}. Missing orderId, scheduled time, or estimated_minutes.`,
      );
    }

    await notifyScheduledOrderProcessed({
      data,
      orderId,
      jobId,
      estimatedArrivalTime,
    });

    await cleanupJobFromAllQueues(jobId, jobKey);

    console.log(
      `[SCHED] ✅ Successfully processed ${jobId} → Order ID: ${
        orderId || "created"
      }`,
    );
  } catch (err) {
    console.error(`[SCHED] ❌ Failed to process ${jobId}:`, err.message);

    await failAndMaybeStopRetry(jobId, err);
  }
}

async function tick() {
  try {
    const nowTs = Date.now();
    const jobIds = await fetchDueAcceptedJobIds(nowTs);

    if (!jobIds || !jobIds.length) return;

    console.log(`[SCHED] Found ${jobIds.length} due accepted jobs`);

    for (const jobId of jobIds) {
      const claimed = await tryClaimJob(jobId);

      if (!claimed) {
        console.log(`[SCHED] Could not claim ${jobId}, skipping`);
        continue;
      }

      await processJob(jobId);
    }
  } catch (err) {
    console.error("[SCHED] Tick error:", err.message);
  }
}

async function processSingleJob(jobId) {
  const claimed = await tryClaimJob(jobId);

  if (!claimed) {
    return false;
  }

  await processJob(jobId);

  return true;
}

function startScheduledOrderProcessor() {
  console.log("[SCHED] Starting accepted scheduled order processor...");

  const timer = setInterval(tick, POLL_INTERVAL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  console.log(`[SCHED] Accepted processor running every ${POLL_INTERVAL_MS}ms`);

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  startScheduledOrderProcessor,
  processSingleJob,

  // exported for testing/debugging
  formatScheduledEtaRange,
};