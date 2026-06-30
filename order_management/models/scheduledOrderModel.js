// models/scheduledOrderModel.js
const redis = require("../config/redis");

const ZSET_KEY = "scheduled_orders"; // legacy key - keep for old data cleanup/migration
const PENDING_ZSET_KEY = "scheduled_orders_pending";
const ACCEPTED_ZSET_KEY = "scheduled_orders_accepted";
const REJECTED_ZSET_KEY = "scheduled_orders_rejected";

const COUNTER_KEY = "scheduled_order_counter";

// Bhutan is UTC+6, no DST
const BHUTAN_OFFSET_MINUTES = 6 * 60;

// Merchant must accept/reject within 30 minutes
const ACCEPT_TIMEOUT_MS = 30 * 60 * 1000;

async function generateScheduledId() {
  const counter = await redis.incr(COUNTER_KEY);
  const padded = String(counter).padStart(6, "0");
  return `SCH-${padded}`;
}

function buildJobKey(jobId) {
  return `scheduled_order:${jobId}`;
}

function buildLockKey(jobId) {
  return `scheduled_order_lock:${jobId}`;
}

function buildAttemptsKey(jobId) {
  return `scheduled_order_attempts:${jobId}`;
}

function buildErrorKey(jobId) {
  return `scheduled_order_error:${jobId}`;
}

function parseScheduledToEpochMs(input) {
  if (!input) return NaN;
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return Number.isFinite(input) ? input : NaN;

  const s = String(input).trim();
  if (!s) return NaN;

  // If timezone is included, native parse is okay.
  const hasTZ = /([zZ]|[+\-]\d{2}:?\d{2})$/.test(s);
  if (hasTZ) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }

  // No timezone means Bhutan local time.
  let normalized = s.replace(" ", "T");

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    normalized += ":00";
  }

  const bhutanDate = new Date(`${normalized}+06:00`);
  const epochMs = bhutanDate.getTime();

  console.log(
    `[parseScheduled] Input: ${s}, Bhutan time: ${normalized}+06:00, Epoch: ${epochMs}, Now: ${Date.now()}`,
  );

  return Number.isFinite(epochMs) ? epochMs : NaN;
}

function epochToBhutanIso(epochMs) {
  const d = new Date(epochMs + BHUTAN_OFFSET_MINUTES * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");

  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+06:00`;
}

function extractBusinessIdFromJob(data) {
  if (!data) return null;

  let rawBizId =
    data.business_id ??
    data.order_payload?.business_id ??
    data.order_payload?.businessId ??
    data.order_payload?.business?.business_id ??
    null;

  if (
    rawBizId == null &&
    data.order_payload &&
    Array.isArray(data.order_payload.items) &&
    data.order_payload.items.length
  ) {
    const first = data.order_payload.items[0] || {};
    rawBizId =
      first.business_id ??
      first.businessId ??
      first.business?.business_id ??
      null;
  }

  if (rawBizId == null) return null;

  const n = Number(rawBizId);
  return Number.isFinite(n) ? n : null;
}

async function addScheduledOrder(scheduledAtInput, orderPayload, userId) {
  const jobId = await generateScheduledId();
  const now = new Date();

  const epochMs = parseScheduledToEpochMs(scheduledAtInput);
  if (!Number.isFinite(epochMs)) {
    throw new Error("Invalid scheduled_at. Cannot parse scheduled time.");
  }

  const scheduled_at = new Date(epochMs).toISOString();
  const scheduled_at_local = epochToBhutanIso(epochMs);

  const tmpData = { order_payload: orderPayload };
  const businessId = extractBusinessIdFromJob(tmpData);

  const accept_expires_at = new Date(Date.now() + ACCEPT_TIMEOUT_MS).toISOString();
  const accept_expires_epoch_ms = Date.now() + ACCEPT_TIMEOUT_MS;

  const payload = {
    job_id: jobId,
    user_id: userId,
    business_id: businessId ?? null,

    scheduled_at,
    scheduled_at_local,
    scheduled_epoch_ms: epochMs,

    accept_expires_at,
    accept_expires_epoch_ms,

    created_at: now.toISOString(),

    order_payload: {
      user_id: userId,
      ...orderPayload,
      status: "PENDING",
    },
  };

  const jobKey = buildJobKey(jobId);

  await redis
    .multi()
    .set(jobKey, JSON.stringify(payload))
    // Pending queue score = when merchant acceptance expires.
    .zadd(PENDING_ZSET_KEY, accept_expires_epoch_ms, jobId)
    // Legacy cleanup safety: remove from old mixed queue if accidentally present.
    .zrem(ZSET_KEY, jobId)
    .zrem(ACCEPTED_ZSET_KEY, jobId)
    .zrem(REJECTED_ZSET_KEY, jobId)
    .exec();

  return payload;
}

async function readJobsFromQueues(queueKeys, { futureOnly = false } = {}) {
  const nowTs = Date.now();
  const ids = new Set();

  for (const key of queueKeys) {
    let jobIds = [];

    if (futureOnly) {
      jobIds = await redis.zrangebyscore(key, nowTs, "+inf", "LIMIT", 0, 300);
    } else {
      jobIds = await redis.zrange(key, 0, -1);
    }

    jobIds.forEach((id) => ids.add(id));
  }

  const uniqueJobIds = [...ids];
  if (!uniqueJobIds.length) return [];

  const pipeline = redis.pipeline();
  uniqueJobIds.forEach((jobId) => pipeline.get(buildJobKey(jobId)));

  const results = await pipeline.exec();

  const list = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;

    try {
      const data = JSON.parse(raw);
      if (!data.business_id) {
        const bizId = extractBusinessIdFromJob(data);
        if (bizId != null) data.business_id = bizId;
      }

      list.push(data);
    } catch {}
  }

  list.sort((a, b) => {
    const aTime = a.scheduled_epoch_ms ?? 0;
    const bTime = b.scheduled_epoch_ms ?? 0;
    return aTime - bTime;
  });

  return list;
}

async function getScheduledOrdersByUser(userId) {
  const allJobs = await readJobsFromQueues([
    PENDING_ZSET_KEY,
    ACCEPTED_ZSET_KEY,
    REJECTED_ZSET_KEY,
    ZSET_KEY, // legacy support
  ]);

  return allJobs.filter((job) => Number(job.user_id) === Number(userId));
}

async function getScheduledOrdersByBusiness(businessId) {
  const allJobs = await readJobsFromQueues([
    PENDING_ZSET_KEY,
    ACCEPTED_ZSET_KEY,
    REJECTED_ZSET_KEY,
    ZSET_KEY, // legacy support
  ]);

  return allJobs.filter((job) => {
    const jobBizId = extractBusinessIdFromJob(job);
    return Number(jobBizId) === Number(businessId);
  });
}

async function cancelScheduledOrderForUser(jobId, userId) {
  const jobKey = buildJobKey(jobId);
  const raw = await redis.get(jobKey);

  if (!raw) return false;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }

  if (Number(data.user_id) !== Number(userId)) return false;

  await redis
    .multi()
    .del(jobKey)
    .zrem(PENDING_ZSET_KEY, jobId)
    .zrem(ACCEPTED_ZSET_KEY, jobId)
    .zrem(REJECTED_ZSET_KEY, jobId)
    .zrem(ZSET_KEY, jobId)
    .del(buildLockKey(jobId))
    .del(buildAttemptsKey(jobId))
    .del(buildErrorKey(jobId))
    .exec();

  return true;
}

module.exports = {
  addScheduledOrder,
  getScheduledOrdersByUser,
  getScheduledOrdersByBusiness,
  cancelScheduledOrderForUser,

  ZSET_KEY,
  PENDING_ZSET_KEY,
  ACCEPTED_ZSET_KEY,
  REJECTED_ZSET_KEY,

  buildJobKey,
  buildLockKey,
  buildAttemptsKey,
  buildErrorKey,

  parseScheduledToEpochMs,
  epochToBhutanIso,
  extractBusinessIdFromJob,
};