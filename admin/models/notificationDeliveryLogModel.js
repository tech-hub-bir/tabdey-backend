// models/notificationDeliveryLogModel.js
const { getRedis } = require("../config/redis");
const redis = getRedis();

/* ---------- keys ---------- */
const SEQ_KEY = "sysnotif:delivery:seq";
const GLOBAL_IDX = "sysnotif:delivery:idx";
const SINGLE_USER_IDX_PREFIX = "sysnotif:delivery:idx:single:user:"; // zset per target_user_id

function logKey(id) {
  return `sysnotif:delivery:${id}`;
}
function channelIdx(channel) {
  return `sysnotif:delivery:idx:channel:${channel}`;
}
function userIdx(userId) {
  return `sysnotif:delivery:idx:user:${userId}`;
}
function singleUserIdx(userId) {
  return `${SINGLE_USER_IDX_PREFIX}${userId}`;
}

/* ---------- helpers ---------- */
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function safeJson(s, fallback) {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return fallback;
  }
}
function toIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(msg);
  return Math.trunc(n);
}

/* ======================================================
   Create delivery log (Redis)
   ✅ We will store all logs as before, BUT:
   - context="single" => also index in singleUserIdx(target_user_id)
====================================================== */
async function createDeliveryLog({
  channel, // "email" | "sms"
  target_user_id = null,
  target = "", // email/phone or roles:...
  title = "",
  message = "",
  status = "sent", // sent|failed|skipped
  reason = "",
  created_by = null,
  admin_name = "System",
  notification_id = null,
  context = "single", // single|roles
  roles = [],
  ttlDays = 30,
}) {
  const now = Date.now();
  const id = await redis.incr(SEQ_KEY);
  const k = logKey(id);

  const payload = {
    id: String(id),
    channel: String(channel || "").toLowerCase(),
    target_user_id: target_user_id != null ? String(target_user_id) : "",
    target: String(target || ""),
    title: String(title || ""),
    message: String(message || ""),
    status: String(status || "sent"),
    reason: String(reason || ""),
    created_by: created_by != null ? String(created_by) : "",
    admin_name: String(admin_name || "System"),
    notification_id: notification_id != null ? String(notification_id) : "",
    context: String(context || "single"),
    roles: JSON.stringify(Array.isArray(roles) ? roles : []),
    created_at: String(now),
  };

  const multi = redis.multi();
  multi.hset(k, payload);

  // indexes (existing)
  multi.zadd(GLOBAL_IDX, now, String(id));
  if (payload.channel) multi.zadd(channelIdx(payload.channel), now, String(id));
  if (payload.target_user_id)
    multi.zadd(userIdx(payload.target_user_id), now, String(id));

  // ✅ NEW: only single-user logs go here (so fetch API won't include bulk)
  if (payload.context === "single" && payload.target_user_id) {
    multi.zadd(singleUserIdx(payload.target_user_id), now, String(id));
  }

  if (ttlDays && Number(ttlDays) > 0) {
    multi.expire(k, Number(ttlDays) * 24 * 60 * 60);
  }

  await multi.exec();
  return { id, created_at: now };
}

/* ======================================================
   List ONLY single-user logs by target_user_id
   (bulk/roles never included)
====================================================== */
async function listSingleUserLogsByTargetUserId({
  target_user_id,
  page = 1,
  limit = 20,
}) {
  const uid = toIntOrThrow(
    target_user_id,
    "target_user_id must be a positive number"
  );

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);

  const idxKey = singleUserIdx(String(uid));
  const start = (p - 1) * l;
  const stop = start + l - 1;

  const [ids, totalStr] = await Promise.all([
    redis.zrevrange(idxKey, start, stop),
    redis.zcard(idxKey),
  ]);

  const total = Number(totalStr || 0);
  if (!ids.length) {
    return {
      data: [],
      meta: { target_user_id: uid, page: p, limit: l, total },
    };
  }

  const pipe = redis.multi();
  ids.forEach((id) => pipe.hgetall(logKey(id)));
  const rowsArr = await pipe.exec();

  const data = [];
  for (const [err, row] of rowsArr) {
    if (err) continue;
    if (!row || !row.id) continue; // expired/missing
    // safety: ensure it's single (should be, due to index)
    if (String(row.context || "") !== "single") continue;

    data.push({
      id: Number(row.id),
      channel: row.channel,
      target_user_id: row.target_user_id ? Number(row.target_user_id) : null,
      target: row.target,
      title: row.title,
      message: row.message,
      status: row.status,
      reason: row.reason,
      created_by: row.created_by ? Number(row.created_by) : null,
      admin_name: row.admin_name,
      notification_id: row.notification_id ? Number(row.notification_id) : null,
      context: row.context,
      roles: row.roles ? safeJson(row.roles, []) : [],
      created_at: row.created_at ? Number(row.created_at) : null,
    });
  }

  return { data, meta: { target_user_id: uid, page: p, limit: l, total } };
}

module.exports = {
  createDeliveryLog,

  // existing (kept, even if you don't use them)
  // getDeliveryLogById,
  // listDeliveryLogs,

  // ✅ NEW
  listSingleUserLogsByTargetUserId,
};
