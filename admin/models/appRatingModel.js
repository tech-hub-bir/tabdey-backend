const { prisma } = require("../lib/prisma.js");
const { getRedis } = require("../config/redis");

const redis = getRedis();

/* ---------------- Redis compatibility helpers ---------------- */

async function rCall(obj, candidates, ...args) {
  for (const name of candidates) {
    if (obj && typeof obj[name] === "function") {
      return obj[name](...args);
    }
  }
  throw new Error(`Redis client missing method: ${candidates[0]}`);
}

const R = {
  zrevrange: (key, start, stop) =>
    rCall(redis, ["zrevrange", "zRevRange"], key, start, stop),
  zrange: (key, start, stop) =>
    rCall(redis, ["zrange", "zRange"], key, start, stop),
  zcard: (key) => rCall(redis, ["zcard", "zCard"], key),
  zrem: (key, member) => rCall(redis, ["zrem", "zRem"], key, member),
  hgetall: (key) => rCall(redis, ["hgetall", "hGetAll"], key),
  hset: (key, ...kv) => rCall(redis, ["hset", "hSet"], key, ...kv),
  del: (key) => rCall(redis, ["del"], key),
  multi: () => {
    if (redis && typeof redis.multi === "function") return redis.multi();
    throw new Error("Redis client missing multi()");
  },
};

function normalizeExecResult(execRes) {
  if (!Array.isArray(execRes)) return [];
  if (execRes.length && Array.isArray(execRes[0]) && execRes[0].length === 2) {
    return execRes;
  }
  return execRes.map((v) => [null, v]);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ---------------- Pure Prisma App Rating Functions ---------------- */

async function createAppRating({
  user_id = null,
  role = null,
  rating,
  comment = null,
  platform = null,
  os_version = null,
  app_version = null,
  device_model = null,
  network_type = null,
}) {
  const result = await prisma.app_ratings.create({
    data: {
      user_id: user_id ? Number(user_id) : null,
      role: role,
      rating: rating,
      comment: comment,
      platform: platform,
      os_version: os_version,
      app_version: app_version,
      device_model: device_model,
      network_type: network_type,
      created_at: new Date(),
    },
  });

  // Convert BigInt to Number
  return {
    ...result,
    id: Number(result.id),
    user_id: result.user_id ? Number(result.user_id) : null,
  };
}

async function getAppRatingById(id) {
  const result = await prisma.app_ratings.findUnique({
    where: { id: Number(id) },
  });

  if (!result) return null;

  return {
    ...result,
    id: Number(result.id),
    user_id: result.user_id ? Number(result.user_id) : null,
  };
}

async function listAppRatings(filters = {}) {
  const {
    minRating,
    maxRating,
    platform,
    appVersion,
    limit = 50,
    offset = 0,
  } = filters;

  const where = {};

  if (minRating != null) {
    where.rating = { gte: minRating };
  }
  if (maxRating != null) {
    where.rating = { ...where.rating, lte: maxRating };
  }
  if (platform) {
    where.platform = platform;
  }
  if (appVersion) {
    where.app_version = appVersion;
  }

  const results = await prisma.app_ratings.findMany({
    where,
    orderBy: {
      created_at: "desc",
    },
    skip: Number(offset),
    take: Number(limit),
  });

  return results.map((r) => ({
    ...r,
    id: Number(r.id),
    user_id: r.user_id ? Number(r.user_id) : null,
  }));
}

async function updateAppRating(id, fields = {}) {
  const allowed = ["rating", "comment"];
  const data = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      data[key] = fields[key];
    }
  }

  if (Object.keys(data).length === 0) return { affectedRows: 0 };

  const result = await prisma.app_ratings.update({
    where: { id: Number(id) },
    data,
  });

  return { affectedRows: 1 };
}

async function deleteAppRating(id) {
  const result = await prisma.app_ratings.delete({
    where: { id: Number(id) },
  });
  return { affectedRows: 1 };
}

async function getAppRatingSummary() {
  const totals = await prisma.app_ratings.aggregate({
    _count: { id: true },
    _avg: { rating: true },
  });

  const breakdown = await prisma.app_ratings.groupBy({
    by: ["rating"],
    _count: { rating: true },
    orderBy: { rating: "desc" },
  });

  return {
    total_ratings: totals._count.id || 0,
    avg_rating: totals._avg.rating ? Number(totals._avg.rating) : 0,
    breakdown: breakdown.map((row) => ({
      rating: row.rating,
      count: row._count.rating,
    })),
  };
}

/* ---------------- Helper: Hydrate User Info ---------------- */

async function hydrateUsers(ids) {
  const clean = (ids || []).map((x) => Number(x)).filter((x) => x > 0);
  if (!clean.length) return {};

  const users = await prisma.users.findMany({
    where: { user_id: { in: clean } },
    select: {
      user_id: true,
      user_name: true,
      phone: true,
      email: true,
      profile_image: true,
      role: true,
    },
  });

  const map = {};
  for (const u of users) {
    map[Number(u.user_id)] = {
      user_id: Number(u.user_id),
      user_name: u.user_name || null,
      phone: u.phone || null,
      email: u.email || null,
      profile_image: u.profile_image || null,
      role: u.role || null,
    };
  }
  return map;
}

/* ---------------- Redis-based Report Functions (remain the same) ---------------- */

const FOOD_TBL = "food_ratings";
const MART_TBL = "mart_ratings";

function replyKey(replyId) {
  return `rating:reply:${replyId}`;
}

function replyIndexKey(rating_type, rating_id) {
  return `rating:replies:idx:${rating_type}:${rating_id}`;
}

function reportKey(id) {
  return `rating:report:${id}`;
}

function reportIndexKey(type, target) {
  return `rating:reports:idx:${type}:${target}`;
}

async function listMerchantReports({ type, target, page = 1, limit = 20 }) {
  const t = String(type || "").toLowerCase();
  const trg = String(target || "").toLowerCase();

  if (t !== "food" && t !== "mart")
    throw new Error("type must be food or mart");
  if (trg !== "comment" && trg !== "reply")
    throw new Error("target must be comment or reply");

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);
  const start = (p - 1) * l;
  const stop = start + l - 1;

  const idxKey = reportIndexKey(t, trg);

  const [ids, total] = await Promise.all([
    R.zrevrange(idxKey, start, stop),
    R.zcard(idxKey),
  ]);

  if (!ids || !ids.length) {
    return {
      success: true,
      data: [],
      meta: {
        type: t,
        target: trg,
        page: p,
        limit: l,
        total: Number(total || 0),
      },
    };
  }

  const pipe = R.multi();
  ids.forEach((id) => {
    if (typeof pipe.hgetall === "function") pipe.hgetall(reportKey(id));
    else if (typeof pipe.hGetAll === "function") pipe.hGetAll(reportKey(id));
  });

  const execRes = await pipe.exec();
  const results = normalizeExecResult(execRes);

  const rows = [];
  const userIds = new Set();

  for (let i = 0; i < ids.length; i++) {
    const [, h] = results[i] || [];
    if (!h || !h.id) continue;

    const status = String(h.status || "open").toLowerCase();
    if (status !== "open") continue;

    const reporter = toInt(h.reporter_user_id);
    const reported = toInt(h.reported_user_id);
    if (reporter) userIds.add(reporter);
    if (reported) userIds.add(reported);

    rows.push({
      report_id: toInt(h.id),
      type: String(h.type || t),
      target: String(h.target || trg),
      rating_id: toInt(h.rating_id),
      reply_id: toInt(h.reply_id),
      business_id: toInt(h.business_id),
      reporter_user_id: reporter,
      reported_user_id: reported,
      reason: h.reason || "",
      reported_text: h.reported_text || "",
      created_at: toInt(h.created_at),
      status,
    });
  }

  const userMap = await hydrateUsers(Array.from(userIds));

  const data = rows.map((r) => ({
    ...r,
    reporter: userMap[r.reporter_user_id] || null,
    reported_user: userMap[r.reported_user_id] || null,
  }));

  return {
    success: true,
    data,
    meta: {
      type: t,
      target: trg,
      page: p,
      limit: l,
      total: Number(total || 0),
    },
  };
}

async function ignoreMerchantReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }

  const key = reportKey(rid);
  const h = await R.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();

  await R.hset(
    key,
    "status",
    "ignored",
    "reviewed_by",
    String(admin.admin_user_id),
    "reviewed_at",
    String(Date.now()),
  );
  await R.zrem(reportIndexKey(type, target), String(rid));

  return {
    success: true,
    message: "Report ignored",
    data: {
      report_id: rid,
      status: "ignored",
      type,
      target,
      rating_id: toInt(h.rating_id),
      reply_id: toInt(h.reply_id),
    },
  };
}

async function deleteReportedMerchantCommentByReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }

  const key = reportKey(rid);
  const h = await R.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();
  const rating_id = Number(h.rating_id || 0);

  if (target !== "comment") {
    const err = new Error("This report is not for a comment");
    err.statusCode = 400;
    throw err;
  }

  const tbl = type === "mart" ? MART_TBL : FOOD_TBL;

  // Use Prisma raw query for dynamic table name (only raw SQL needed)
  const ratingExists = await prisma.$queryRawUnsafe(
    `SELECT id FROM ${tbl} WHERE id = ? LIMIT 1`,
    rating_id,
  );

  if (!ratingExists || !ratingExists.length) {
    await R.hset(
      key,
      "status",
      "deleted",
      "reviewed_by",
      String(admin.admin_user_id),
      "reviewed_at",
      String(Date.now()),
    );
    await R.zrem(reportIndexKey(type, "comment"), String(rid));

    return {
      success: true,
      message: "Comment already deleted. Report closed.",
      data: {
        report_id: rid,
        type,
        target: "comment",
        rating_id,
        deleted_replies: 0,
        status: "deleted",
      },
    };
  }

  // Delete comment row using raw SQL (dynamic table name)
  await prisma.$queryRawUnsafe(
    `DELETE FROM ${tbl} WHERE id = ? LIMIT 1`,
    rating_id,
  );

  // Delete replies from Redis
  const idxReplies = replyIndexKey(type, rating_id);
  const replyIds = await R.zrange(idxReplies, 0, -1);

  if (replyIds && replyIds.length) {
    for (const repId of replyIds) {
      await R.del(replyKey(repId));
    }
  }
  await R.del(idxReplies);

  await R.hset(
    key,
    "status",
    "deleted",
    "reviewed_by",
    String(admin.admin_user_id),
    "reviewed_at",
    String(Date.now()),
  );
  await R.zrem(reportIndexKey(type, "comment"), String(rid));

  return {
    success: true,
    message: "Reported comment deleted",
    data: {
      report_id: rid,
      type,
      target: "comment",
      rating_id,
      deleted_replies: replyIds ? replyIds.length : 0,
      status: "deleted",
    },
  };
}

async function deleteReportedMerchantReplyByReport({ report_id, admin }) {
  const rid = Number(report_id);
  if (!Number.isInteger(rid) || rid <= 0) {
    const err = new Error("Invalid report_id");
    err.statusCode = 400;
    throw err;
  }

  const key = reportKey(rid);
  const h = await R.hgetall(key);
  if (!h || !h.id) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  const type = String(h.type || "").toLowerCase();
  const target = String(h.target || "").toLowerCase();
  const reply_id = Number(h.reply_id || 0);

  if (target !== "reply") {
    const err = new Error("This report is not for a reply");
    err.statusCode = 400;
    throw err;
  }

  const repKey = replyKey(reply_id);
  const rep = await R.hgetall(repKey);

  if (rep && rep.id) {
    const rating_id = Number(rep.rating_id || 0);
    const rating_type = String(rep.rating_type || type).toLowerCase();
    if (rating_id > 0 && (rating_type === "food" || rating_type === "mart")) {
      await R.zrem(replyIndexKey(rating_type, rating_id), String(reply_id));
    }
    await R.del(repKey);
  }

  await R.hset(
    key,
    "status",
    "deleted",
    "reviewed_by",
    String(admin.admin_user_id),
    "reviewed_at",
    String(Date.now()),
  );
  await R.zrem(reportIndexKey(type, "reply"), String(rid));

  return {
    success: true,
    message: "Reported reply deleted",
    data: {
      report_id: rid,
      type,
      target: "reply",
      reply_id,
      status: "deleted",
    },
  };
}

module.exports = {
  createAppRating,
  getAppRatingById,
  listAppRatings,
  updateAppRating,
  deleteAppRating,
  getAppRatingSummary,
  listMerchantReports,
  ignoreMerchantReport,
  deleteReportedMerchantCommentByReport,
  deleteReportedMerchantReplyByReport,
};
