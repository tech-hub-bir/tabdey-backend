// src/socket/chat.js
// Ride-room chat stored in Redis (no MySQL writes).
// - Membership is still checked against MySQL rides table for security.
// - Messages live in Redis Sorted Set per ride (score = monotonic msg id).

import { getRedis } from "../matching/redis.js";

const ROOM = {
  ride: (rideId) => `ride:${rideId}`,
};

function ackOk(ack, data = {}) {
  try {
    if (typeof ack === "function") ack({ ok: true, ...data });
  } catch {}
}
function ackFail(ack, error = "error") {
  try {
    if (typeof ack === "function") ack({ ok: false, error });
  } catch {}
}
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/* -------- Redis keys -------- */
function msgKey(rideId) {
  return `chat:ride:${rideId}:z`;
}
function seqKey(rideId) {
  return `chat:ride:${rideId}:seq`;
}
function readKey(rideId, role, uid) {
  return `chat:ride:${rideId}:read:${role}:${uid}`;
}

/* -------- Utils -------- */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function toOut(m) {
  return {
    id: Number(m.id),
    request_id: Number(m.request_id),
    sender_type: m.sender_type,
    sender_id: m.sender_id != null ? Number(m.sender_id) : null,
    message: m.deleted ? "" : (m.message || ""),
    attachments: m.deleted ? null : (m.attachments ?? null),
    created_at: m.created_at,
    reply_to: m.reply_to ?? null,
    deleted: m.deleted ?? false,
  };
}

async function resolveReplyTo(r, rideId, replyToId) {
  if (!replyToId) return null;
  try {
    const rows = await r.zrangebyscore(msgKey(rideId), replyToId, replyToId);
    if (!rows.length) return null;
    const msg = safeParse(rows[0]);
    return msg ? toOut(msg) : null;
  } catch {
    return null;
  }
}
function roomSize(io, room) {
  try {
    return io.sockets.adapter.rooms.get(room)?.size ?? 0;
  } catch {
    return 0;
  }
}
function logEmit(io, room, evt, payload, extra = "") {
  const size = roomSize(io, room);
  const rid = String(
    payload?.request_id ?? payload?.message?.request_id ?? "?"
  );
  console.log(
    `[chat EMIT] ride:${rid} evt:${evt} room:${room} size:${size} ${extra}`
  );
}

/* -------- Security: ensure membership -------- */
async function ensureRideMembership(mysqlPool, rideId, socket) {
  const conn = await mysqlPool.getConnection();
  try {
    // Correct query: merchant_ids come from orders.business_id, not rides.passenger_id
    const [[row]] = await conn.query(
      `SELECT 
          r.driver_id,
          GROUP_CONCAT(DISTINCT r.passenger_id) AS passenger_ids,
          GROUP_CONCAT(DISTINCT o.user_id) AS customer_ids, 
          GROUP_CONCAT(DISTINCT rp.user_id) AS ride_participants,
          GROUP_CONCAT(DISTINCT o.business_id) AS merchant_ids
       FROM rides r
       LEFT JOIN orders o ON o.delivery_ride_id = r.ride_id
       LEFT JOIN ride_participants rp ON rp.ride_id = r.ride_id
       WHERE r.ride_id = ?
       GROUP BY r.driver_id`,
      [rideId]
    );

    if (!row) {
      console.warn(`[chat SEC] ride:${rideId} not found`);
      return { ok: false, reason: "ride_not_found" };
    }

    const role = socket.data?.role;
    const selfIdRaw = role === "driver"
      ? socket.data?.driver_id
      : role === "passenger"
      ? socket.data?.passenger_id
      : role === "merchant"
      ? socket.data?.merchant_id
      : null;

    if (!selfIdRaw) {
      console.warn(`[chat SEC] ride:${rideId} missing selfId for role ${role}`);
      return { ok: false, reason: "missing_identity" };
    }

    const selfId = Number(selfIdRaw);

    // --- Driver check ---
    if (role === "driver") {
      if (!selfId || Number(row.driver_id) !== selfId) {
        console.warn(`[chat SEC] ride:${rideId} not_member_driver (did=${selfId}, expected=${row.driver_id})`);
        return { ok: false, reason: "not_member_driver" };
      }
      return {
        ok: true,
        role: "driver",
        selfId,
        otherId: null,
      };
    }

    // --- Passenger check: first rides.passenger_id, then orders.user_id ---
    if (role === "passenger") {
      const allowedPassengerIds = (row.passenger_ids || "")
        .split(",")
        .map(id => Number(id.trim()))
        .filter(id => !isNaN(id));

      const allowedCustomerIds = (row.customer_ids || "")
        .split(",")
        .map(id => Number(id.trim()))
        .filter(id => !isNaN(id));
      
      const allowedRideParticipants = (row.ride_participants || "")
        .split(",")
        .map(id => Number(id.trim()))
        .filter(id => !isNaN(id));
      

      console.log("allowedPassengerIds (rides):", allowedPassengerIds);
      console.log("allowedCustomerIds (orders):", allowedCustomerIds);
      console.log("allowedRideParticipants (ride_participants):", allowedRideParticipants);

      const inRides = allowedPassengerIds.includes(selfId);
      const inOrders = allowedCustomerIds.includes(selfId);
      const inRideParticipants = allowedRideParticipants.includes(selfId);


      if (!inRides && !inOrders && !inRideParticipants) {
        console.warn(
          `[chat SEC] ride:${rideId} not_member_passenger (pid=${selfId}, rides=${allowedPassengerIds}, orders=${allowedCustomerIds}, rideParticipants=${allowedRideParticipants})`
        );
        return { ok: false, reason: "not_member_passenger" };
      }

      console.log(`[chat SEC] ride:${rideId} passenger ${selfId} allowed via ${inRides ? "rides" : "orders"} table`);
      return {
        ok: true,
        role: "passenger",
        selfId,
        otherId: Number(row.driver_id) || null,
      };
    }
    

    // --- Merchant check (business from orders) ---
    if (role === "merchant") {
      const allowedMerchantIds = (row.merchant_ids || "")
        .split(",")
        .map(id => Number(id.trim()))
        .filter(id => !isNaN(id));

      if (!allowedMerchantIds.includes(selfId)) {
        console.warn(
          `[chat SEC] ride:${rideId} not_member_merchant (mid=${selfId}, allowed=${allowedMerchantIds})`
        );
        return { ok: false, reason: "not_member_merchant" };
      }
      return {
        ok: true,
        role: "merchant",
        selfId,
        otherId: Number(row.driver_id) || null,
      };
    }

    console.warn(`[chat SEC] ride:${rideId} unknown_role (socket role=${role})`);
    return { ok: false, reason: "unknown_role" };
  } finally {
    conn.release();
  }
}

/* ======================================================================== */
/*                              Chat initializer                             */
/* ======================================================================== */
export function initRideChat(io, mysqlPool, socket) {
  const r = getRedis();

  console.log(
    `[chat BOOT] socket:${socket.id} role:${socket.data?.role} d:${socket.data?.driver_id ?? "-"} p:${socket.data?.passenger_id ?? "-"}`
  );

  /* ---------------------- JOIN ---------------------- */
  socket.on("chat:join", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    try {
      if (!rideId) return ackFail(ack, "request_id_required");
      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      const room = ROOM.ride(rideId);
      await socket.join(room);

      const size = roomSize(io, room);
      console.log(`[chat JOIN] ride:${rideId} room:${room} size:${size} by ${mem.role}:${mem.selfId}`);
      ackOk(ack, { room, size });
    } catch (e) {
      console.error("[chat ERROR] chat:join", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- LEAVE ---------------------- */
  socket.on("chat:leave", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    try {
      if (!rideId) return ackFail(ack, "request_id_required");
      const room = ROOM.ride(rideId);
      await socket.leave(room);

      const size = roomSize(io, room);
      console.log(`[chat LEAVE] ride:${rideId} room:${room} size:${size}`);
      ackOk(ack, { room, size });
    } catch (e) {
      console.error("[chat ERROR] chat:leave", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- SEND ---------------------- */
  socket.on("chat:send", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    console.log(`[chat RECV] chat:send ride:${rideId} from socket:${socket.id} payload=`, payload);

    try {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      const attachments = payload.attachments ?? null;
      const temp_id = payload.temp_id || null;
      const reply_to_id = payload.reply_to_id ? Number(payload.reply_to_id) : null;

      if (!rideId) return ackFail(ack, "request_id_required");
      if (!text && !attachments) return ackFail(ack, "empty_message");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      // ⬅️ defensive join so sender is in the room even if client forgot to join
      const room = ROOM.ride(rideId);
      await socket.join(room);

      const id = await r.incr(seqKey(rideId));
      const messageObj = {
        id,
        request_id: rideId,
        sender_type: mem.role,
        sender_id: mem.selfId || null,
        message: text || "",
        attachments: attachments || null,
        created_at: nowIso(),
        reply_to_id: reply_to_id || null,
      };

      await r.zadd(msgKey(rideId), id, JSON.stringify(messageObj));
      console.log(`[chat STORE] ride:${rideId} msgId:${id} by:${mem.role} uid:${mem.selfId} textLen:${(text || "").length}`);

      const reply_to = await resolveReplyTo(r, rideId, reply_to_id);
      const out = toOut({ ...messageObj, reply_to });
      logEmit(io, room, "chat:new", { message: out, temp_id });
      io.to(room).emit("chat:new", { message: out, temp_id });

      ackOk(ack, { message: out, temp_id });
    } catch (e) {
      console.error("[chat ERROR] chat:send", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* --------------------- HISTORY --------------------- */
  socket.on("chat:history", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    console.log(`[chat RECV] chat:history ride:${rideId} from socket:${socket.id} payload=`, payload);

    try {
      const beforeId = payload.before_id != null ? Number(payload.before_id) : null;
      const limit = Math.min(200, Math.max(1, Number(payload.limit || 50)));
      if (!rideId) return ackFail(ack, "request_id_required");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      // ⬅️ defensive join so the history caller is in the room going forward
      const room = ROOM.ride(rideId);
      await socket.join(room);

      const maxScore = Number.isFinite(beforeId) ? beforeId - 1 : "+inf";
      const rows = await r.zrevrangebyscore(msgKey(rideId), maxScore, "-inf", "LIMIT", 0, limit);
      const parsed = rows.map(safeParse).filter(Boolean);

      // Batch-resolve reply_to for any messages that reference another message
      const replyIds = [...new Set(parsed.filter(m => m.reply_to_id).map(m => m.reply_to_id))];
      const replyMap = {};
      await Promise.all(replyIds.map(async (rid) => {
        const resolved = await resolveReplyTo(r, rideId, rid);
        if (resolved) replyMap[rid] = resolved;
      }));

      const messages = parsed.map(m => toOut({
        ...m,
        reply_to: m.reply_to_id ? (replyMap[m.reply_to_id] ?? null) : null,
      })).reverse();

      console.log(`[chat OK] history ride:${rideId} -> ${messages.length} msgs (limit=${limit}, before=${beforeId ?? "∞"})`);
      ackOk(ack, { messages });
    } catch (e) {
      console.error("[chat ERROR] chat:history", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- DELETE --------------------- */
  socket.on("chat:delete", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    const messageId = Number(payload.message_id);
    console.log(`[chat RECV] chat:delete ride:${rideId} msgId:${messageId} socket:${socket.id}`);

    try {
      if (!rideId || !messageId) return ackFail(ack, "request_id_and_message_id_required");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      const rows = await r.zrangebyscore(msgKey(rideId), messageId, messageId);
      if (!rows.length) return ackFail(ack, "message_not_found");

      const msg = safeParse(rows[0]);
      if (!msg) return ackFail(ack, "message_not_found");

      // Only the original sender can unsend
      if (String(msg.sender_id) !== String(mem.selfId) || msg.sender_type !== mem.role) {
        return ackFail(ack, "not_authorized");
      }

      // Replace message content with a deleted tombstone (keeps the ID in history)
      const deleted = { ...msg, message: "", attachments: null, deleted: true, deleted_at: nowIso() };
      await r.zremrangebyscore(msgKey(rideId), messageId, messageId);
      await r.zadd(msgKey(rideId), messageId, JSON.stringify(deleted));

      const room = ROOM.ride(rideId);
      io.to(room).emit("chat:deleted", { request_id: rideId, message_id: messageId });
      console.log(`[chat OK] chat:delete ride:${rideId} msgId:${messageId}`);
      ackOk(ack, { message_id: messageId });
    } catch (e) {
      console.error("[chat ERROR] chat:delete", e?.message);
      ackFail(ack, "server_error");
    }
  });

  /* ---------------------- TYPING --------------------- */
  socket.on("chat:typing", async (payload = {}) => {
    const rideId = Number(payload.request_id);
    const is_typing = !!payload.is_typing;
    const role = socket.data?.role || "unknown";
    const id = role === "driver" ? socket.data?.driver_id : socket.data?.passenger_id;

    if (!rideId) return;
    const room = ROOM.ride(rideId);
    logEmit(io, room, "chat:typing", { request_id: rideId }, `(from ${role}:${id})`);
    socket.to(room).emit("chat:typing", {
      request_id: rideId,
      from: { role, id: id || null },
      is_typing,
    });
  });

  /* -------------------- READ RECEIPT ------------------- */
  socket.on("chat:read", async (payload = {}, ack) => {
    const rideId = Number(payload.request_id);
    const lastId = Number(payload.last_seen_id || 0);
    console.log(`[chat RECV] chat:read ride:${rideId} last_seen_id:${lastId} socket:${socket.id}`);

    try {
      if (!rideId || !Number.isFinite(lastId)) return ackFail(ack, "bad_args");

      const mem = await ensureRideMembership(mysqlPool, rideId, socket);
      if (!mem.ok) return ackFail(ack, mem.reason);

      await r.hset(readKey(rideId, mem.role, mem.selfId), {
        last_seen_id: String(lastId),
        seen_at: nowIso(),
      });

      const room = ROOM.ride(rideId);
      logEmit(io, room, "chat:read", { request_id: rideId, last_seen_id: lastId }, `(reader ${mem.role}:${mem.selfId})`);
      socket.to(room).emit("chat:read", {
        request_id: rideId,
        reader: { role: mem.role, id: mem.selfId },
        last_seen_id: lastId,
      });

      ackOk(ack);
    } catch (e) {
      console.error("[chat ERROR] chat:read", e?.message);
      ackFail(ack, "server_error");
    }
  });
}
