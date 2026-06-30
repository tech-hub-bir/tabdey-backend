const { prisma } = require("../lib/prisma");
const moment = require("moment-timezone");
const { getRedis } = require("../config/redis");

const redis = getRedis();

/* ---------- helpers ---------- */
function toIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function formatDate(date) {
  if (!date) return null;
  return moment(date).tz("Asia/Thimphu").toISOString();
}

function hoursAgoFromMillis(ms) {
  if (!ms) return null;
  const now = moment.tz("Asia/Thimphu");
  const c = moment.tz(ms, "Asia/Thimphu");
  if (!c.isValid()) return null;
  const diff = now.diff(c, "hours");
  return diff >= 0 ? diff : 0;
}

async function assertBusinessExists(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
  });
  if (!business) throw new Error("Business not found");
  return business;
}

async function getOwnerTypeForBusiness(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: { owner_type: true },
  });
  if (!business) return "unknown";
  const raw = String(business.owner_type || "").trim().toLowerCase();
  if (raw === "food" || raw === "mart" || raw === "both") return raw;
  return "unknown";
}

/* ---------- Redis keys (replies) ---------- */
const REPLY_SEQ_KEY = "rating:reply:seq";
function replyKey(replyId) {
  return `rating:reply:${replyId}`;
}
function replyIndexKey(rating_type, rating_id) {
  return `rating:replies:idx:${rating_type}:${rating_id}`;
}

/* ---------- Redis keys (reports) ---------- */
const REPORT_SEQ_KEY = "rating:report:seq";
function reportKey(id) {
  return `rating:report:${id}`;
}
function reportIndexKey(type, target) {
  return `rating:reports:idx:${type}:${target}`;
}
function reportDedupKey(type, target, targetId, reporterUserId) {
  return `rating:reports:dedup:${type}:${target}:${targetId}:${reporterUserId}`;
}
function reportByTargetKey(type, target, targetId) {
  return `rating:reports:by_target:${type}:${target}:${targetId}`;
}

/* ---------- fetch replies for ratings ---------- */
async function fetchRepliesForRatings(ownerType, ratingRows) {
  const result = {};
  const allUserIds = new Set();

  for (const row of ratingRows) {
    const ratingId = row.id;
    const t = (row.owner_type && row.owner_type.toLowerCase()) ||
              (ownerType && ownerType.toLowerCase()) ||
              "food";

    const idxKey = replyIndexKey(t, ratingId);
    const replyIds = await redis.zrevrange(idxKey, 0, -1);

    if (!replyIds || replyIds.length === 0) {
      result[ratingId] = [];
      continue;
    }

    const replies = [];
    for (const repId of replyIds) {
      const hKey = replyKey(repId);
      const data = await redis.hgetall(hKey);
      if (!data || Object.keys(data).length === 0) continue;

      const user_id = Number(data.user_id || 0);
      if (user_id > 0) allUserIds.add(user_id);

      const ts = Number(data.created_at || data.ts || 0);

      replies.push({
        id: Number(data.id || repId),
        rating_type: data.rating_type || t,
        rating_id: Number(data.rating_id || ratingId),
        business_id: data.business_id ? Number(data.business_id) : Number(row.business_id),
        user_id,
        text: data.text || "",
        ts,
        hours_ago: hoursAgoFromMillis(ts),
        user: null,
      });
    }

    replies.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    result[ratingId] = replies;
  }

  if (allUserIds.size > 0) {
    const users = await prisma.users.findMany({
      where: { user_id: { in: Array.from(allUserIds) } },
      select: { user_id: true, user_name: true, profile_image: true },
    });
    const userMap = {};
    for (const u of users) {
      userMap[u.user_id] = {
        user_id: u.user_id,
        user_name: u.user_name || null,
        profile_image: u.profile_image || null,
      };
    }

    for (const ratingId of Object.keys(result)) {
      const replies = result[ratingId];
      for (const r of replies) {
        r.user = userMap[r.user_id] || null;
      }
    }
  }

  return result;
}

/* ---------- main ratings fetch ---------- */
async function fetchBusinessRatingsAuto(business_id, { page = 1, limit = 20 } = {}) {
  try {
    const bid = toIntOrThrow(business_id, "business_id must be a positive integer");
    await assertBusinessExists(bid);

    const p = clamp(Number(page) || 1, 1, 1e9);
    const l = clamp(Number(limit) || 20, 1, 100);
    const offset = (p - 1) * l;

    const ownerType = await getOwnerTypeForBusiness(bid);

    let ratings = [];
    let agg = { avg_rating: 0, total_ratings: 0, total_comments: 0, stars_5: 0, stars_4: 0, stars_3: 0, stars_2: 0, stars_1: 0 };

    if (ownerType === "food") {
      // Get ratings from food_ratings
      ratings = await prisma.food_ratings.findMany({
        where: { business_id: bid },
        orderBy: { created_at: "desc" },
        skip: offset,
        take: l,
        include: { users: { select: { user_name: true, profile_image: true } } }
      });

      const allRatings = await prisma.food_ratings.findMany({
        where: { business_id: bid },
        select: { rating: true, comment: true }
      });
      agg = calculateAggregates(allRatings);

    } else if (ownerType === "mart") {
      ratings = await prisma.mart_ratings.findMany({
        where: { business_id: bid },
        orderBy: { created_at: "desc" },
        skip: offset,
        take: l,
        include: { users: { select: { user_name: true, profile_image: true } } }
      });

      const allRatings = await prisma.mart_ratings.findMany({
        where: { business_id: bid },
        select: { rating: true, comment: true }
      });
      agg = calculateAggregates(allRatings);

    } else {
      // Both types - fetch from both tables
      const foodRatings = await prisma.food_ratings.findMany({
        where: { business_id: bid },
        include: { users: { select: { user_name: true, profile_image: true } } }
      });
      const martRatings = await prisma.mart_ratings.findMany({
        where: { business_id: bid },
        include: { users: { select: { user_name: true, profile_image: true } } }
      });

      const allCombined = [...foodRatings, ...martRatings];
      ratings = allCombined
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(offset, offset + l);

      const allRatingsData = allCombined.map(r => ({ rating: r.rating, comment: r.comment }));
      agg = calculateAggregates(allRatingsData);
    }

    // Format ratings with user info
    const formattedRatings = ratings.map(r => ({
      id: r.id,
      business_id: r.business_id,
      owner_type: ownerType,
      user: {
        user_id: r.user_id,
        user_name: r.users?.user_name || null,
        profile_image: r.users?.profile_image || null,
      },
      rating: r.rating,
      comment: r.comment,
      likes_count: Number(r.likes_count ?? 0),
      created_at: formatDate(r.created_at),
      hours_ago: hoursAgoFromMillis(new Date(r.created_at).getTime()),
    }));

    const repliesByRating = await fetchRepliesForRatings(ownerType, formattedRatings);

    const items = formattedRatings.map(r => ({
      ...r,
      reply_count: (repliesByRating[r.id] || []).length,
      replies: repliesByRating[r.id] || [],
    }));

    return {
      success: true,
      data: items,
      meta: {
        business_id: bid,
        owner_type: ownerType,
        page: p,
        limit: l,
        totals: {
          avg_rating: agg.avg_rating,
          total_ratings: agg.total_ratings,
          total_comments: agg.total_comments,
          by_stars: {
            5: agg.stars_5,
            4: agg.stars_4,
            3: agg.stars_3,
            2: agg.stars_2,
            1: agg.stars_1,
          },
        },
      },
    };
  } catch (error) {
    console.error("fetchBusinessRatingsAuto error:", error);
    throw error;
  }
}

function calculateAggregates(ratings) {
  let totalRating = 0;
  let totalRatings = ratings.length;
  let totalComments = 0;
  let stars_5 = 0, stars_4 = 0, stars_3 = 0, stars_2 = 0, stars_1 = 0;

  for (const r of ratings) {
    totalRating += r.rating;
    if (r.comment && r.comment.trim()) totalComments++;
    
    switch (r.rating) {
      case 5: stars_5++; break;
      case 4: stars_4++; break;
      case 3: stars_3++; break;
      case 2: stars_2++; break;
      case 1: stars_1++; break;
    }
  }

  const avgRating = totalRatings > 0 ? totalRating / totalRatings : 0;

  return {
    avg_rating: parseFloat(avgRating.toFixed(2)),
    total_ratings: totalRatings,
    total_comments: totalComments,
    stars_5,
    stars_4,
    stars_3,
    stars_2,
    stars_1,
  };
}

/* ---------- like / unlike ---------- */
async function likeFoodRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const rating = await prisma.food_ratings.findUnique({
    where: { id: rid },
    select: { id: true, business_id: true, likes_count: true }
  });

  if (!rating) throw new Error("Food rating not found");

  const updated = await prisma.food_ratings.update({
    where: { id: rid },
    data: { likes_count: { increment: 1 } },
    select: { id: true, business_id: true, likes_count: true }
  });

  return {
    success: true,
    data: {
      id: updated.id,
      business_id: updated.business_id,
      likes_count: Number(updated.likes_count ?? 0),
    },
  };
}

async function unlikeFoodRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const rating = await prisma.food_ratings.findUnique({
    where: { id: rid },
    select: { id: true, business_id: true, likes_count: true }
  });

  if (!rating) throw new Error("Food rating not found");

  const updated = await prisma.food_ratings.update({
    where: { id: rid },
    data: { likes_count: { decrement: 1 } },
    select: { id: true, business_id: true, likes_count: true }
  });

  return {
    success: true,
    data: {
      id: updated.id,
      business_id: updated.business_id,
      likes_count: Math.max(Number(updated.likes_count ?? 0), 0),
    },
  };
}

async function likeMartRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const rating = await prisma.mart_ratings.findUnique({
    where: { id: rid },
    select: { id: true, business_id: true, likes_count: true }
  });

  if (!rating) throw new Error("Mart rating not found");

  const updated = await prisma.mart_ratings.update({
    where: { id: rid },
    data: { likes_count: { increment: 1 } },
    select: { id: true, business_id: true, likes_count: true }
  });

  return {
    success: true,
    data: {
      id: updated.id,
      business_id: updated.business_id,
      likes_count: Number(updated.likes_count ?? 0),
    },
  };
}

async function unlikeMartRating(rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");

  const rating = await prisma.mart_ratings.findUnique({
    where: { id: rid },
    select: { id: true, business_id: true, likes_count: true }
  });

  if (!rating) throw new Error("Mart rating not found");

  const updated = await prisma.mart_ratings.update({
    where: { id: rid },
    data: { likes_count: { decrement: 1 } },
    select: { id: true, business_id: true, likes_count: true }
  });

  return {
    success: true,
    data: {
      id: updated.id,
      business_id: updated.business_id,
      likes_count: Math.max(Number(updated.likes_count ?? 0), 0),
    },
  };
}

/* ---------- replies (Redis-backed) ---------- */
async function assertRatingExistsAndGetBusiness(rating_type, rating_id) {
  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  let rating = null;

  if (rating_type === "food") {
    rating = await prisma.food_ratings.findUnique({
      where: { id: rid },
      select: { id: true, business_id: true }
    });
  } else {
    rating = await prisma.mart_ratings.findUnique({
      where: { id: rid },
      select: { id: true, business_id: true }
    });
  }

  if (!rating) {
    const err = new Error(`${rating_type} rating not found`);
    err.code = "RATING_NOT_FOUND";
    throw err;
  }
  return { rating_id: rid, business_id: rating.business_id };
}

async function createRatingReply({ rating_type, rating_id, user_id, text }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");
  const { rating_id: rid, business_id } = await assertRatingExistsAndGetBusiness(type, rating_id);

  const now = Date.now();
  const newId = await redis.incr(REPLY_SEQ_KEY);
  const key = replyKey(newId);
  const idxKey = replyIndexKey(type, rid);

  await redis
    .multi()
    .hmset(key, {
      id: String(newId),
      rating_type: type,
      rating_id: String(rid),
      business_id: String(business_id),
      user_id: String(uid),
      text: String(text),
      created_at: String(now),
      updated_at: String(now),
    })
    .zadd(idxKey, now, String(newId))
    .exec();

  return {
    success: true,
    data: {
      id: newId,
      rating_type: type,
      rating_id: rid,
      business_id,
      user_id: uid,
      text,
      created_at: now,
      updated_at: now,
    },
  };
}

async function listRatingReplies({ rating_type, rating_id, page = 1, limit = 20 }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  await assertRatingExistsAndGetBusiness(type, rid);

  const p = clamp(Number(page) || 1, 1, 1e9);
  const l = clamp(Number(limit) || 20, 1, 100);
  const start = (p - 1) * l;
  const stop = start + l - 1;

  const idxKey = replyIndexKey(type, rid);

  const [ids, totalStr] = await Promise.all([
    redis.zrevrange(idxKey, start, stop),
    redis.zcard(idxKey),
  ]);

  const total = Number(totalStr || 0);

  if (!ids.length) {
    return {
      success: true,
      data: [],
      meta: { rating_type: type, rating_id: rid, page: p, limit: l, total },
    };
  }

  const pipe = redis.multi();
  ids.forEach((id) => pipe.hgetall(replyKey(id)));
  const rowsArr = await pipe.exec();

  const data = [];
  const userIds = new Set();

  for (let i = 0; i < ids.length; i++) {
    const [err, row] = rowsArr[i];
    if (err || !row || !row.id) continue;

    const createdAt = Number(row.created_at || Date.now());
    const item = {
      id: Number(row.id),
      rating_type: row.rating_type,
      rating_id: Number(row.rating_id),
      business_id: row.business_id ? Number(row.business_id) : null,
      user_id: Number(row.user_id),
      text: row.text,
      created_at: createdAt,
      updated_at: Number(row.updated_at || createdAt),
      hours_ago: hoursAgoFromMillis(createdAt),
      user: null,
    };

    if (item.user_id > 0) userIds.add(item.user_id);
    data.push(item);
  }

  if (userIds.size > 0) {
    const users = await prisma.users.findMany({
      where: { user_id: { in: Array.from(userIds) } },
      select: { user_id: true, user_name: true, profile_image: true },
    });

    const userMap = {};
    for (const u of users) {
      userMap[u.user_id] = {
        user_id: u.user_id,
        user_name: u.user_name || null,
        profile_image: u.profile_image || null,
      };
    }

    for (const reply of data) {
      reply.user = userMap[reply.user_id] || null;
    }
  }

  return {
    success: true,
    data,
    meta: { rating_type: type, rating_id: rid, page: p, limit: l, total },
  };
}

async function deleteRatingReply({ reply_id, user_id }) {
  const rid = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");

  const key = replyKey(rid);
  const row = await redis.hgetall(key);

  if (!row || !row.id) {
    const err = new Error("Reply not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const ownerId = Number(row.user_id || 0);
  if (ownerId !== uid) {
    const err = new Error("You are not allowed to delete this reply");
    err.code = "FORBIDDEN";
    throw err;
  }

  const type = row.rating_type;
  const ratingId = row.rating_id;
  const idxKey = replyIndexKey(type, ratingId);

  await redis.multi().del(key).zrem(idxKey, String(rid)).exec();

  return {
    success: true,
    message: "Reply deleted",
    data: { id: rid, rating_type: type, rating_id: Number(ratingId) },
  };
}

async function deleteRatingWithReplies({ rating_type, rating_id, user_id }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  const uid = toIntOrThrow(user_id, "user_id must be a positive integer");

  let rating = null;
  if (type === "food") {
    rating = await prisma.food_ratings.findUnique({
      where: { id: rid },
      select: { id: true, business_id: true, user_id: true }
    });
  } else {
    rating = await prisma.mart_ratings.findUnique({
      where: { id: rid },
      select: { id: true, business_id: true, user_id: true }
    });
  }

  if (!rating) {
    const err = new Error(`${type} rating not found`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const ownerId = Number(rating.user_id || 0);
  if (ownerId !== uid) {
    const err = new Error("You are not allowed to delete this rating");
    err.code = "FORBIDDEN";
    throw err;
  }

  // Delete from database
  if (type === "food") {
    await prisma.food_ratings.delete({ where: { id: rid } });
  } else {
    await prisma.mart_ratings.delete({ where: { id: rid } });
  }

  // Delete replies from Redis
  const idxKey = replyIndexKey(type, rid);
  const replyIds = await redis.zrange(idxKey, 0, -1);

  const multi = redis.multi();
  if (replyIds && replyIds.length > 0) {
    for (const replId of replyIds) multi.del(replyKey(replId));
  }
  multi.del(idxKey);
  await multi.exec();

  return {
    success: true,
    message: "Rating and its replies deleted successfully.",
    data: {
      rating_type: type,
      rating_id: rid,
      deleted_replies: replyIds ? replyIds.length : 0,
    },
  };
}

/* ---------- reports ---------- */
async function loadRatingRow(type, rating_id) {
  let rating = null;
  if (type === "food") {
    rating = await prisma.food_ratings.findUnique({
      where: { id: rating_id },
      select: { id: true, business_id: true, user_id: true, comment: true, created_at: true }
    });
  } else {
    rating = await prisma.mart_ratings.findUnique({
      where: { id: rating_id },
      select: { id: true, business_id: true, user_id: true, comment: true, created_at: true }
    });
  }

  if (!rating) {
    const err = new Error(`${type} rating not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return rating;
}

async function loadReplyRow(reply_id) {
  const rid = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const row = await redis.hgetall(replyKey(rid));
  if (!row || !row.id) {
    const err = new Error("Reply not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  return {
    id: Number(row.id),
    rating_type: String(row.rating_type || "").toLowerCase(),
    rating_id: Number(row.rating_id || 0),
    business_id: Number(row.business_id || 0),
    user_id: Number(row.user_id || 0),
    text: row.text || "",
    created_at: Number(row.created_at || 0),
  };
}

async function reportRating({ rating_type, rating_id, reporter_user_id, reason }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const rid = toIntOrThrow(rating_id, "rating_id must be a positive integer");
  const uid = toIntOrThrow(reporter_user_id, "reporter_user_id must be a positive integer");

  const dedup = reportDedupKey(type, "comment", rid, uid);
  const already = await redis.get(dedup);
  if (already) {
    const err = new Error("You already reported this rating");
    err.code = "DUPLICATE";
    throw err;
  }

  const rating = await loadRatingRow(type, rid);

  const now = Date.now();
  const newId = await redis.incr(REPORT_SEQ_KEY);

  const key = reportKey(newId);
  const idxKey = reportIndexKey(type, "comment");
  const byTarget = reportByTargetKey(type, "comment", rid);

  await redis
    .multi()
    .set(dedup, "1", "EX", 60 * 60 * 24 * 30)
    .hmset(key, {
      id: String(newId),
      type,
      target: "comment",
      rating_id: String(rid),
      reply_id: "",
      business_id: String(rating.business_id || ""),
      reported_user_id: String(rating.user_id || ""),
      reporter_user_id: String(uid),
      reason: String(reason),
      reported_text: String(rating.comment || ""),
      created_at: String(now),
      status: "open",
    })
    .zadd(idxKey, now, String(newId))
    .sadd(byTarget, String(newId))
    .exec();

  return {
    success: true,
    message: "Reported successfully",
    data: {
      report_id: newId,
      type,
      target: "comment",
      rating_id: rid,
      reason,
      reported_text: rating.comment || "",
    },
  };
}

async function reportReply({ rating_type, reply_id, reporter_user_id, reason }) {
  const type = String(rating_type || "").toLowerCase();
  if (type !== "food" && type !== "mart") {
    throw new Error("rating_type must be 'food' or 'mart'");
  }

  const repId = toIntOrThrow(reply_id, "reply_id must be a positive integer");
  const uid = toIntOrThrow(reporter_user_id, "reporter_user_id must be a positive integer");

  const dedup = reportDedupKey(type, "reply", repId, uid);
  const already = await redis.get(dedup);
  if (already) {
    const err = new Error("You already reported this reply");
    err.code = "DUPLICATE";
    throw err;
  }

  const replyRow = await loadReplyRow(repId);

  const now = Date.now();
  const newId = await redis.incr(REPORT_SEQ_KEY);

  const key = reportKey(newId);
  const idxKey = reportIndexKey(type, "reply");
  const byTarget = reportByTargetKey(type, "reply", repId);

  await redis
    .multi()
    .set(dedup, "1", "EX", 60 * 60 * 24 * 30)
    .hmset(key, {
      id: String(newId),
      type,
      target: "reply",
      rating_id: String(replyRow.rating_id || ""),
      reply_id: String(repId),
      business_id: String(replyRow.business_id || ""),
      reported_user_id: String(replyRow.user_id || ""),
      reporter_user_id: String(uid),
      reason: String(reason),
      reported_text: String(replyRow.text || ""),
      created_at: String(now),
      status: "open",
    })
    .zadd(idxKey, now, String(newId))
    .sadd(byTarget, String(newId))
    .exec();

  return {
    success: true,
    message: "Reported successfully",
    data: {
      report_id: newId,
      type,
      target: "reply",
      reply_id: repId,
      reason,
      reported_text: replyRow.text || "",
    },
  };
}

module.exports = {
  fetchBusinessRatingsAuto,
  likeFoodRating,
  unlikeFoodRating,
  likeMartRating,
  unlikeMartRating,
  createRatingReply,
  listRatingReplies,
  deleteRatingReply,
  deleteRatingWithReplies,
  reportRating,
  reportReply,
};