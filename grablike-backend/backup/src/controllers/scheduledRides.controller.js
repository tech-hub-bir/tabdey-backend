// src/controllers/scheduledRides.controller.js
import { mysqlPool } from "../db/mysql.js";

/* ================= CONFIG ================= */
const RESERVE_TTL_MIN = 30; // initial hold
const DISPATCH_BEFORE_MIN = 15; // dispatch T-15
const RECONFIRM_BEFORE_MIN = 30; // reconfirm T-30

// ✅ MUST match rides.status enum exactly
const RIDE_STATUSES = [
  "scheduled",
  "reserved",
  "matching",
  "requested",
  "offered_to_driver",
  "accepted",
  "arrived_pickup",
  "started",
  "completed",
  "cancelled_driver",
  "cancelled_rider",
  "cancelled_system",
  "failed",
];

/* ================= HELPERS ================= */
function toIsoSafe(d) {
  try {
    if (!d) return null;
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  } catch {
    return null;
  }
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const t = Math.trunc(n);
  return Math.max(min, Math.min(max, t));
}

function parseBookingType(q) {
  const bt = q ? String(q).trim() : "";
  if (!bt) return null;
  return bt.toUpperCase();
}

function computeDispatchAt(scheduledAt) {
  const d = new Date(scheduledAt);
  d.setMinutes(d.getMinutes() - DISPATCH_BEFORE_MIN);
  return d;
}

function computeReconfirmAt(scheduledAt) {
  const d = new Date(scheduledAt);
  d.setMinutes(d.getMinutes() - RECONFIRM_BEFORE_MIN);
  return d;
}

function groupByStatus(rows) {
  const grouped = Object.fromEntries(RIDE_STATUSES.map((s) => [s, []]));
  const unknown = [];

  for (const r of rows || []) {
    const s = String(r.status || "");
    if (grouped[s]) grouped[s].push(r);
    else unknown.push(r);
  }

  if (unknown.length) grouped.__unknown = unknown; // optional
  return grouped;
}

async function resolveDriverId(conn, { driver_id, user_id }) {
  if (driver_id != null) {
    const d = Number(driver_id);
    if (Number.isFinite(d) && d > 0) return d;
  }

  if (user_id != null) {
    const u = Number(user_id);
    if (!Number.isFinite(u) || u <= 0) return null;

    const [[row]] = await conn.query(
      "SELECT driver_id FROM drivers WHERE user_id=? LIMIT 1",
      [u]
    );
    return row?.driver_id ? Number(row.driver_id) : null;
  }

  return null;
}

// ================= PASSENGER HELPERS =================
async function resolvePassengerId(conn, { passenger_id, user_id }) {
  // 1) explicit passenger_id
  if (passenger_id != null) {
    const p = Number(passenger_id);
    if (Number.isFinite(p) && p > 0) return p;
  }

  // 2) fallback: many systems store passenger_id == user_id
  if (user_id != null) {
    const u = Number(user_id);
    if (Number.isFinite(u) && u > 0) return u;
  }

  return null;
}

/* ================= COMMON: AUTO-RELEASE ================= */
async function autoReleaseExpiredScheduled(conn) {
  // ✅ Auto-release scheduled ride reservations (UTC safe)
  await conn.query(`
    UPDATE rides
    SET driver_id=NULL,
        reserved_at=NULL,
        reserved_confirmed_at=NULL,
        offer_expire_at=NULL
    WHERE booking_type='SCHEDULED'
      AND status='scheduled'
      AND driver_id IS NOT NULL
      AND offer_expire_at IS NOT NULL
      AND offer_expire_at <= UTC_TIMESTAMP()
  `);
}

/* =========================================================
   GET /api/scheduled-rides/driver/list
   ========================================================= */
export async function listScheduledRidesForDriver(req, res) {
  let conn;
  try {
    const { user_id, driver_id, days } = req.query || {};
    conn = await mysqlPool.getConnection();

    const myDriverId = await resolveDriverId(conn, { user_id, driver_id });
    if (!myDriverId) {
      return res.status(400).json({
        ok: false,
        error: "Valid user_id or driver_id required",
      });
    }

    const daysAhead = clampInt(days, 30, 1, 90);

    await autoReleaseExpiredScheduled(conn);

    const [rows] = await conn.query(
      `
      SELECT
        ride_id,
        passenger_id,
        service_type,
        trip_type,
        booking_type,
        status,
        scheduled_at,
        dispatch_at,
        reserved_at,
        reserved_confirmed_at,
        driver_id,
        offer_expire_at,
        pickup_place,
        dropoff_place,
        pickup_lat, pickup_lng,
        dropoff_lat, dropoff_lng,
        distance_m,
        duration_s,
        fare_cents,
        currency
      FROM rides
      WHERE booking_type='SCHEDULED'
        AND status='scheduled'
        AND scheduled_at IS NOT NULL
        AND scheduled_at >= (UTC_TIMESTAMP() - INTERVAL 2 MINUTE)
        AND scheduled_at <= (UTC_TIMESTAMP() + INTERVAL ? DAY)
        AND (driver_id IS NULL OR driver_id = ?)
      ORDER BY scheduled_at ASC
      LIMIT 200
      `,
      [daysAhead, myDriverId]
    );

    const data = rows.map((r) => {
      const scheduledAt = r.scheduled_at ? new Date(r.scheduled_at) : null;
      const reconfirmAt = scheduledAt ? computeReconfirmAt(scheduledAt) : null;

      const reservedDriverId = r.driver_id != null ? String(r.driver_id) : null;

      return {
        ride_id: String(r.ride_id),
        passenger_id: r.passenger_id ? String(r.passenger_id) : null,

        service_type: r.service_type,
        trip_type: r.trip_type,
        booking_type: r.booking_type,
        status: r.status,

        scheduled_at: toIsoSafe(r.scheduled_at),
        dispatch_at: toIsoSafe(r.dispatch_at),
        reconfirm_at: toIsoSafe(reconfirmAt),

        reserved_driver_id: reservedDriverId,
        reserved_until: toIsoSafe(r.offer_expire_at),
        reserved_at: toIsoSafe(r.reserved_at),
        reserved_confirmed_at: toIsoSafe(r.reserved_confirmed_at),
        is_mine: reservedDriverId === String(myDriverId),

        pickup_place: r.pickup_place,
        dropoff_place: r.dropoff_place,

        pickup: [Number(r.pickup_lat), Number(r.pickup_lng)],
        dropoff: [Number(r.dropoff_lat), Number(r.dropoff_lng)],

        distance_m: Number(r.distance_m || 0),
        duration_s: Number(r.duration_s || 0),
        fare_cents: Number(r.fare_cents || 0),
        currency: r.currency || "BTN",
      };
    });

    return res.json({ ok: true, driver_id: String(myDriverId), data });
  } catch (e) {
    console.error("[listScheduledRidesForDriver] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   POST /api/scheduled-rides/:rideId/reserve
   ========================================================= */
export async function reserveScheduledRide(req, res) {
  let conn;
  try {
    const rideId = Number(req.params.rideId);
    const { user_id, driver_id } = req.body || {};

    if (!Number.isFinite(rideId) || rideId <= 0) {
      return res.status(400).json({ ok: false, error: "Valid rideId required" });
    }

    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const myDriverId = await resolveDriverId(conn, { user_id, driver_id });
    if (!myDriverId) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Valid user_id required" });
    }

    const [[ride]] = await conn.query(
      `
      SELECT ride_id, booking_type, status, scheduled_at, driver_id
      FROM rides WHERE ride_id=? FOR UPDATE
      `,
      [rideId]
    );

    if (!ride) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "ride_not_found" });
    }

    if (ride.booking_type !== "SCHEDULED" || ride.status !== "scheduled") {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "ride_not_reservable" });
    }

    if (ride.driver_id != null) {
      if (Number(ride.driver_id) === myDriverId) {
        await conn.commit();
        return res.json({ ok: true, already_reserved: true });
      }
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "already_reserved" });
    }

    await conn.query(
      `
      UPDATE rides
      SET driver_id=?,
          reserved_at=UTC_TIMESTAMP(),
          reserved_confirmed_at=NULL,
          dispatch_at=DATE_SUB(scheduled_at, INTERVAL ? MINUTE),
          offer_expire_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
      WHERE ride_id=? AND driver_id IS NULL
      `,
      [myDriverId, DISPATCH_BEFORE_MIN, RESERVE_TTL_MIN, rideId]
    );

    const [[fresh]] = await conn.query(
      `
      SELECT driver_id, reserved_at, offer_expire_at, dispatch_at
      FROM rides WHERE ride_id=? LIMIT 1
      `,
      [rideId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      ride_id: String(rideId),
      driver_id: String(myDriverId),
      reserved_at: toIsoSafe(fresh.reserved_at),
      offer_expire_at: toIsoSafe(fresh.offer_expire_at),
      dispatch_at: toIsoSafe(fresh.dispatch_at),
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[reserveScheduledRide] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   POST /api/scheduled-rides/:rideId/reconfirm
   ========================================================= */
export async function reconfirmScheduledRide(req, res) {
  let conn;
  try {
    const rideId = Number(req.params.rideId);
    const { user_id, driver_id } = req.body || {};

    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const myDriverId = await resolveDriverId(conn, { user_id, driver_id });
    if (!myDriverId) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Invalid driver" });
    }

    const [[ride]] = await conn.query(
      `
      SELECT scheduled_at, driver_id
      FROM rides WHERE ride_id=? FOR UPDATE
      `,
      [rideId]
    );

    if (!ride || Number(ride.driver_id) !== myDriverId) {
      await conn.rollback();
      return res.status(403).json({ ok: false, error: "not_reserved_by_you" });
    }

    const dispatchAt = computeDispatchAt(ride.scheduled_at);
    const extendTo = new Date(dispatchAt.getTime() + 10 * 60 * 1000);

    await conn.query(
      `
      UPDATE rides
      SET reserved_confirmed_at=UTC_TIMESTAMP(),
          offer_expire_at=?
      WHERE ride_id=? AND driver_id=?
      `,
      [extendTo, rideId, myDriverId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      ride_id: String(rideId),
      driver_id: String(myDriverId),
      offer_expire_at: extendTo.toISOString(),
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[reconfirmScheduledRide] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   POST /api/scheduled-rides/:rideId/release
   ========================================================= */
export async function releaseScheduledRide(req, res) {
  let conn;
  try {
    const rideId = Number(req.params.rideId);
    const { user_id, driver_id } = req.body || {};

    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const myDriverId = await resolveDriverId(conn, { user_id, driver_id });
    if (!myDriverId) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Invalid driver" });
    }

    await conn.query(
      `
      UPDATE rides
      SET driver_id=NULL,
          reserved_at=NULL,
          reserved_confirmed_at=NULL,
          offer_expire_at=NULL
      WHERE ride_id=? AND driver_id=?
      `,
      [rideId, myDriverId]
    );

    await conn.commit();
    return res.json({ ok: true, released: true });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[releaseScheduledRide] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   GET /api/scheduled-rides/passenger/list?passenger_id=123&days=30
   (or ?user_id=123)
   ========================================================= */
export async function listScheduledRidesForPassenger(req, res) {
  let conn;
  try {
    const { passenger_id, user_id, days } = req.query || {};

    conn = await mysqlPool.getConnection();

    const myPassengerId = await resolvePassengerId(conn, { passenger_id, user_id });
    if (!myPassengerId) {
      return res.status(400).json({
        ok: false,
        error: "Valid passenger_id (or user_id) required",
      });
    }

    const daysAhead = clampInt(days, 30, 1, 90);

    await autoReleaseExpiredScheduled(conn);

    const [rows] = await conn.query(
      `
      SELECT
        ride_id,
        passenger_id,
        service_type,
        trip_type,
        booking_type,
        status,
        scheduled_at,
        dispatch_at,
        reserved_at,
        reserved_confirmed_at,
        driver_id,
        offer_expire_at,
        pickup_place,
        dropoff_place,
        pickup_lat, pickup_lng,
        dropoff_lat, dropoff_lng,
        distance_m,
        duration_s,
        fare_cents,
        currency
      FROM rides
      WHERE booking_type='SCHEDULED'
        AND passenger_id=?
        AND scheduled_at IS NOT NULL
        AND scheduled_at >= (UTC_TIMESTAMP() - INTERVAL 2 MINUTE)
        AND scheduled_at <= (UTC_TIMESTAMP() + INTERVAL ? DAY)
      ORDER BY scheduled_at ASC
      LIMIT 200
      `,
      [myPassengerId, daysAhead]
    );

    const data = rows.map((r) => {
      const scheduledAt = r.scheduled_at ? new Date(r.scheduled_at) : null;
      const reconfirmAt = scheduledAt ? computeReconfirmAt(scheduledAt) : null;

      return {
        ride_id: String(r.ride_id),
        passenger_id: r.passenger_id ? String(r.passenger_id) : null,

        service_type: r.service_type,
        trip_type: r.trip_type,
        booking_type: r.booking_type,
        status: r.status,

        scheduled_at: toIsoSafe(r.scheduled_at),
        dispatch_at: toIsoSafe(r.dispatch_at),
        reconfirm_at: toIsoSafe(reconfirmAt),

        reserved_driver_id: r.driver_id != null ? String(r.driver_id) : null,
        reserved_until: toIsoSafe(r.offer_expire_at),
        reserved_at: toIsoSafe(r.reserved_at),
        reserved_confirmed_at: toIsoSafe(r.reserved_confirmed_at),

        pickup_place: r.pickup_place,
        dropoff_place: r.dropoff_place,

        pickup: [Number(r.pickup_lat), Number(r.pickup_lng)],
        dropoff: [Number(r.dropoff_lat), Number(r.dropoff_lng)],

        distance_m: Number(r.distance_m || 0),
        duration_s: Number(r.duration_s || 0),
        fare_cents: Number(r.fare_cents || 0),
        currency: r.currency || "BTN",
      };
    });

    return res.json({ ok: true, passenger_id: String(myPassengerId), data });
  } catch (e) {
    console.error("[listScheduledRidesForPassenger] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   GET /api/scheduled-rides/driver/my?driver_id=10&days=30
   (or ?user_id=999 -> resolves driver_id)
   -> ONLY rides reserved/assigned to that driver
   ========================================================= */
export async function listMyScheduledRidesForDriver(req, res) {
  let conn;
  try {
    const { user_id, driver_id, days } = req.query || {};

    conn = await mysqlPool.getConnection();

    const myDriverId = await resolveDriverId(conn, { user_id, driver_id });
    if (!myDriverId) {
      return res.status(400).json({
        ok: false,
        error: "Valid user_id or driver_id required",
      });
    }

    const daysAhead = clampInt(days, 30, 1, 90);

    await autoReleaseExpiredScheduled(conn);

    const [rows] = await conn.query(
      `
      SELECT
        ride_id,
        passenger_id,
        service_type,
        trip_type,
        booking_type,
        status,
        scheduled_at,
        dispatch_at,
        reserved_at,
        reserved_confirmed_at,
        driver_id,
        offer_expire_at,
        pickup_place,
        dropoff_place,
        pickup_lat, pickup_lng,
        dropoff_lat, dropoff_lng,
        distance_m,
        duration_s,
        fare_cents,
        currency
      FROM rides
      WHERE booking_type='SCHEDULED'
        AND status='scheduled'
        AND scheduled_at IS NOT NULL
        AND scheduled_at >= (UTC_TIMESTAMP() - INTERVAL 2 MINUTE)
        AND scheduled_at <= (UTC_TIMESTAMP() + INTERVAL ? DAY)
        AND driver_id = ?
      ORDER BY scheduled_at ASC
      LIMIT 200
      `,
      [daysAhead, myDriverId]
    );

    const data = rows.map((r) => {
      const scheduledAt = r.scheduled_at ? new Date(r.scheduled_at) : null;
      const reconfirmAt = scheduledAt ? computeReconfirmAt(scheduledAt) : null;

      return {
        ride_id: String(r.ride_id),
        passenger_id: r.passenger_id ? String(r.passenger_id) : null,

        service_type: r.service_type,
        trip_type: r.trip_type,
        booking_type: r.booking_type,
        status: r.status,

        scheduled_at: toIsoSafe(r.scheduled_at),
        dispatch_at: toIsoSafe(r.dispatch_at),
        reconfirm_at: toIsoSafe(reconfirmAt),

        reserved_driver_id: r.driver_id != null ? String(r.driver_id) : null,
        reserved_until: toIsoSafe(r.offer_expire_at),
        reserved_at: toIsoSafe(r.reserved_at),
        reserved_confirmed_at: toIsoSafe(r.reserved_confirmed_at),

        pickup_place: r.pickup_place,
        dropoff_place: r.dropoff_place,

        pickup: [Number(r.pickup_lat), Number(r.pickup_lng)],
        dropoff: [Number(r.dropoff_lat), Number(r.dropoff_lng)],

        distance_m: Number(r.distance_m || 0),
        duration_s: Number(r.duration_s || 0),
        fare_cents: Number(r.fare_cents || 0),
        currency: r.currency || "BTN",
      };
    });

    return res.json({ ok: true, driver_id: String(myDriverId), data });
  } catch (e) {
    console.error("[listMyScheduledRidesForDriver] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* =========================================================
   ✅ NEW: GET /api/scheduled-rides/passenger/grouped
   -> returns ALL ride rows for passenger grouped by status
   Query:
     passenger_id or user_id required
     booking_type optional (SCHEDULED / INSTANT / etc.)
     limit optional (default 500, max 2000)
   ========================================================= */
export async function getPassengerRidesGroupedByStatus(req, res) {
  let conn;
  try {
    const { passenger_id, user_id, booking_type, limit } = req.query || {};

    conn = await mysqlPool.getConnection();

    const myPassengerId = await resolvePassengerId(conn, { passenger_id, user_id });
    if (!myPassengerId) {
      return res
        .status(400)
        .json({ ok: false, error: "Valid passenger_id (or user_id) required" });
    }

    const lim = clampInt(limit, 500, 1, 2000);
    const bookingType = parseBookingType(booking_type);

    const params = [myPassengerId];
    let where = `WHERE passenger_id=?`;

    // ✅ optional booking_type filter
    if (bookingType) {
      where += ` AND booking_type=?`;
      params.push(bookingType);
    }

    // ✅ EXCLUDE delivery/express-like service_type
    // - blocks: delivery_*, any service_type containing express/parcel/delivery
    // - allows NULL service_type (older rows)
    where += `
      AND (
        service_type IS NULL OR (
          LOWER(service_type) NOT LIKE 'delivery\\_%'
          AND LOWER(service_type) NOT LIKE '%delivery%'
          AND LOWER(service_type) NOT LIKE '%express%'
          AND LOWER(service_type) NOT LIKE '%parcel%'
        )
      )
    `;

    const [rows] = await conn.query(
      `
      SELECT
        ride_id,
        passenger_id,
        driver_id,
        service_type,
        trip_type,
        booking_type,
        status,
        requested_at,
        scheduled_at,
        dispatch_at,
        reserved_at,
        reserved_confirmed_at,
        offer_expire_at,
        pickup_place,
        dropoff_place,
        pickup_lat, pickup_lng,
        dropoff_lat, dropoff_lng,
        distance_m,
        duration_s,
        fare_cents,
        currency
      FROM rides
      ${where}
      ORDER BY COALESCE(scheduled_at, requested_at) DESC
      LIMIT ?
      `,
      [...params, lim]
    );

    const safeRows = rows.map((r) => ({
      ride_id: String(r.ride_id),
      passenger_id: r.passenger_id != null ? String(r.passenger_id) : null,
      driver_id: r.driver_id != null ? String(r.driver_id) : null,

      service_type: r.service_type,
      trip_type: r.trip_type,
      booking_type: r.booking_type,
      status: r.status,

      requested_at: toIsoSafe(r.requested_at),
      scheduled_at: toIsoSafe(r.scheduled_at),
      dispatch_at: toIsoSafe(r.dispatch_at),
      reserved_at: toIsoSafe(r.reserved_at),
      reserved_confirmed_at: toIsoSafe(r.reserved_confirmed_at),
      offer_expire_at: toIsoSafe(r.offer_expire_at),

      pickup_place: r.pickup_place,
      dropoff_place: r.dropoff_place,

      pickup: [Number(r.pickup_lat), Number(r.pickup_lng)],
      dropoff: [Number(r.dropoff_lat), Number(r.dropoff_lng)],

      distance_m: Number(r.distance_m || 0),
      duration_s: Number(r.duration_s || 0),
      fare_cents: Number(r.fare_cents || 0),
      currency: r.currency || "BTN",
    }));

    return res.json({
      ok: true,
      passenger_id: String(myPassengerId),
      booking_type: bookingType || null,
      total_rows: safeRows.length,
      grouped: groupByStatus(safeRows),
    });
  } catch (e) {
    console.error("[getPassengerRidesGroupedByStatus] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}


/* =========================================================
   ✅ NEW: GET /api/scheduled-rides/driver/grouped
   -> returns ALL ride rows for driver grouped by status
   Query:
     driver_id or user_id required
     booking_type optional
     limit optional (default 500, max 2000)
   ========================================================= */
export async function getDriverRidesGroupedByStatus(req, res) {
  let conn;
  try {
    const { driver_id, user_id, booking_type, limit } = req.query || {};

    conn = await mysqlPool.getConnection();

    const myDriverId = await resolveDriverId(conn, { driver_id, user_id });
    if (!myDriverId) {
      return res.status(400).json({ ok: false, error: "Valid driver_id (or user_id) required" });
    }

    const lim = clampInt(limit, 500, 1, 2000);
    const bookingType = parseBookingType(booking_type);

    const params = [myDriverId];
    let where = `WHERE driver_id=?`;
    if (bookingType) {
      where += ` AND booking_type=?`;
      params.push(bookingType);
    }

    const [rows] = await conn.query(
      `
      SELECT
        ride_id,
        passenger_id,
        driver_id,
        service_type,
        trip_type,
        booking_type,
        status,
        requested_at,
        scheduled_at,
        dispatch_at,
        reserved_at,
        reserved_confirmed_at,
        offer_expire_at,
        pickup_place,
        dropoff_place,
        pickup_lat, pickup_lng,
        dropoff_lat, dropoff_lng,
        distance_m,
        duration_s,
        fare_cents,
        currency
      FROM rides
      ${where}
      ORDER BY COALESCE(scheduled_at, requested_at) DESC
      LIMIT ?
      `,
      [...params, lim]
    );

    const safeRows = rows.map((r) => ({
      ride_id: String(r.ride_id),
      passenger_id: r.passenger_id != null ? String(r.passenger_id) : null,
      driver_id: r.driver_id != null ? String(r.driver_id) : null,

      service_type: r.service_type,
      trip_type: r.trip_type,
      booking_type: r.booking_type,
      status: r.status,

      requested_at: toIsoSafe(r.requested_at),
      scheduled_at: toIsoSafe(r.scheduled_at),
      dispatch_at: toIsoSafe(r.dispatch_at),
      reserved_at: toIsoSafe(r.reserved_at),
      reserved_confirmed_at: toIsoSafe(r.reserved_confirmed_at),
      offer_expire_at: toIsoSafe(r.offer_expire_at),

      pickup_place: r.pickup_place,
      dropoff_place: r.dropoff_place,

      pickup: [Number(r.pickup_lat), Number(r.pickup_lng)],
      dropoff: [Number(r.dropoff_lat), Number(r.dropoff_lng)],

      distance_m: Number(r.distance_m || 0),
      duration_s: Number(r.duration_s || 0),
      fare_cents: Number(r.fare_cents || 0),
      currency: r.currency || "BTN",
    }));

    return res.json({
      ok: true,
      driver_id: String(myDriverId),
      booking_type: bookingType || null,
      total_rows: safeRows.length,
      grouped: groupByStatus(safeRows),
    });
  } catch (e) {
    console.error("[getDriverRidesGroupedByStatus] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try { conn?.release(); } catch {}
  }
}
