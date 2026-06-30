// src/routes/chatList.js
// HTTP API to list chat threads per driver / passenger.
// Uses same Redis keys + message shape as src/socket/chat.js.

import express from "express";
import { getRedis } from "../matching/redis.js";

const r = getRedis();

/* -------- Redis keys (must match chat.js) -------- */
const msgKey = (rideId) => `chat:ride:${rideId}:z`;
const readKey = (rideId, role, uid) =>
  `chat:ride:${rideId}:read:${role}:${uid}`;

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const toOut = (m) => ({
  id: Number(m.id),
  request_id: Number(m.request_id),
  sender_type: m.sender_type,
  sender_id: m.sender_id != null ? Number(m.sender_id) : null,
  message: m.message || "",
  attachments: m.attachments ?? null,
  created_at: m.created_at,
});

/**
 * Build summary for one ride chat:
 * - last_message
 * - total_messages
 * - unread (for this role/selfId)
 */
async function buildThreadSummary(rideRow, role, selfId) {
  const rideId = Number(rideRow.ride_id);
  if (!rideId) return null;

  // 1) last message (highest score)
  const lastArr = await r.zrevrange(msgKey(rideId), 0, 0);
  if (!lastArr || !lastArr.length) {
    // no chat yet for this ride
    return null;
  }

  const lastRaw = safeParse(lastArr[0]);
  if (!lastRaw) return null;

  const lastMessage = toOut(lastRaw);
  const total = await r.zcard(msgKey(rideId));

  // 2) unread count for this user
  let unread = 0;
  const readHashKey = readKey(rideId, role, selfId);
  const readInfo = await r.hgetall(readHashKey);
  const lastSeenId = Number(readInfo?.last_seen_id || 0);

  if (
    Number.isFinite(lastSeenId) &&
    lastSeenId > 0 &&
    lastMessage.id > lastSeenId
  ) {
    // Count messages with id > lastSeenId
    unread = await r.zcount(msgKey(rideId), lastSeenId + 1, "+inf");
  }

  // 3) peer info
  let peer;
  if (role === "driver") {
    peer = {
      role: "passenger",
      id: rideRow.passenger_id ? Number(rideRow.passenger_id) : null,
    };
  } else if (role === "passenger") {
    peer = {
      role: "driver",
      id: rideRow.driver_id ? Number(rideRow.driver_id) : null,
    };
  } else if (role === "merchant") {
    peer = {
      role: "driver",
      id: rideRow.driver_id ? Number(rideRow.driver_id) : null,
    };
  } else {
    peer = {
      role: "driver",
      id: rideRow.driver_id ? Number(rideRow.driver_id) : null,
    };
  }

  // 4) pick a "started_at" timestamp for sorting
  const startedAt =
    rideRow.completed_at ||
    rideRow.started_at ||
    rideRow.arrived_pickup_at ||
    rideRow.accepted_at ||
    rideRow.requested_at ||
    lastMessage.created_at;

  return {
    ride_id: rideId,
    request_id: rideId, // same as chat.js "request_id"
    started_at: startedAt,
    last_message: lastMessage,
    last_message_at: lastMessage.created_at,
    total_messages: total,
    unread,
    peer,
  };
}

/* ======================================================================= */
/*             Factory: makeChatListRouter(mysqlPool)                      */
/* ======================================================================= */

export function makeChatListRouter(mysqlPool) {
  const router = express.Router();

  /* ================= DRIVER CHAT LIST =================
   * GET /rides/driver/chat-list?driver_id=12&limit=50
   */
  router.get("/rides/driver/chat-list", async (req, res) => {
    const driverId = Number(req.query.driver_id || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!driverId) {
      return res.status(400).json({
        ok: false,
        error: "driver_id_required",
      });
    }

    let conn;
    try {
      conn = await mysqlPool.getConnection();

      // Pull recent rides for this driver
      const [rows] = await conn.query(
        `
        SELECT
          ride_id,
          driver_id,
          passenger_id,
          requested_at,
          accepted_at,
          arrived_pickup_at,
          started_at,
          completed_at
        FROM rides
        WHERE driver_id = ?
        ORDER BY COALESCE(completed_at, started_at, accepted_at, requested_at) DESC
        LIMIT ?
      `,
        [driverId, limit],
      );

      const threads = [];
      for (const row of rows) {
        const summary = await buildThreadSummary(row, "driver", driverId);
        if (summary) threads.push(summary); // only rides that actually have chat
      }

      // Sort again by last_message_at DESC just to be safe
      threads.sort((a, b) => {
        const ta = new Date(a.last_message_at).getTime();
        const tb = new Date(b.last_message_at).getTime();
        return tb - ta;
      });

      return res.json({
        ok: true,
        role: "driver",
        driver_id: driverId,
        threads,
      });
    } catch (e) {
      console.error("[chatList ERROR] /rides/driver/chat-list", e);
      return res.status(500).json({
        ok: false,
        error: "server_error",
      });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  /* ================= PASSENGER CHAT LIST =================
   * GET /rides/passenger/chat-list?passenger_id=9&limit=50
   */
  router.get("/rides/passenger/chat-list", async (req, res) => {
    const passengerId = Number(req.query.passenger_id || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!passengerId) {
      return res
        .status(400)
        .json({ ok: false, error: "passenger_id_required" });
    }

    let conn;
    try {
      conn = await mysqlPool.getConnection();

      const [rows] = await conn.query(
        `
      SELECT DISTINCT
        r.ride_id,
        r.driver_id,
        r.passenger_id,
        r.requested_at,
        r.accepted_at,
        r.arrived_pickup_at,
        r.started_at,
        r.completed_at
      FROM rides r
      LEFT JOIN orders o ON o.delivery_ride_id = r.ride_id
      WHERE r.passenger_id = ? OR o.user_id = ?
      ORDER BY COALESCE(r.completed_at, r.started_at, r.accepted_at, r.requested_at) DESC
      LIMIT ?
      `,
        [passengerId, passengerId, limit],
      );

      const threads = [];
      for (const row of rows) {
        const summary = await buildThreadSummary(row, "passenger", passengerId);
        if (summary) threads.push(summary);
      }

      threads.sort((a, b) => {
        const ta = new Date(a.last_message_at).getTime();
        const tb = new Date(b.last_message_at).getTime();
        return tb - ta;
      });

      return res.json({
        ok: true,
        role: "passenger",
        passenger_id: passengerId,
        threads,
      });
    } catch (e) {
      console.error("[chatList ERROR] /rides/passenger/chat-list", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  /* ================= MERCHANT CHAT LIST =================
   * GET /rides/merchant/chat-list?merchant_id=99&limit=50
   */
  router.get("/rides/merchant/chat-list", async (req, res) => {
    const merchantId = Number(req.query.merchant_id || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!merchantId) {
      return res.status(400).json({
        ok: false,
        error: "merchant_id_required",
      });
    }

    let conn;
    try {
      conn = await mysqlPool.getConnection();

      const [rows] = await conn.query(
        `
        SELECT DISTINCT
          r.ride_id,
          r.driver_id,
          r.passenger_id,
          r.requested_at,
          r.accepted_at,
          r.arrived_pickup_at,
          r.started_at,
          r.completed_at
        FROM rides r
        JOIN orders o ON o.delivery_ride_id = r.ride_id
        WHERE o.business_id = ?
        ORDER BY COALESCE(r.completed_at, r.started_at, r.accepted_at, r.requested_at) DESC
        LIMIT ?
      `,
        [merchantId, limit],
      );

      const threads = [];
      for (const row of rows) {
        const summary = await buildThreadSummary(row, "merchant", merchantId);
        if (summary) threads.push(summary);
      }

      threads.sort((a, b) => {
        const ta = new Date(a.last_message_at).getTime();
        const tb = new Date(b.last_message_at).getTime();
        return tb - ta;
      });

      return res.json({
        ok: true,
        role: "merchant",
        merchant_id: merchantId,
        threads,
      });
    } catch (e) {
      console.error("[chatList ERROR] /rides/merchant/chat-list", e);
      return res.status(500).json({
        ok: false,
        error: "server_error",
      });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  return router;
}
