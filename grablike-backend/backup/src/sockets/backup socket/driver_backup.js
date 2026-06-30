// src/socket/driver.js
import { DriverOnlineSession } from "../models/DriverOnlineSession.js";
import { presence } from "../matching/presence.js";
import { matcher } from "../matching/matcher.js";
import { getRedis } from "../matching/redis.js";
import {
  rideHash,
  currentRidesKey,
  currentPassengerRideKey,
} from "../matching/redisKeys.js";
import { initRideChat } from "./chat.js";
import { computePlatformFeeAndGST } from "../services/pricing/rulesEngine.js";

/* ---------------------- Dev logger ---------------------- */
const dbg = (...args) => {
  if (process.env.NODE_ENV !== "production") console.log(...args);
};

/* ---------------------- Feature toggles (ENV optional) ---------------------- */
const PERF_SOCKETS = String(process.env.PERF_SOCKETS || "0") === "1";
const PRESENCE_NEARBY = String(process.env.PRESENCE_NEARBY || "1") === "1";
const GLOBAL_DRIVER_BROADCAST =
  String(process.env.GLOBAL_DRIVER_BROADCAST || "1") === "1";

/* ---------------------- Room helpers ---------------------- */
const driverRoom = (driverId) => `driver:${driverId}`;
const passengerRoom = (passengerId) => `passenger:${passengerId}`;
const rideRoom = (rideId) => `ride:${rideId}`;
const orderRoom = (orderId) => `order:${orderId}`;
const merchantRoom = (id) => `merchant:${id}`;

const isNum = (n) => Number.isFinite(Number(n));

/* ---------------------- Ratings table config ---------------------- */
const RATINGS_TABLE = "ride_ratings";
const RATING_COLUMN = "rating";

/* ---------------------- Wallet config ---------------------- */
const PLATFORM_WALLET_ID = (
  process.env.PLATFORM_WALLET_ID || "TD00000001"
).trim();
const WALLET_TBL = "wallet_transactions";
const WALLETS_TBL = "wallets";

/* ---------------------- External IDs service ---------------------- */
const WALLET_IDS_ENDPOINT = (
  process.env.WALLET_IDS_ENDPOINT || "https://grab.newedge.bt/wallet/ids/both"
).trim();
const WALLET_IDS_API_KEY = (process.env.WALLET_IDS_API_KEY || "").trim();

/* ---------------------- Small helpers ---------------------- */
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const rand = () => Math.random().toString(36).slice(2);
const genTxnId = () => `TNX${Date.now()}${rand().toUpperCase()}`;
const genJournal = () => `JRN${rand().toUpperCase()}${rand().toUpperCase()}`;

function safeAck(cb, payload) {
  try {
    if (typeof cb === "function") cb(payload);
  } catch {}
}

function roomSize(io, room) {
  return io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

/* =====================================================================
   PERFORMANCE: CACHES & THROTTLES
   ===================================================================== */

// 1) Delivery rooms target cache (DB expensive)
const deliveryTargetCache = new Map(); // driverId -> { ts, targets }
const DELIVERY_CACHE_MS = 4000;

// 2) RideIds cache (Redis hkeys per GPS tick expensive)
const rideIdsCache = new Map(); // driverId -> { ts, rideIds[] }
const RIDEIDS_CACHE_MS = 3000;

// 3) Presence/nearby throttle (heavy)
const lastPresenceAt = new Map(); // driverId -> ts
const PRESENCE_MIN_MS = 2500;

// 4) Emit throttle (avoid flooding)
const lastEmitAt = new Map(); // driverId -> ts
const EMIT_MIN_MS = 800;

// 5) Movement debounce
const lastLocByDriver = new Map();

function haversine(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function shouldProcessMove(
  driverId,
  lat,
  lng,
  ts,
  minMeters = 5,
  minMs = 1200,
  forceEveryMs = 4500, // guarantee emit at least every 4.5s even if not moving
) {
  const prev = lastLocByDriver.get(driverId);

  const moved = prev ? haversine(prev, { lat, lng }) > minMeters : true;
  const spaced = prev ? ts - prev.ts > minMs : true;

  const forced = prev ? ts - prev.ts > forceEveryMs : true;

  if ((moved && spaced) || forced) {
    lastLocByDriver.set(driverId, { lat, lng, ts });
    return true;
  }
  return false;
}

function shouldEmit(driverId, ts, minMs = EMIT_MIN_MS) {
  const prev = lastEmitAt.get(driverId) || 0;
  if (ts - prev >= minMs) {
    lastEmitAt.set(driverId, ts);
    return true;
  }
  return false;
}

function shouldPresence(driverId, ts, minMs = PRESENCE_MIN_MS) {
  const prev = lastPresenceAt.get(driverId) || 0;
  if (ts - prev >= minMs) {
    lastPresenceAt.set(driverId, ts);
    return true;
  }
  return false;
}

/* =====================================================================
   DELIVERY TARGETS: DB → rooms (cached)
   ===================================================================== */

async function getDeliveryTargetsForDriver(conn, driverId) {
  const [rows] = await conn.query(
    `
    SELECT
      o.order_id,
      o.business_id,
      o.delivery_ride_id,
      COALESCE(o.delivery_status, o.status) AS st
    FROM orders o
    WHERE o.delivery_driver_id = ?
      AND COALESCE(o.delivery_status, o.status) IN ('ASSIGNED','PICKED_UP','ON_ROAD') -- ✅ include ASSIGNED
      AND o.delivery_ride_id IS NOT NULL
    `,
    [String(driverId)],
  );

  const rideRooms = new Set();
  const orderRooms = new Set();
  const merchantRooms = new Set();

  for (const r of rows || []) {
    if (r?.delivery_ride_id)
      rideRooms.add(`ride:${String(r.delivery_ride_id)}`);
    if (r?.order_id) orderRooms.add(`order:${String(r.order_id)}`);
    if (r?.business_id) merchantRooms.add(`merchant:${String(r.business_id)}`);
  }

  return {
    rideRooms: [...rideRooms],
    orderRooms: [...orderRooms],
    merchantRooms: [...merchantRooms],
    rows,
  };
}

function emitToTargets(io, driverId, loc, source, targets) {
  const totalRooms =
    (targets.rideRooms?.length || 0) +
    (targets.orderRooms?.length || 0) +
    (targets.merchantRooms?.length || 0);
  if (!totalRooms) return;

  const payloadOut = {
    driver_id: String(driverId),
    lat: Number(loc.lat),
    lng: Number(loc.lng),
    heading: isNum(loc.heading) ? Number(loc.heading) : null,
    speed: isNum(loc.speed) ? Number(loc.speed) : null,
    accuracy: isNum(loc.accuracy) ? Number(loc.accuracy) : null,
    source: source || "unknown",
    ts: loc.ts || Date.now(),
  };

  for (const room of targets.rideRooms || []) {
    io.to(room).emit("deliveryDriverLocation", payloadOut);
  }
  for (const room of targets.orderRooms || []) {
    io.to(room).emit("deliveryDriverLocation", payloadOut);
  }
  for (const room of targets.merchantRooms || []) {
    io.to(room).emit("deliveryDriverLocation", payloadOut);
  }
}

async function emitDeliveryDriverLocationFast({
  io,
  mysqlPool,
  driverId,
  loc,
  source,
}) {
  if (!mysqlPool?.getConnection) return;

  const did = String(driverId);
  const now = Date.now();

  const cached = deliveryTargetCache.get(did);
  if (cached && now - cached.ts < DELIVERY_CACHE_MS) {
    emitToTargets(io, did, loc, source, cached.targets);
    return;
  }

  const conn = await mysqlPool.getConnection();
  try {
    const targets = await getDeliveryTargetsForDriver(conn, did);
    deliveryTargetCache.set(did, { ts: now, targets });
    emitToTargets(io, did, loc, source, targets);
  } catch (e) {
    console.warn("⚠️ [DELIVERY] emit error:", e?.message || e);
  } finally {
    conn.release();
  }
}

/* =====================================================================
   RIDES: driverId -> rideIds (cached Redis)
   ===================================================================== */

async function getRideIdsForDriver(redis, driverId) {
  const did = String(driverId);
  const now = Date.now();
  const cached = rideIdsCache.get(did);
  if (cached && now - cached.ts < RIDEIDS_CACHE_MS) return cached.rideIds;

  const rideIds = await redis.hkeys(currentRidesKey(did));
  rideIdsCache.set(did, { ts: now, rideIds: rideIds || [] });
  return rideIds || [];
}

/* =====================================================================
   Clear Redis current-ride snapshots
   ===================================================================== */
async function clearCurrentRideSnapshots(rideId, driverId, passengerId) {
  try {
    const redis = getRedis();
    const rid = String(rideId || "").trim();
    if (!rid) return;

    if (driverId != null) {
      const did = String(driverId).trim();
      if (did) await redis.hdel(currentRidesKey(did), rid);
    }

    if (passengerId != null) {
      const pid = String(passengerId).trim();
      if (pid) await redis.del(currentPassengerRideKey(pid));
    }

    console.log("[clearCurrentRideSnapshots] cleared", {
      rideId: rid,
      driverId,
      passengerId,
    });
  } catch (e) {
    console.warn("[clearCurrentRideSnapshots] warn:", e?.message || String(e));
  }
}

/* ---------------- Payment method helpers ---------------- */
function normalizePaymentMethod(pm) {
  try {
    if (!pm) return "";
    if (typeof pm === "string") return pm.trim().toLowerCase();
    if (typeof pm === "object") {
      const m = (pm.method || pm.type || pm.name || "")
        .toString()
        .trim()
        .toLowerCase();
      return m;
    }
  } catch {}
  return "";
}

function isWalletPayment(pm) {
  const m = normalizePaymentMethod(pm);
  return ["wallet", "grabwallet", "in_app_wallet"].includes(m);
}

async function getRidePaymentMethodFromRedis(rideId) {
  try {
    const r = getRedis();
    const h = await r.hgetall(rideHash(String(rideId)));
    if (h?.payment_method) {
      try {
        return JSON.parse(h.payment_method);
      } catch {
        return h.payment_method;
      }
    }
  } catch (e) {
    dbg("[payment method] redis read warn:", e?.message);
  }
  return null;
}

/* ---------------------- Shape DB row → client payload ---------------------- */
function toClientRide(db) {
  if (!db) return null;
  const m = Number(db.distance_m || 0);
  const s = Number(db.duration_s || 0);

  return {
    request_id: db.ride_id,
    driver_id: db.driver_id,
    passenger_id: db.passenger_id,
    status: db.status,
    pickup: db.pickup_place,
    dropoff: db.dropoff_place,
    pickup_lat: db.pickup_lat,
    pickup_lng: db.pickup_lng,
    dropoff_lat: db.dropoff_lat,
    dropoff_lng: db.dropoff_lng,
    distance_km: Math.round((m / 1000) * 10) / 10,
    eta_min: Math.round(s / 60),
    currency: db.currency,
    fare_cents: db.fare_cents,
    requested_at: db.requested_at,
    accepted_at: db.accepted_at,
    arrived_pickup_at: db.arrived_pickup_at,
    started_at: db.started_at,
    completed_at: db.completed_at,
    trip_type: db.trip_type || "instant",
    vehicle_type: db.service_type,
    pool_batch_id: db.pool_batch_id || null,
    driver_name: db.driver_name || null,
    driver_phone: db.driver_phone || null,
    driver_rating: db.driver_rating != null ? Number(db.driver_rating) : null,
    driver_ratings_count:
      db.driver_ratings_count != null ? Number(db.driver_ratings_count) : null,
    driver_trips: db.driver_trips != null ? Number(db.driver_trips) : null,
    vehicle_label: db.vehicle_label || null,
    vehicle_plate: db.vehicle_plate || null,
  };
}

/* Helper: foreground socket check */
function hasForegroundConn(io, driverId) {
  const room = io.sockets.adapter.rooms.get(driverRoom(driverId));
  if (!room) return false;
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid);
    if (s?.data?.driver_id === driverId && !s?.data?.isBg) return true;
  }
  return false;
}

/* Helper: fetch passenger_id for a ride */
async function getPassengerId(conn, request_id) {
  const [[row]] = await conn.query(
    `SELECT passenger_id FROM rides WHERE ride_id = ?`,
    [request_id],
  );
  return row?.passenger_id ?? null;
}

function logStage(io, request_id, stage, passenger_id) {
  const room = rideRoom(request_id);
  const size = roomSize(io, room);
  console.log(
    `[stage emit] ride:${request_id} stage:${stage} roomSize:${size} to passenger:${
      passenger_id ?? "-"
    }`,
  );
}

/* ========================================================================
   Resolve incoming → canonical driver_id
   ======================================================================== */
async function resolveDriverId(conn, incomingId) {
  const id = Number(incomingId);
  if (!Number.isFinite(id)) return null;

  const [[byDriverId]] = await conn.query(
    "SELECT driver_id FROM drivers WHERE driver_id = ? LIMIT 1",
    [id],
  );
  if (byDriverId) return byDriverId.driver_id;

  const [[byUserId]] = await conn.query(
    "SELECT driver_id FROM drivers WHERE user_id = ? LIMIT 1",
    [id],
  );
  return byUserId?.driver_id ?? null;
}

/* ========================================================================
   POOL SUMMARY emitter
   ======================================================================== */
async function emitPoolSummary(io, conn, rideId) {
  const [[sum]] = await conn.query(
    `
    SELECT
      r.ride_id,
      COALESCE(r.capacity_seats, 0) AS capacity_seats,
      COALESCE(r.seats_booked, 0) AS seats_booked,
      COALESCE(SUM(CASE WHEN b.status IN ('accepted','arrived_pickup','started') THEN b.seats END),0)
        AS seats_confirmed
    FROM rides r
    LEFT JOIN ride_bookings b ON b.ride_id = r.ride_id
    WHERE r.ride_id = ?
    GROUP BY r.ride_id
    `,
    [rideId],
  );

  const [rows] = await conn.query(
    `
    SELECT
      booking_id,
      passenger_id,
      seats,
      pickup_place AS pickup,
      dropoff_place AS dropoff,
      pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
      fare_cents, currency, status
    FROM ride_bookings
    WHERE ride_id = ?
      AND status IN ('accepted','arrived_pickup','started','requested')
    `,
    [rideId],
  );

  const sc = Number(sum?.seats_confirmed || 0);
  const capacitySafe = Math.max(3, sc);

  io.to(rideRoom(rideId)).emit("poolSummary", {
    request_id: String(rideId),
    seats_confirmed: sc,
    capacity_seats: capacitySafe,
    seats_booked: Number(sum?.seats_booked || 0),
    bookings: (rows || []).map((r) => ({
      ...r,
      booking_id: String(r.booking_id),
      request_id: String(rideId),
    })),
  });
}

/* ---------------- Resolve user_id + wallet_id for driver/passenger ---------------- */
async function getDriverUserAndWallet(conn, driverId) {
  const [[row]] = await conn.query(
    `SELECT d.user_id FROM drivers d WHERE d.driver_id = ? LIMIT 1`,
    [driverId],
  );

  const user_id = row?.user_id ? Number(row.user_id) : null;
  if (!user_id) return { user_id: null, wallet_id: null };

  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id = ? LIMIT 1`,
    [user_id],
  );

  return { user_id, wallet_id: w?.wallet_id || null };
}

async function getPassengerUserAndWallet(conn, passengerId) {
  // passengerId treated as user_id in your system
  const user_id = passengerId != null ? Number(passengerId) : null;
  if (!user_id) return { user_id: null, wallet_id: null };

  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id = ? LIMIT 1`,
    [user_id],
  );

  return { user_id, wallet_id: w?.wallet_id || null };
}

/* ===== Wallet locking helpers ===== */
async function lockWalletRow(conn, wallet_id) {
  const [rows] = await conn.query(
    `
    SELECT wallet_id, user_id, amount
    FROM ${WALLETS_TBL}
    WHERE wallet_id = ?
    FOR UPDATE
    `,
    [wallet_id],
  );
  return rows?.[0] || null;
}

function asMoneyString(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // 2dp string to avoid float issues in SQL
  return n.toFixed(2);
}

function clampNote(s, max = 180) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

async function walletTransfer(
  conn,
  {
    from_wallet,
    to_wallet,
    driver_credit_nu,
    passenger_debit_nu,
    reason,
    meta,
  },
) {
  const driver_credit_str = asMoneyString(driver_credit_nu);
  const passenger_debit_str = asMoneyString(passenger_debit_nu);
  if (!driver_credit_str) return { ok: false, reason: "invalid_amount" };
  if (Number(driver_credit_str) <= 0)
    return { ok: false, reason: "amount_not_positive" };

  const fromId = String(from_wallet).trim();
  const toId = String(to_wallet).trim();
  if (!fromId || !toId) return { ok: false, reason: "wallet_missing" };
  if (fromId === toId) return { ok: false, reason: "same_wallet" };

  // Lock wallets in consistent order to avoid deadlocks
  const [w1, w2] = fromId < toId ? [fromId, toId] : [toId, fromId];

  const [[w1row]] = await conn.execute(
    `SELECT wallet_id, amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [w1],
  );
  const [[w2row]] = await conn.execute(
    `SELECT wallet_id, amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [w2],
  );
  if (!w1row || !w2row) return { ok: false, reason: "wallet_not_found" };

  // Ensure sender has balance
  const [[fromRow]] = await conn.execute(
    `SELECT amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [fromId],
  );
  const fromBal = Number(fromRow?.amount ?? 0);
  if (!Number.isFinite(fromBal))
    return { ok: false, reason: "invalid_balance" };
  if (fromBal < Number(driver_credit_str))
    return { ok: false, reason: "insufficient_balance" };

  console.log("Driver credit Str:", driver_credit_str);
  console.log("Passenger debit Str:", passenger_debit_str);
  // ✅ debit with guard
  const [debit] = await conn.execute(
    `UPDATE wallets
     SET amount = amount - ?
     WHERE wallet_id = ? AND amount >= ?`,
    [passenger_debit_str, fromId, driver_credit_str],
  );
  if (!debit.affectedRows)
    return { ok: false, reason: "insufficient_balance_race" };

  // ✅ credit
  await conn.execute(
    `UPDATE wallets
     SET amount = amount + ?
     WHERE wallet_id = ?`,
    [driver_credit_str, toId],
  );

  // ✅ transaction ids must be UNIQUE (your DB enforces it)

  const txn_cr = genTxnId();
  const txn_dr = genTxnId();

  const journal_code = genJournal(); // varchar(36) ok
  const note = clampNote(JSON.stringify({ reason, ...(meta || {}) }), 500);
  const ts = new Date();

  // Sender row (DR) - remark ENUM('CR','DR')
  await conn.execute(
    `
    INSERT INTO wallet_transactions
      (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [
      txn_dr,
      journal_code,
      fromId,
      toId,
      passenger_debit_str,
      "DR",
      note,
      ts,
      ts,
    ],
  );

  // Receiver row (CR)
  await conn.execute(
    `
    INSERT INTO wallet_transactions
      (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [txn_cr, journal_code, fromId, toId, driver_credit_str, "CR", note, ts, ts],
  );

  return {
    ok: true,
    transaction_id_dr: txn_dr,
    transaction_id_cr: txn_cr,
    amount: Number(driver_credit_str),
  };
}

/* ========================================================================
   SOCKET BOOTSTRAP
   ======================================================================== */

const liveSocketByDriver = new Map();

export function initDriverSocket(io, mysqlPool) {
  io.on("connection", (socket) => {
    console.log("[socket] connected:", socket.id);

    const auth = socket.handshake?.auth || {};
    const query = socket.handshake?.query || {};

    const driverId =
      auth.driverId ??
      auth.driver_id ??
      query.driverId ??
      query.driver_id ??
      null;

    const passengerId =
      auth.passengerId ??
      auth.passenger_id ??
      query.passengerId ??
      query.passenger_id ??
      null;

    const merchantId =
      auth.merchantId ??
      auth.merchant_id ??
      query.merchantId ??
      query.merchant_id ??
      null;

    socket.data = { role: "unknown", isBg: !!auth.bg };

    if (driverId != null) {
      const member = String(driverId);
      socket.data.role = "driver";
      socket.data.driver_id = member;
      socket.join(driverRoom(member));
      console.log(`[socket] driver connected via handshake: ${member}`);

      const prevId = liveSocketByDriver.get(member);
      if (prevId && prevId !== socket.id) {
        const prevSock = io.sockets.sockets.get(prevId);
        if (prevSock) prevSock.disconnect(true);
      }
      liveSocketByDriver.set(member, socket.id);
    }

    if (passengerId != null) {
      const pid = String(passengerId);
      socket.data.role = socket.data.role === "driver" ? "driver" : "passenger";
      socket.data.passenger_id = pid;
      socket.join(passengerRoom(pid));
      console.log(`[socket] passenger connected via handshake: ${pid}`);
    }

    if (merchantId != null) {
      const mid = String(merchantId);
      socket.data.role = socket.data.role === "driver" ? "driver" : "merchant";
      socket.data.merchant_id = mid;
      socket.join(merchantRoom(mid));
      console.log(`[socket] merchant connected via handshake/query: ${mid}`);
    }

    initRideChat(io, mysqlPool, socket);

    /* -------- Optional explicit identity event -------- */
    socket.on(
      "whoami",
      ({ role, driver_id, passenger_id, merchant_id, bg } = {}) => {
        socket.data.role = role || "unknown";
        if (typeof bg === "boolean") socket.data.isBg = bg;

        if (role === "driver" && driver_id != null) {
          const member = String(driver_id);
          socket.data.driver_id = member;
          socket.join(driverRoom(member));

          const prevId = liveSocketByDriver.get(member);
          if (prevId && prevId !== socket.id) {
            const prevSock = io.sockets.sockets.get(prevId);
            if (prevSock) prevSock.disconnect(true);
          }
          liveSocketByDriver.set(member, socket.id);
        }

        if (role === "passenger" && passenger_id != null) {
          const pid = String(passenger_id);
          socket.data.passenger_id = pid;
          socket.join(passengerRoom(pid));
        }

        if (role === "merchant" && merchant_id != null) {
          const mid = String(merchant_id);
          socket.data.merchant_id = mid;
          socket.join(merchantRoom(mid));
        }
      },
    );

    /* -------- Join / Leave order room -------- */
    socket.on("joinOrder", async ({ orderId } = {}, ack) => {
      if (!orderId)
        return safeAck(ack, { ok: false, error: "orderId required" });
      const oid = String(orderId);
      const room = orderRoom(oid);
      socket.join(room);

      console.log("👥 [ORDER ROOM] joinOrder", {
        orderId: oid,
        room,
        size: roomSize(io, room),
        socketId: socket.id,
      });

      return safeAck(ack, { ok: true, room });
    });

    socket.on("leaveOrder", ({ orderId } = {}, ack) => {
      if (!orderId)
        return safeAck(ack, { ok: false, error: "orderId required" });
      socket.leave(orderRoom(String(orderId)));
      return safeAck(ack, { ok: true });
    });

    /* -------- Join / Leave ride room -------- */
    socket.on("joinRide", async ({ rideId } = {}, ack) => {
      if (!rideId) return safeAck(ack, { ok: false, error: "rideId required" });
      const rid = String(rideId);
      socket.join(rideRoom(rid));
      return safeAck(ack, { ok: true, room: rideRoom(rid) });
    });

    socket.on("leaveRide", ({ rideId } = {}, ack) => {
      if (!rideId) return safeAck(ack, { ok: false, error: "rideId required" });
      socket.leave(rideRoom(String(rideId)));
      return safeAck(ack, { ok: true });
    });

    /* -------- Heartbeat -------- */
    socket.on("ping", (msg) => socket.emit("pong", { msg, ts: Date.now() }));

    /* -------- Presence + online/offline -------- */
    socket.on(
      "driverOnline",
      async (
        {
          source = "socket",
          cityId = "thimphu",
          serviceType = "bike",
          serviceCode = "default",
          lat,
          lng,
        } = {},
        ack,
      ) => {
        const driver_id = socket.data.driver_id;
        if (!driver_id)
          return safeAck(ack, { ok: false, error: "No driver_id" });

        socket.data.cityId = cityId;
        socket.data.serviceType = serviceType;
        socket.data.serviceCode = serviceCode;

        socket.join(`city:${cityId}:${serviceType}`);

        try {
          await DriverOnlineSession.create({
            driver_id,
            started_at: new Date(),
            ended_at: null,
            source,
          });

          try {
            await presence.setOnline(driver_id, {
              cityId,
              serviceType,
              serviceCode,
              socketId: socket.id,
              lat: isNum(lat) ? Number(lat) : undefined,
              lng: isNum(lng) ? Number(lng) : undefined,
            });
          } catch (e) {
            console.warn("[presence.setOnline] skipped:", e?.message);
          }

          safeAck(ack, { ok: true });
        } catch (err) {
          console.error("[driverOnline] error:", err);
          safeAck(ack, { ok: false, error: "Server error" });
        }
      },
    );

    socket.on("driverOffline", async (_payload, ack) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id) return safeAck(ack, { ok: false, error: "No driver_id" });

      try {
        await DriverOnlineSession.updateOne(
          { driver_id, ended_at: null },
          { $set: { ended_at: new Date() } },
        );

        try {
          await presence.setOffline(driver_id, socket.id);
        } catch (e) {
          console.warn("[presence.setOffline] skipped:", e?.message);
        }

        safeAck(ack, { ok: true });
      } catch (err) {
        console.error("[driverOffline] error:", err);
        safeAck(ack, { ok: false, error: "Server error" });
      }
    });

    /* =====================================================================
       FAST LOCATION PIPELINE
       ===================================================================== */
    socket.on("driverLocationUpdate", async (payload = {}, ack) => {
      const t0 = PERF_SOCKETS ? Date.now() : 0;

      const {
        driver_id: pId,
        lat,
        lng,
        heading,
        speed,
        accuracy,
        source = "foreground",
      } = payload || {};

      const member = String(pId || socket.data.driver_id || "").trim();
      if (!member)
        return safeAck(ack, { ok: false, error: "Missing driver_id" });

      if (!socket.data.driver_id) {
        socket.data.driver_id = member;
        socket.join(driverRoom(member));
      }

      const cityId = socket.data.cityId || "thimphu";
      const serviceType = socket.data.serviceType || "bike";
      const serviceCode = socket.data.serviceCode || "default";

      const isBgConn =
        !!socket.handshake?.auth?.bg ||
        socket.data.isBg ||
        source === "background";

      if (isBgConn && hasForegroundConn(io, member)) {
        return safeAck(ack, { ok: true, dropped: "bg-duplicate" });
      }

      if (!isNum(lat) || !isNum(lng)) {
        return safeAck(ack, { ok: true, dropped: "no-coords" });
      }

      const tsNow = Date.now();

      if (!shouldProcessMove(member, Number(lat), Number(lng), tsNow)) {
        return safeAck(ack, { ok: true, dropped: "debounced" });
      }

      if (!shouldEmit(member, tsNow)) {
        return safeAck(ack, { ok: true, dropped: "emit-throttled" });
      }

      const loc = {
        lat: Number(lat),
        lng: Number(lng),
        heading,
        speed,
        accuracy,
        ts: tsNow,
      };

      // 1) transport ride passengers (Redis cached)
      try {
        const redis = getRedis();
        const rideIds = await getRideIdsForDriver(redis, member);

        for (const rideId of rideIds || []) {
          io.to(rideRoom(String(rideId))).emit("rideDriverLocation", {
            request_id: String(rideId),
            driver_id: String(member),
            lat: loc.lat,
            lng: loc.lng,
            heading: isNum(heading) ? Number(heading) : null,
            speed: isNum(speed) ? Number(speed) : null,
            accuracy: isNum(accuracy) ? Number(accuracy) : null,
            ts: loc.ts,
          });
        }
      } catch (e) {
        console.warn("[rideDriverLocation] warn:", e?.message || e);
      }

      // 2) delivery emit (DB cached) — do not block ack
      setImmediate(() => {
        emitDeliveryDriverLocationFast({
          io,
          mysqlPool,
          driverId: member,
          loc,
          source,
        }).catch((e) => console.warn("[delivery emit] warn:", e?.message || e));
      });

      // 3) presence update (heavy) throttled
      if (shouldPresence(member, tsNow)) {
        setImmediate(async () => {
          try {
            await presence.updateLocation(member, {
              cityId,
              serviceType,
              serviceCode,
              lat: loc.lat,
              lng: loc.lng,
            });

            if (PRESENCE_NEARBY) {
              const peers = await presence.getNearby({
                cityId,
                serviceType,
                serviceCode,
                lat: loc.lat,
                lng: loc.lng,
                radiusM: 3000,
                count: 25,
              });
              io.to(driverRoom(member)).emit("allDriversData", peers);
            } else {
              io.to(driverRoom(member)).emit("allDriversData", []);
            }
          } catch (e) {
            io.to(driverRoom(member)).emit("allDriversData", [
              { id: member, lat: loc.lat, lng: loc.lng },
            ]);
          }
        });
      }

      // 4) global broadcast (optional)
      if (GLOBAL_DRIVER_BROADCAST) {
        socket.broadcast.emit("driverLocationBroadcast", {
          driver_id: member,
          lat: loc.lat,
          lng: loc.lng,
          heading: isNum(heading) ? Number(heading) : null,
          speed: isNum(speed) ? Number(speed) : null,
          accuracy: isNum(accuracy) ? Number(accuracy) : null,
          source,
        });
      }

      if (PERF_SOCKETS) {
        const ms = Date.now() - t0;
        if (ms > 60)
          console.log("[perf] driverLocationUpdate took", ms, "ms", { member });
      }

      return safeAck(ack, { ok: true });
    });

    /* ===================== Core ride lifecycle ===================== */
    socket.on("jobAccept", (payload) =>
      handleJobAccept({ io, socket, mysqlPool, payload }),
    );
    socket.on("jobReject", (payload) =>
      handleJobReject({ io, socket, mysqlPool, payload }),
    );
    socket.on("driverArrivedPickup", (payload) =>
      handleDriverArrivedPickup({ io, socket, mysqlPool, payload }),
    );
    socket.on("driverStartTrip", (payload) =>
      handleDriverStartTrip({ io, socket, mysqlPool, payload }),
    );
    socket.on("driverCompleteTrip", (payload) => {
      console.log("[evt recv] driverCompleteTrip", payload);
      handleDriverCompleteTrip({ io, socket, mysqlPool, payload });
    });

    /* ===================== DELIVERY: per-order drop update ===================== */
    socket.on("deliveryDropUpdate", async ({ order_id, status } = {}, ack) => {
      const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
      const fail = (error) => safeAck(ack, { ok: false, error });

      const driver_id = socket.data.driver_id;
      if (!driver_id) return fail("Not authenticated as driver");
      if (!order_id || !status) return fail("Missing order_id or status");

      const nextStatus = String(status).toUpperCase();
      if (!["DELIVERED"].includes(nextStatus))
        return fail("Invalid delivery status");

      let conn;
      try {
        conn = await mysqlPool.getConnection();
      } catch {
        return fail("DB busy");
      }

      try {
        await conn.beginTransaction();

        const [[ord]] = await conn.query(
          `
          SELECT order_id, delivery_status, delivery_driver_id
          FROM orders
          WHERE order_id = ?
          FOR UPDATE
          `,
          [order_id],
        );

        if (!ord) {
          await conn.rollback();
          return fail("Order not found");
        }

        if (String(ord.delivery_driver_id) !== String(driver_id)) {
          await conn.rollback();
          return fail("Order not assigned to this driver");
        }

        if (ord.delivery_status === "DELIVERED") {
          await conn.rollback();
          return ok({ info: "already delivered" });
        }

        await conn.execute(
          `
          UPDATE orders
          SET delivery_status = 'DELIVERED',
              status = 'DELIVERED',
              delivered_at = NOW()
          WHERE order_id = ?
          `,
          [order_id],
        );

        await conn.commit();

        socket.emit("deliveryDropUpdated", { order_id, status: "DELIVERED" });
        ok({ order_id, status: "DELIVERED" });
      } catch (e) {
        try {
          await conn.rollback();
        } catch {}
        console.error("[deliveryDropUpdate] error:", e);
        fail("Server error");
      } finally {
        try {
          conn.release();
        } catch {}
      }
    });

    /* ===================== POOL booking stage events ===================== */

    socket.on(
      "bookingArrived",
      async ({ request_id, booking_id } = {}, ack) => {
        const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
        const fail = (error) => safeAck(ack, { ok: false, error });

        const rideId = Number(request_id);
        const bkId = Number(booking_id);
        if (!Number.isFinite(rideId) || !Number.isFinite(bkId))
          return fail("Bad IDs");

        let conn;
        try {
          conn = await mysqlPool.getConnection();
        } catch {
          return fail("Server busy, please try again");
        }

        try {
          await conn.beginTransaction();

          const [[curBk]] = await conn.query(
            `
          SELECT status, passenger_id
          FROM ride_bookings
          WHERE ride_id = ? AND booking_id = ?
          FOR UPDATE
          `,
            [rideId, bkId],
          );

          if (!curBk) {
            await conn.rollback();
            return fail("Booking not found");
          }

          const passenger_id = curBk.passenger_id ?? null;

          if (
            !["accepted", "requested", "arrived_pickup"].includes(curBk.status)
          ) {
            if (curBk.status === "arrived_pickup") {
              await emitPoolSummary(io, conn, rideId);
              await conn.commit();
              const msg = {
                request_id: String(rideId),
                booking_id: String(bkId),
                stage: "arrived_pickup",
              };
              io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
              if (passenger_id)
                io.to(passengerRoom(passenger_id)).emit(
                  "bookingStageUpdate",
                  msg,
                );
              return ok({ info: "idempotent" });
            }
            await conn.rollback();
            return fail(
              `Not in a state that can arrive (current=${curBk.status})`,
            );
          }

          await conn.execute(
            `
          UPDATE ride_bookings
          SET status='arrived_pickup', arrived_pickup_at=NOW()
          WHERE ride_id=? AND booking_id=?
          `,
            [rideId, bkId],
          );

          const [rideLift] = await conn.execute(
            `
          UPDATE rides
          SET status='arrived_pickup',
              arrived_pickup_at = COALESCE(arrived_pickup_at, NOW())
          WHERE ride_id=? AND status IN ('requested','accepted')
          `,
            [rideId],
          );

          await emitPoolSummary(io, conn, rideId);
          await conn.commit();

          if (rideLift.affectedRows > 0) {
            io.to(rideRoom(rideId)).emit("rideStageUpdate", {
              request_id: String(rideId),
              stage: "arrived_pickup",
            });
            if (passenger_id) {
              io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "arrived_pickup",
              });
            }
          }

          const msg = {
            request_id: String(rideId),
            booking_id: String(bkId),
            stage: "arrived_pickup",
          };
          io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
          if (passenger_id)
            io.to(passengerRoom(passenger_id)).emit("bookingStageUpdate", msg);

          ok();
        } catch (e) {
          try {
            await conn.rollback();
          } catch {}
          console.error("[bookingArrived] error:", e?.message || e);
          fail("Server error");
        } finally {
          try {
            conn.release();
          } catch {}
        }
      },
    );

    socket.on(
      "bookingOnboard",
      async ({ request_id, booking_id } = {}, ack) => {
        const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
        const fail = (error) => safeAck(ack, { ok: false, error });

        const rideId = Number(request_id);
        const bkId = Number(booking_id);
        if (!Number.isFinite(rideId) || !Number.isFinite(bkId))
          return fail("Bad IDs");

        let conn;
        try {
          conn = await mysqlPool.getConnection();
        } catch {
          return fail("Server busy, please try again");
        }

        try {
          await conn.beginTransaction();

          const [[curBk]] = await conn.query(
            `
          SELECT status, passenger_id
          FROM ride_bookings
          WHERE ride_id=? AND booking_id=?
          FOR UPDATE
          `,
            [rideId, bkId],
          );

          if (!curBk) {
            await conn.rollback();
            return fail("Booking not found");
          }

          const passenger_id = curBk.passenger_id ?? null;
          const curStatus = curBk.status;

          if (curStatus === "started") {
            await emitPoolSummary(io, conn, rideId);
            await conn.commit();
            const msg = {
              request_id: String(rideId),
              booking_id: String(bkId),
              stage: "started",
            };
            io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit(
                "bookingStageUpdate",
                msg,
              );
            return ok({ info: "idempotent" });
          }

          if (
            !["requested", "accepted", "arrived_pickup"].includes(curStatus)
          ) {
            await conn.rollback();
            return fail(`Not in a state that can start (current=${curStatus})`);
          }

          if (curStatus === "requested" || curStatus === "accepted") {
            await conn.execute(
              `
            UPDATE ride_bookings
            SET status='arrived_pickup',
                arrived_pickup_at = COALESCE(arrived_pickup_at, NOW())
            WHERE ride_id=? AND booking_id=?
            `,
              [rideId, bkId],
            );
          }

          await conn.execute(
            `
          UPDATE ride_bookings
          SET status='started', started_at=NOW()
          WHERE ride_id=? AND booking_id=?
          `,
            [rideId, bkId],
          );

          const [rideLift] = await conn.execute(
            `
          UPDATE rides
          SET status='started',
              started_at = COALESCE(started_at, NOW())
          WHERE ride_id=? AND status IN ('requested','accepted','arrived_pickup')
          `,
            [rideId],
          );

          await emitPoolSummary(io, conn, rideId);
          await conn.commit();

          if (rideLift.affectedRows > 0) {
            io.to(rideRoom(rideId)).emit("rideStageUpdate", {
              request_id: String(rideId),
              stage: "started",
            });
            if (passenger_id) {
              io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
                request_id: String(rideId),
                stage: "started",
              });
            }
          }

          const msg = {
            request_id: String(rideId),
            booking_id: String(bkId),
            stage: "started",
          };
          io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
          if (passenger_id)
            io.to(passengerRoom(passenger_id)).emit("bookingStageUpdate", msg);

          ok();
        } catch (e) {
          try {
            await conn.rollback();
          } catch {}
          console.error("[bookingOnboard] error:", e?.message || e);
          fail("Server error");
        } finally {
          try {
            conn.release();
          } catch {}
        }
      },
    );

    socket.on(
      "bookingDropped",
      async ({ request_id, booking_id } = {}, ack) => {
        const ok = (data = {}) => safeAck(ack, { ok: true, ...data });
        const fail = (error) => safeAck(ack, { ok: false, error });

        const rideId = Number(request_id);
        const bkId = Number(booking_id);
        if (!Number.isFinite(rideId) || !Number.isFinite(bkId))
          return fail("Bad IDs");

        let conn;
        try {
          conn = await mysqlPool.getConnection();
        } catch {
          return fail("Server busy, please try again");
        }

        try {
          await conn.beginTransaction();

          const [[curBk]] = await conn.query(
            `
          SELECT status, passenger_id
          FROM ride_bookings
          WHERE ride_id=? AND booking_id=?
          FOR UPDATE
          `,
            [rideId, bkId],
          );

          if (!curBk) {
            await conn.rollback();
            return fail("Booking not found");
          }

          const passenger_id = curBk.passenger_id ?? null;

          if (curBk.status === "completed") {
            await emitPoolSummary(io, conn, rideId);
            await conn.commit();
            const msg = {
              request_id: String(rideId),
              booking_id: String(bkId),
              stage: "completed",
            };
            io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
            if (passenger_id)
              io.to(passengerRoom(passenger_id)).emit(
                "bookingStageUpdate",
                msg,
              );
            return ok({ info: "idempotent" });
          }

          if (curBk.status !== "started") {
            await conn.rollback();
            return fail(
              `Not in a state that can drop (current=${curBk.status})`,
            );
          }

          await conn.execute(
            `
          UPDATE ride_bookings
          SET status='completed', completed_at=NOW()
          WHERE ride_id=? AND booking_id=?
          `,
            [rideId, bkId],
          );

          const [[pending]] = await conn.query(
            `
          SELECT COUNT(*) AS cnt
          FROM ride_bookings
          WHERE ride_id=? AND status IN ('requested','accepted','arrived_pickup','started')
          `,
            [rideId],
          );

          const anyActive = Number(pending?.cnt || 0) > 0;

          await emitPoolSummary(io, conn, rideId);
          await conn.commit();

          const msg = {
            request_id: String(rideId),
            booking_id: String(bkId),
            stage: "completed",
          };
          io.to(rideRoom(rideId)).emit("bookingStageUpdate", msg);
          if (passenger_id)
            io.to(passengerRoom(passenger_id)).emit("bookingStageUpdate", msg);

          if (!anyActive) {
            handleDriverCompleteTrip({
              io,
              socket,
              mysqlPool,
              payload: { request_id: rideId },
            });
            return ok({ ride_completed: true });
          }

          ok({ ride_completed: false });
        } catch (e) {
          try {
            await conn.rollback();
          } catch {}
          console.error("[bookingDropped] error:", e?.message || e);
          fail("Server error");
        } finally {
          try {
            conn.release();
          } catch {}
        }
      },
    );

    /* ===================== Matching compat ===================== */
    socket.on("offer:accept", ({ request_id, batch_id } = {}) => {
      const driver_id = socket.data.driver_id;
      const batch = batch_id ?? socket.data.batch_id ?? null;
      if (!driver_id || !request_id) return;
      handleJobAccept({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id, batch_id: batch },
      });
    });

    socket.on("offer:reject", ({ request_id, reason = "reject" } = {}) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id || !request_id) return;
      handleJobReject({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id, reason },
      });
    });

    socket.on("offer:timeout", ({ request_id } = {}) => {
      const driver_id = socket.data.driver_id;
      if (!driver_id || !request_id) return;
      handleJobReject({
        io,
        socket,
        mysqlPool,
        payload: { request_id, driver_id, reason: "timeout" },
      });
    });

    /* -------- Disconnect -------- */
    socket.on("disconnect", async (reason) => {
      console.log("[socket] disconnected:", socket.id, reason);

      const id = socket.data?.driver_id;
      if (id && liveSocketByDriver.get(id) === socket.id)
        liveSocketByDriver.delete(id);

      if (socket.data.role === "driver" && id) {
        const room = io.sockets.adapter.rooms.get(driverRoom(id));
        const stillHasConn = room && room.size > 0;

        if (!stillHasConn) {
          try {
            await DriverOnlineSession.updateOne(
              { driver_id: id, ended_at: null },
              { $set: { ended_at: new Date() } },
            );
          } catch (e) {
            console.error("[disconnect] failed to close online session", e);
          }
        }

        try {
          await presence.setOffline(id, socket.id);
        } catch {}
      }
    });
  });
}

/* ========================================================================
   Event implementations (ride lifecycle + delivery merchant notify)
   ======================================================================== */

async function handleJobAccept({ io, socket, mysqlPool, payload }) {
  const where = "[jobAccept]";
  try {
    const { request_id, driver_id: rawDriverId, batch_id } = payload || {};

    if (!request_id || !rawDriverId) {
      return socket.emit("jobAssigned", {
        ok: false,
        error: "Missing request_id or driver_id",
      });
    }
    if (!mysqlPool?.getConnection) {
      console.error(`${where} mysqlPool not ready`);
      return socket.emit("jobAssigned", {
        ok: false,
        error: "Server DB not ready",
      });
    }

    const conn = await mysqlPool.getConnection();

    try {
      await conn.beginTransaction();

      const canonicalDriverId = await resolveDriverId(conn, rawDriverId);
      if (!canonicalDriverId) {
        await conn.rollback();
        return socket.emit("jobAssigned", {
          ok: false,
          request_id,
          error: `Driver not found for id ${rawDriverId}`,
        });
      }

      const [res] = await conn.execute(
        `
        UPDATE rides
        SET driver_id = ?,
            status = 'accepted',
            accepted_at = NOW(),
            offer_driver_id = NULL,
            offer_expire_at = NULL
        WHERE ride_id = ?
          AND status IN ('offered_to_driver','requested')
        `,
        [canonicalDriverId, request_id],
      );

      // delivery: assign orders in batch
      if (batch_id != null) {
        const batchIdNum = Number(batch_id);
        if (Number.isFinite(batchIdNum)) {
          const [deliveryRes] = await conn.execute(
            `
            UPDATE orders
            SET delivery_driver_id = ?,
                delivery_ride_id = ?,
                delivery_status = 'ASSIGNED',
                status = 'ASSIGNED'
            WHERE delivery_batch_id = ?
              AND (status = 'PENDING' OR delivery_status = 'PENDING')
            `,
            [canonicalDriverId, request_id, batchIdNum],
          );
          console.log(
            "[jobAccept] delivery orders updated:",
            deliveryRes.affectedRows,
          );
        }
      }

      if (!res || res.affectedRows === 0) {
        await conn.rollback();
        return socket.emit("jobAssigned", {
          ok: false,
          request_id,
          error: "Ride no longer available",
        });
      }

      const [[ride]] = await conn.query(
        `
        SELECT
          r.ride_id,
          r.driver_id,
          r.passenger_id,
          r.status,
          r.pickup_place,
          r.dropoff_place,
          r.pickup_lat,
          r.pickup_lng,
          r.dropoff_lat,
          r.dropoff_lng,
          r.distance_m,
          r.duration_s,
          r.currency,
          r.fare_cents,
          r.requested_at,
          r.accepted_at,
          r.arrived_pickup_at,
          r.started_at,
          r.completed_at,
          r.service_type,
          r.trip_type,
          r.pool_batch_id,
          u.user_name AS driver_name,
          u.phone AS driver_phone,
          (SELECT COUNT(*)
             FROM rides rr
            WHERE rr.driver_id = r.driver_id
              AND rr.status = 'completed') AS driver_trips,
          (SELECT ROUND(AVG(${RATING_COLUMN}), 2)
             FROM ${RATINGS_TABLE} drt
            WHERE drt.driver_id = r.driver_id) AS driver_rating,
          (SELECT COUNT(*)
             FROM ${RATINGS_TABLE} drt2
            WHERE drt2.driver_id = r.driver_id) AS driver_ratings_count,
          NULL AS vehicle_label,
          NULL AS vehicle_plate
        FROM rides r
        LEFT JOIN drivers dr ON dr.driver_id = r.driver_id
        LEFT JOIN users u ON u.user_id = dr.user_id
        WHERE r.ride_id = ?
        LIMIT 1
        `,
        [request_id],
      );

      await conn.commit();

      // Redis enrich: payment, waypoints, delivery meta
      const r = getRedis();
      let payment_method = null;
      let offer_code = null;
      let waypoints = [];
      let stops_count = 0;

      let job_type = "SINGLE";
      let batch_id_out = null;
      let drops = [];
      let service_code = null;

      try {
        const h = await r.hgetall(rideHash(String(request_id)));

        if (h?.payment_method) {
          try {
            payment_method = JSON.parse(h.payment_method);
          } catch {
            payment_method = h.payment_method;
          }
        }
        if (h?.offer_code) offer_code = h.offer_code || null;

        if (h?.waypoints_json) {
          try {
            waypoints = JSON.parse(h.waypoints_json) || [];
          } catch {
            waypoints = [];
          }
        }

        if (h?.stops_count != null) {
          const sc = Number(h.stops_count);
          if (Number.isFinite(sc)) stops_count = sc;
        }

        if (h?.service_code) service_code = String(h.service_code);

        if (h?.job_type) job_type = String(h.job_type).toUpperCase();
        if (h?.batch_id != null && h.batch_id !== "") {
          const bn = Number(h.batch_id);
          if (Number.isFinite(bn)) batch_id_out = bn;
        }

        if (h?.drops_json) {
          try {
            const parsed = JSON.parse(h.drops_json);
            drops = Array.isArray(parsed) ? parsed : [];
          } catch {
            drops = [];
          }
        }
      } catch (e) {
        dbg("[jobAccept] redis enrich warn:", e?.message);
      }

      try {
        socket.join(driverRoom(String(canonicalDriverId)));
      } catch {}
      socket.join(rideRoom(request_id));

      const rideOut = {
        ...toClientRide(ride),
        payment_method,
        offer_code,
        waypoints,
        stops_count,
        service_code: service_code || null,
        job_type,
        batch_id: batch_id_out,
        drops,
      };

      io.to(driverRoom(String(canonicalDriverId))).emit("jobAssigned", {
        ok: true,
        request_id,
        ride: rideOut,
      });
      io.to(driverRoom(String(rawDriverId))).emit("jobAssigned", {
        ok: true,
        request_id,
        ride: rideOut,
      });

      if (ride?.passenger_id) {
        const msg = { request_id, driver_id: canonicalDriverId, ride: rideOut };
        io.to(passengerRoom(ride.passenger_id)).emit("rideAccepted", msg);
        io.to(rideRoom(request_id)).emit("rideAccepted", msg);
      }

      if (ride?.trip_type === "pool") {
        let acceptedBookings = [];
        try {
          const c2 = await mysqlPool.getConnection();
          try {
            const [bkRows] = await c2.query(
              `
              SELECT booking_id, passenger_id, seats, pickup_place, dropoff_place,
                     pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                     fare_cents, currency
              FROM ride_bookings
              WHERE ride_id = ?
                AND status = 'accepted'
              `,
              [request_id],
            );
            acceptedBookings = bkRows || [];
          } finally {
            c2.release();
          }
        } catch {}

        for (const b of acceptedBookings) {
          const msg = {
            ok: true,
            request_id,
            booking_id: String(b.booking_id),
            driver_id: canonicalDriverId,
            seats: Number(b.seats),
            pickup: b.pickup_place,
            dropoff: b.dropoff_place,
            pickup_lat: b.pickup_lat,
            pickup_lng: b.pickup_lng,
            dropoff_lat: b.dropoff_lat,
            dropoff_lng: b.dropoff_lng,
            fare_cents: b.fare_cents,
            currency: b.currency,
          };
          io.to(passengerRoom(b.passenger_id)).emit("bookingAccepted", msg);
          io.to(rideRoom(request_id)).emit("bookingAccepted", msg);
        }

        try {
          const c3 = await mysqlPool.getConnection();
          try {
            await emitPoolSummary(io, c3, request_id);
          } finally {
            c3.release();
          }
        } catch {}
      }

      socket.broadcast.emit("rideClosed", { request_id });
      socket.broadcast.emit("jobRequestCancelled", { request_id });

      try {
        await matcher.acceptOffer({
          io,
          rideId: String(request_id),
          driverId: String(canonicalDriverId),
        });
      } catch (e) {
        console.warn("[matcher.acceptOffer] warn:", e?.message);
      }
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[jobAccept] error]", err);
    socket.emit("jobAssigned", { ok: false, error: "Server error" });
  }
}

async function handleJobReject({ io, socket, mysqlPool, payload }) {
  try {
    const { request_id, driver_id: rawDriverId } = payload || {};
    if (!request_id || !rawDriverId) {
      return socket.emit("jobRejectedAck", {
        ok: false,
        error: "Missing request_id or driver_id",
      });
    }

    const conn = await mysqlPool.getConnection();

    try {
      await conn.beginTransaction();

      const canonicalDriverId = await resolveDriverId(conn, rawDriverId);
      if (!canonicalDriverId) {
        await conn.rollback();
        return socket.emit("jobRejectedAck", {
          ok: false,
          error: `Driver not found for id ${rawDriverId}`,
        });
      }

      const [res] = await conn.execute(
        `
        UPDATE rides
        SET status = 'requested',
            offer_driver_id = NULL,
            offer_expire_at = NULL,
            accepted_at = NULL,
            driver_id = NULL
        WHERE ride_id = ?
          AND status = 'offered_to_driver'
          AND (offer_driver_id IS NULL OR offer_driver_id = ?)
        `,
        [request_id, canonicalDriverId],
      );

      if (!res || res.affectedRows === 0) {
        await conn.rollback();
        return socket.emit("jobRejectedAck", {
          ok: false,
          request_id,
          error:
            "Ride not in 'offered_to_driver' or not offered to this driver",
        });
      }

      const [[row]] = await conn.query(
        "SELECT passenger_id FROM rides WHERE ride_id = ?",
        [request_id],
      );

      await conn.commit();

      socket.emit("jobRejectedAck", { ok: true, request_id });

      if (row?.passenger_id) {
        io.to(passengerRoom(row.passenger_id)).emit("rideOfferDeclined", {
          request_id,
          by_driver_id: canonicalDriverId,
        });
      }

      io.emit("rideReopened", { request_id });

      try {
        await matcher.rejectOffer({
          io,
          rideId: String(request_id),
          driverId: String(canonicalDriverId),
        });
      } catch (e) {
        console.warn("[matcher.rejectOffer] warn:", e?.message);
      }
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      throw e;
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[jobReject] error:", err);
    socket.emit("jobRejectedAck", { ok: false, error: "Server error" });
  }
}

async function handleDriverArrivedPickup({ io, socket, mysqlPool, payload }) {
  const { request_id } = payload || {};
  if (!request_id) {
    return socket.emit("driverArrivedAck", {
      ok: false,
      error: "Missing request_id",
    });
  }

  const conn = await mysqlPool.getConnection();

  try {
    await conn.beginTransaction();

    const [[cur]] = await conn.query(
      "SELECT status, trip_type FROM rides WHERE ride_id = ?",
      [request_id],
    );

    const [res] = await conn.execute(
      `
      UPDATE rides
      SET status = 'arrived_pickup',
          arrived_pickup_at = NOW()
      WHERE ride_id = ?
        AND status = 'accepted'
      `,
      [request_id],
    );

    if (res.affectedRows === 0) {
      await conn.rollback();
      return socket.emit("driverArrivedAck", {
        ok: false,
        request_id,
        error: "Ride not in 'accepted' state",
      });
    }

    if (cur?.trip_type === "pool") {
      await conn.execute(
        `
        UPDATE ride_bookings
        SET status = 'arrived_pickup',
            arrived_pickup_at = NOW()
        WHERE ride_id = ?
          AND status IN ('requested','accepted')
        `,
        [request_id],
      );
    }

    // DELIVERY: ASSIGNED -> PICKED_UP
    try {
      const r = getRedis();
      const h = await r.hgetall(rideHash(String(request_id)));
      const jobType = String(h?.job_type || "SINGLE").toUpperCase();
      const batchId =
        h?.batch_id != null && h.batch_id !== "" ? Number(h.batch_id) : null;

      if (jobType === "BATCH" && Number.isFinite(batchId)) {
        await conn.execute(
          `
          UPDATE orders
          SET delivery_status = 'PICKED_UP',
              status = 'PICKED_UP'
          WHERE delivery_batch_id = ?
            AND delivery_ride_id = ?
            AND delivery_status = 'ASSIGNED'
          `,
          [batchId, String(request_id)],
        );
      } else {
        await conn.execute(
          `
          UPDATE orders
          SET delivery_status = 'PICKED_UP',
              status = 'PICKED_UP'
          WHERE delivery_ride_id = ?
            AND delivery_status = 'ASSIGNED'
          `,
          [String(request_id)],
        );
      }
    } catch (e) {
      console.warn(
        "[driverArrivedPickup] orders PICKED_UP update skipped:",
        e?.message || e,
      );
    }

    await conn.commit();

    // merchant notify
    try {
      const cM = await mysqlPool.getConnection();
      try {
        await emitMerchantDriverArrived({ io, conn: cM, request_id });
      } finally {
        cM.release();
      }
    } catch {}

    // pool summary
    if (cur?.trip_type === "pool") {
      try {
        const c2 = await mysqlPool.getConnection();
        try {
          await emitPoolSummary(io, c2, request_id);
        } finally {
          c2.release();
        }
      } catch {}
    }

    let passenger_id = null;
    try {
      const c3 = await mysqlPool.getConnection();
      try {
        passenger_id = await getPassengerId(c3, request_id);
      } finally {
        c3.release();
      }
    } catch {}

    socket.emit("driverArrivedAck", { ok: true, request_id });

    logStage(io, request_id, "arrived_pickup", passenger_id);

    io.to(rideRoom(request_id)).emit("rideStageUpdate", {
      request_id,
      stage: "arrived_pickup",
    });

    if (cur?.trip_type === "pool") {
      io.to(rideRoom(request_id)).emit("bookingStageUpdate", {
        request_id,
        stage: "arrived_pickup",
      });
    }

    if (passenger_id) {
      io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
        request_id,
        stage: "arrived_pickup",
      });
    }
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[driverArrivedPickup] error:", err);
    socket.emit("driverArrivedAck", {
      ok: false,
      request_id,
      error: "Server error",
    });
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

async function handleDriverStartTrip({ io, socket, mysqlPool, payload }) {
  const { request_id } = payload || {};
  if (!request_id) {
    return socket.emit("driverStartAck", {
      ok: false,
      error: "Missing request_id",
    });
  }

  const conn = await mysqlPool.getConnection();

  try {
    await conn.beginTransaction();

    const [[cur]] = await conn.query(
      "SELECT status, trip_type, driver_id, passenger_id, pickup_place, dropoff_place FROM rides WHERE ride_id = ?",
      [request_id],
    );

    const [res] = await conn.execute(
      `
      UPDATE rides
      SET status = 'started',
          started_at = NOW()
      WHERE ride_id = ?
        AND status = 'arrived_pickup'
      `,
      [request_id],
    );

    if (res.affectedRows === 0) {
      await conn.rollback();
      return socket.emit("driverStartAck", {
        ok: false,
        request_id,
        error: "Ride not in 'arrived_pickup' state",
      });
    }

    if (cur?.trip_type === "pool") {
      await conn.execute(
        `
        UPDATE ride_bookings
        SET status = 'started',
            started_at = NOW()
        WHERE ride_id = ?
          AND status = 'arrived_pickup'
        `,
        [request_id],
      );
    }

    // DELIVERY: PICKED_UP -> ON_ROAD
    try {
      const r = getRedis();
      const h = await r.hgetall(rideHash(String(request_id)));

      const jobType = String(h?.job_type || "SINGLE").toUpperCase();
      const batchId =
        h?.batch_id != null && h.batch_id !== "" ? Number(h.batch_id) : null;

      if (jobType === "BATCH" && Number.isFinite(batchId)) {
        await conn.execute(
          `
          UPDATE orders
          SET delivery_status = 'ON_ROAD',
              status = 'ON_ROAD'
          WHERE delivery_batch_id = ?
            AND delivery_ride_id = ?
            AND delivery_status = 'PICKED_UP'
          `,
          [batchId, String(request_id)],
        );
      } else {
        await conn.execute(
          `
          UPDATE orders
          SET delivery_status = 'ON_ROAD',
              status = 'ON_ROAD'
          WHERE delivery_ride_id = ?
            AND delivery_status = 'PICKED_UP'
          `,
          [String(request_id)],
        );
      }
    } catch (e) {
      console.warn(
        "[driverStartTrip] orders ON_ROAD update skipped:",
        e?.message || e,
      );
    }

    await conn.commit();

    // merchant notify
    try {
      const cM = await mysqlPool.getConnection();
      try {
        await emitMerchantOnRoad({ io, conn: cM, request_id });
      } finally {
        cM.release();
      }
    } catch {}

    // pool summary
    if (cur?.trip_type === "pool") {
      try {
        const c2 = await mysqlPool.getConnection();
        try {
          await emitPoolSummary(io, c2, request_id);
        } finally {
          c2.release();
        }
      } catch {}
    }

    const passenger_id = cur?.passenger_id ?? null;

    socket.emit("driverStartAck", { ok: true, request_id });

    logStage(io, request_id, "started", passenger_id);

    io.to(rideRoom(request_id)).emit("rideStageUpdate", {
      request_id,
      stage: "started",
    });

    if (cur?.trip_type === "pool") {
      io.to(rideRoom(request_id)).emit("bookingStageUpdate", {
        request_id,
        stage: "started",
      });
    }

    if (passenger_id) {
      io.to(passengerRoom(passenger_id)).emit("rideStageUpdate", {
        request_id,
        stage: "started",
      });
    }
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[driverStartTrip] error:", err);
    socket.emit("driverStartAck", {
      ok: false,
      request_id,
      error: "Server error",
    });
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

/* ---------------- started -> completed (whole ride) + wallet payout ---------------- */
async function handleDriverCompleteTrip({ io, socket, mysqlPool, payload }) {
  const { request_id } = payload || {};

  if (!request_id) {
    return socket.emit("fareFinalized", {
      ok: false,
      error: "Missing request_id",
    });
  }

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    /* -------------------------------------------------
       1) Lock ride row
    ------------------------------------------------- */

    const [[ride]] = await conn.query(
      `SELECT * FROM rides WHERE ride_id = ? FOR UPDATE`,
      [request_id],
    );

    if (!ride) {
      await conn.rollback();
      return socket.emit("fareFinalized", {
        ok: false,
        request_id,
        error: "Ride not found",
      });
    }

    // idempotency: if already completed, just return pricing snapshot if present
    if (ride.status === "completed") {
      await conn.rollback();
      return socket.emit("fareFinalized", {
        ok: true,
        request_id,
        info: "already_completed",
      });
    }

    if (!ride || ride.status !== "started") {
      await conn.rollback();
      return socket.emit("fareFinalized", {
        ok: false,
        request_id,
        error: "Ride not found or invalid state",
      });
    }

    /* -------------------------------------------------
       2) Mark ride completed
    ------------------------------------------------- */
    await conn.execute(
      `
      UPDATE rides
      SET status = 'completed',
          completed_at = NOW()
      WHERE ride_id = ?
      `,
      [request_id],
    );

    if (ride.trip_type === "pool") {
      await conn.execute(
        `
        UPDATE ride_bookings
        SET status = 'completed',
            completed_at = NOW()
        WHERE ride_id = ?
          AND status = 'started'
        `,
        [request_id],
      );
    }

    /* -------------------------------------------------
       3) Pricing engine (single source of truth)
    ------------------------------------------------- */
    const pricing = await computePlatformFeeAndGST({
      country_code: "BT",
      city_id: ride.city_id || "THIMPHU",
      service_type: ride.service_type,
      trip_type: ride.trip_type || "instant",
      channel: "app",
      subtotal_cents: Number(ride.base_fare_cents),
      total_cents: Number(ride.fare_cents),
    });

    const amounts = pricing?.amounts || {};
    const matched = pricing?.matched_rules || {};
    const pfRule = matched?.platform_fee_rule || null;
    const taxRule = matched?.tax_rule || null;

    const platform_fee_cents = Number(amounts.platform_fee_cents || 0);
    const gst_cents = Number(amounts.gst_cents || 0);
    const total_payable_cents = Number(amounts.total_payable_cents || 0);
    const driver_payout_cents = Number(amounts.driver_payout_cents || 0);
    const driver_payout_nu = Number(amounts.driver_payout_nu || 0);

    console.log("Total payable cents : ", total_payable_cents);

    /* -------------------------------------------------
       4) Pricing snapshot (audit safe)
    ------------------------------------------------- */
    await conn.execute(
      `
      INSERT INTO ride_pricing_snapshots
        (ride_id, platform_fee_cents, gst_cents,
         total_payable_cents, driver_payout_cents,
         platform_fee_rule_id, tax_rule_id)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        platform_fee_cents = VALUES(platform_fee_cents),
        gst_cents = VALUES(gst_cents),
        total_payable_cents = VALUES(total_payable_cents),
        driver_payout_cents = VALUES(driver_payout_cents),
        platform_fee_rule_id = VALUES(platform_fee_rule_id),
        tax_rule_id = VALUES(tax_rule_id)
      `,
      [
        Number(request_id),
        platform_fee_cents,
        gst_cents,
        total_payable_cents,
        driver_payout_cents,
        pfRule?.rule_id || null,
        taxRule?.tax_rule_id || null,
      ],
    );

    /* -------------------------------------------------
       5) DRIVER EARNINGS (ALWAYS – cash or wallet)
       Uses YOUR schema
    ------------------------------------------------- */
    await conn.execute(
      `
      INSERT INTO driver_earnings
        (driver_id, ride_id,
         base_fare_cents, time_cents, tips_cents, currency)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        base_fare_cents = VALUES(base_fare_cents),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        Number(ride.driver_id),
        Number(request_id),
        Number(driver_payout_cents || 0),
        0,
        0,
        "BTN",
      ],
    );

    /* -------------------------------------------------
       6) PLATFORM LEVIES (ALWAYS)
       - This is what we deduct/associate against the driver’s ride
       - v_driver_payouts uses this to compute net driver payout
    ------------------------------------------------- */
    await conn.execute(
      `
      INSERT INTO platform_levies
        (driver_id, ride_id,
         platform_fee_cents, tax_cents, currency,
         fee_rule_id, tax_rule_id)
      VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        platform_fee_cents = VALUES(platform_fee_cents),
        tax_cents = VALUES(tax_cents),
        currency = VALUES(currency),
        fee_rule_id = VALUES(fee_rule_id),
        tax_rule_id = VALUES(tax_rule_id),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        Number(ride.driver_id),
        Number(request_id),
        platform_fee_cents,
        gst_cents,
        ride.currency || "BTN",
        pfRule?.rule_id || null,
        taxRule?.tax_rule_id || null,
      ],
    );

    /* -------------------------------------------------
       7) PLATFORM REVENUE (TRANSPORT)
       Table requires commission fields.
       Your current pricing: GST is on top (tax_inclusive=0)
       -> net_revenue is platform_fee (GST is not income)
    ------------------------------------------------- */
    const feeType = String(pfRule?.fee_type || "percent").toLowerCase();
    const commission_type = feeType === "fixed" ? "FIXED" : "PERCENT";

    const commission_rate_bp = 0;

    const commission_fixed_cents = 0;

    await conn.execute(
      `
      INSERT INTO platform_revenue
        (source_type, source_id,
         gross_amount_cents, tax_cents, net_revenue_cents,
         commission_type, commission_rate_bp, commission_fixed_cents)
      VALUES ('TRANSPORT', ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        gross_amount_cents = VALUES(gross_amount_cents),
        tax_cents = VALUES(tax_cents),
        net_revenue_cents = VALUES(net_revenue_cents),
        commission_type = VALUES(commission_type),
        commission_rate_bp = VALUES(commission_rate_bp),
        commission_fixed_cents = VALUES(commission_fixed_cents)
      `,
      [
        String(request_id), // VARCHAR(64)
        platform_fee_cents, // before tax
        gst_cents, // GST collected
        platform_fee_cents - gst_cents, // your income (GST excluded)
        commission_type,
        commission_rate_bp,
        commission_fixed_cents,
      ],
    );

    /* -------------------------------------------------
       7) GST ledger (government liability)
    ------------------------------------------------- */
    if (gst_cents > 0) {
      await conn.execute(
        `
        INSERT INTO tax_ledger
          (source_type, source_id, tax_type, tax_amount_cents)
        VALUES ('TRANSPORT', ?, 'GST', ?)
        ON DUPLICATE KEY UPDATE
          tax_amount_cents = VALUES(tax_amount_cents)
        `,
        [Number(request_id), Number(gst_cents)],
      );
    }

    /* -------------------------------------------------
       8) Wallet transfer (ONLY if wallet + valid amount)
    ------------------------------------------------- */
    const payment_method = await getRidePaymentMethodFromRedis(request_id);
    const isWallet = isWalletPayment(payment_method);

    let walletResult = { ok: false, reason: "not_wallet_payment" };

    const payoutNu = Number(driver_payout_nu);

    if (isWallet && Number.isFinite(payoutNu) && payoutNu > 0) {
      const { wallet_id: driver_wallet } = await getDriverUserAndWallet(
        conn,
        ride.driver_id,
      );

      const { wallet_id: passenger_wallet } = await getPassengerUserAndWallet(
        conn,
        ride.passenger_id,
      );

      if (driver_wallet && passenger_wallet) {
        walletResult = await walletTransfer(conn, {
          from_wallet: passenger_wallet,
          to_wallet: driver_wallet,
          driver_credit_nu: Number(pricing.amounts.driver_payout_nu).toFixed(2), // ✅ important
          passenger_debit_nu: Number(pricing.amounts.total_payable_nu).toFixed(
            2,
          ), // ✅ important
          reason: "RIDE_PAYOUT",
          meta: {
            ride_id: request_id,
            service_type: ride.service_type,
            payment_method,
          },
        });
      } else {
        walletResult = { ok: false, reason: "wallet_missing" };
      }
    }

    await conn.commit();

    /* -------------------------------------------------
       9) Emit events
    ------------------------------------------------- */
    const out = {
      ok: true,
      request_id,
      pricing,
      wallet: walletResult,
    };

    io.to(rideRoom(request_id)).emit("fareFinalized", out);
    if (ride.passenger_id) {
      io.to(passengerRoom(ride.passenger_id)).emit("fareFinalized", out);
    }
    socket.emit("fareFinalized", out);
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[handleDriverCompleteTrip] error:", err);

    socket.emit("fareFinalized", {
      ok: false,
      request_id,
      error: "Server error",
    });
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

/* ---------------- Merchant Notifiers ---------------- */

async function emitMerchantDriverAccepted({ io, conn, request_id }) {
  const redis = getRedis();
  let job_type = "SINGLE";
  let batch_id = null;

  try {
    const h = await redis.hgetall(rideHash(String(request_id)));
    if (h?.job_type) job_type = String(h.job_type).toUpperCase();
    if (h?.batch_id != null && h.batch_id !== "") {
      const bn = Number(h.batch_id);
      if (Number.isFinite(bn)) batch_id = bn;
    }
  } catch {}

  let businessRows = [];

  if (batch_id != null) {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders
      WHERE delivery_batch_id = ?
      `,
      [batch_id],
    );
    businessRows = rows || [];
  } else {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders WHERE delivery_ride_id = ?
      `,
      [String(request_id)],
    );
    businessRows = rows || [];
  }

  const businesses = [
    ...new Set(businessRows.map((r) => r.business_id).filter(Boolean)),
  ];

  businesses.forEach((bid) => {
    io.to(merchantRoom(String(bid))).emit("deliveryDriverAccepted", {
      request_id: String(request_id),
      batch_id,
      job_type,
      stage: "accepted",
      orders: businessRows
        .filter((r) => String(r.business_id) === String(bid))
        .map((r) => r.order_id),
    });
  });

  console.log("[merchant notify] driver accepted", {
    request_id,
    batch_id,
    job_type,
    businesses,
  });
}

async function emitMerchantDriverArrived({ io, conn, request_id }) {
  const redis = getRedis();
  let job_type = "SINGLE";
  let batch_id = null;

  try {
    const h = await redis.hgetall(rideHash(String(request_id)));
    if (h?.job_type) job_type = String(h.job_type).toUpperCase();
    if (h?.batch_id != null && h.batch_id !== "") {
      const bn = Number(h.batch_id);
      if (Number.isFinite(bn)) batch_id = bn;
    }
  } catch {}

  let businessRows = [];

  if (batch_id != null) {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders
      WHERE delivery_batch_id = ?
      `,
      [batch_id],
    );
    businessRows = rows || [];
  } else {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders
      WHERE delivery_ride_id = ?
      `,
      [String(request_id)],
    );
    businessRows = rows || [];
  }

  const businesses = [
    ...new Set(businessRows.map((r) => r.business_id).filter(Boolean)),
  ];

  businesses.forEach((bid) => {
    io.to(merchantRoom(String(bid))).emit("deliveryDriverArrived", {
      request_id: String(request_id),
      batch_id,
      job_type,
      stage: "arrived_pickup",
      orders: businessRows
        .filter((r) => String(r.business_id) === String(bid))
        .map((r) => r.order_id),
    });
  });

  console.log("[merchant notify] driver arrived", {
    request_id,
    batch_id,
    job_type,
    businesses,
  });
}

async function emitMerchantOnRoad({ io, conn, request_id }) {
  const redis = getRedis();
  let job_type = "SINGLE";
  let batch_id = null;

  try {
    const h = await redis.hgetall(rideHash(String(request_id)));
    if (h?.job_type) job_type = String(h.job_type).toUpperCase();
    if (h?.batch_id != null && h.batch_id !== "") {
      const bn = Number(h.batch_id);
      if (Number.isFinite(bn)) batch_id = bn;
    }
  } catch {}

  let businessRows = [];

  if (batch_id != null) {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders
      WHERE delivery_batch_id = ?
      `,
      [batch_id],
    );
    businessRows = rows || [];
  } else {
    const [rows] = await conn.query(
      `
      SELECT DISTINCT business_id, order_id
      FROM orders
      WHERE delivery_ride_id = ?
      `,
      [String(request_id)],
    );
    businessRows = rows || [];
  }

  const businesses = [
    ...new Set(businessRows.map((r) => r.business_id).filter(Boolean)),
  ];

  businesses.forEach((bid) => {
    const room = merchantRoom(String(bid));
    const orders = businessRows
      .filter((r) => String(r.business_id) === String(bid))
      .map((r) => r.order_id);

    io.to(room).emit("deliveryOnRoad", {
      request_id: String(request_id),
      batch_id,
      job_type,
      stage: "on_road",
      orders,
    });

    console.log(
      `[notify->merchant] event=deliveryOnRoad room=${room} sockets=${roomSize(
        io,
        room,
      )} orders=${orders.length} request_id=${request_id} batch_id=${
        batch_id ?? "-"
      }`,
    );
  });

  console.log("[merchant notify] driver on road", {
    request_id,
    batch_id,
    job_type,
    businesses,
  });
}
