// controllers/rideGroup.controller.js
import crypto from "crypto";
import { mysqlPool } from "../db/mysql.js"; // adjust path if needed
import { getPushTokensByDriverIds, getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

/* ---------------- helpers ---------------- */
const asInt = (v, def = null) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
};

const clampInt = (v, def, min, max) => {
  const n = asInt(v, def);
  if (n == null) return def;
  return Math.max(min, Math.min(max, n));
};

const isExpired = (expiresAt) => {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
};

const genInviteCode = (len = 10) => {
  // url-safe, uppercase-ish
  const raw = crypto.randomBytes(24).toString("base64url").toUpperCase();
  return raw.replace(/[^A-Z0-9]/g, "").slice(0, len);
};

async function ensureHostOrThrow(conn, ride_id, user_id) {
  const [[host]] = await conn.query(
    `
    SELECT participant_id
    FROM ride_participants
    WHERE ride_id = ? AND user_id = ? AND role = 'host' AND join_status = 'joined'
    LIMIT 1
    `,
    [ride_id, user_id]
  );
  if (!host) {
    const err = new Error("Only the host can perform this action.");
    err.status = 403;
    throw err;
  }
}

/* =========================================================
   1) CREATE INVITE (host only)
   POST /api/rides/:ride_id/invites
   body: { max_guests?: number, expires_in_minutes?: number, expires_at?: datetime }
========================================================= */
export async function createRideInvite(req, res) {
  const ride_id = asInt(req.params.ride_id);

  // ✅ plain: take user_id from body (NO auth, NO middleware, NO helper)
  const user_id = asInt(req.body?.user_id);

  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });
  if (!user_id) return res.status(400).json({ ok: false, error: "user_id is required" });

  const max_guests = clampInt(req.body?.max_guests, 3, 1, 20);

  // expiry: either explicit expires_at OR expires_in_minutes
  let expires_at = null;
  if (req.body?.expires_at) {
    const d = new Date(String(req.body.expires_at));
    if (!Number.isFinite(d.getTime())) {
      return res.status(400).json({ ok: false, error: "Invalid expires_at" });
    }
    expires_at = d;
  } else if (req.body?.expires_in_minutes != null) {
    const mins = clampInt(req.body.expires_in_minutes, 60, 1, 7 * 24 * 60);
    expires_at = new Date(Date.now() + mins * 60 * 1000);
  }

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    // host check (kept as-is)
    await ensureHostOrThrow(conn, ride_id, user_id);

    // generate unique code (retry a few times on collision)
    let invite_code = null;
    for (let i = 0; i < 6; i++) {
      const code = genInviteCode(10);
      try {
        await conn.query(
          `
          INSERT INTO ride_invites (ride_id, invite_code, created_by, max_guests, expires_at)
          VALUES (?, ?, ?, ?, ?)
          `,
          [ride_id, code, user_id, max_guests, expires_at]
        );
        invite_code = code;
        break;
      } catch (e) {
        if (String(e?.code) === "ER_DUP_ENTRY") continue;
        throw e;
      }
    }

    if (!invite_code) {
      await conn.rollback();
      return res.status(500).json({ ok: false, error: "Failed to generate invite code" });
    }

    await conn.commit();

    return res.json({
      ok: true,
      data: {
        ride_id,
        invite_code,
        max_guests,
        expires_at: expires_at ? expires_at.toISOString() : null,
      },
    });
  } catch (e) {
    if (conn) await conn.rollback();
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || "Server error" });
  } finally {
    if (conn) conn.release();
  }
}


/* =========================================================
   2) GET INVITE BY CODE (public-ish, still auth optional)
   GET /api/ride-invites/:code
========================================================= */
export async function getInviteByCode(req, res) {
  const code = String(req.params.code || "").trim();
  if (!code) return res.status(400).json({ ok: false, error: "Missing code" });

  try {
    const [[inv]] = await mysqlPool.query(
      `
      SELECT invite_id, ride_id, invite_code, created_by, max_guests, expires_at, created_at
      FROM ride_invites
      WHERE invite_code = ?
      LIMIT 1
      `,
      [code]
    );

    if (!inv) return res.status(404).json({ ok: false, error: "Invite not found" });
    if (isExpired(inv.expires_at)) return res.status(410).json({ ok: false, error: "Invite expired" });

    // current joined guest count
    const [[cnt]] = await mysqlPool.query(
      `
      SELECT COUNT(*) AS joined_guests
      FROM ride_participants
      WHERE ride_id = ? AND role='guest' AND join_status='joined'
      `,
      [inv.ride_id]
    );

    return res.json({
      ok: true,
      data: {
        ...inv,
        joined_guests: Number(cnt?.joined_guests || 0),
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

/* fire-and-forget: socket emit + push to driver when a guest joins */
async function notifyDriverGuestJoined({ req, rideId, driverUserId, guestUserId, seats, status }) {
  // Socket: emit guestJoined + refreshed poolSummary so PoolList updates
  try {
    const io = req.app.get("io");
    if (io) {
      io.to(`ride:${rideId}`).emit("guestJoined", {
        ride_id: rideId,
        user_id: guestUserId,
        seats,
        status,
      });

      // Re-emit poolSummary so driver's PoolList immediately shows the new guest booking
      const { mysqlPool } = await import("../db/mysql.js");
      const conn = await mysqlPool.getConnection();
      try {
        const [rows] = await conn.query(
          `SELECT booking_id, passenger_id, seats,
                  pickup_place AS pickup, dropoff_place AS dropoff,
                  pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
                  fare_cents, currency, status
           FROM ride_bookings
           WHERE ride_id = ? AND status IN ('accepted','arrived_pickup','started','requested')`,
          [rideId]
        );
        const [[sum]] = await conn.query(
          `SELECT COALESCE(capacity_seats,0) AS capacity_seats,
                  COALESCE(seats_booked,0) AS seats_booked,
                  COALESCE(SUM(CASE WHEN b.status IN ('accepted','arrived_pickup','started') THEN b.seats END),0) AS seats_confirmed
           FROM rides r LEFT JOIN ride_bookings b ON b.ride_id = r.ride_id
           WHERE r.ride_id = ? GROUP BY r.ride_id`,
          [rideId]
        );
        const sc = Number(sum?.seats_confirmed || 0);
        io.to(`ride:${rideId}`).emit("poolSummary", {
          request_id: String(rideId),
          seats_confirmed: sc,
          capacity_seats: Math.max(Number(sum?.capacity_seats || 2), sc),
          seats_booked: Number(sum?.seats_booked || 0),
          bookings: (rows || []).map((r) => ({
            ...r,
            booking_id: String(r.booking_id),
            request_id: String(rideId),
          })),
        });
      } finally {
        conn.release();
      }
    }
  } catch (e) {
    console.log("[notifyDriverGuestJoined] poolSummary error:", e?.message);
  }

  // Push notification to driver
  getPushTokensByDriverIds([driverUserId])
    .then((tokens) => {
      if (!tokens.length) return;
      return sendPushToTokens(tokens, {
        title: "New guest joined your ride",
        body: `A passenger joined your group ride (${seats} seat${seats > 1 ? "s" : ""}).`,
        data: { type: "guest_joined", ride_id: String(rideId), seats: String(seats) },
      });
    })
    .catch(() => {});
}

/* =========================================================
   3) JOIN RIDE BY INVITE CODE
   POST /api/ride-invites/:code/join
   body: { seats?: number }
========================================================= */
export async function joinByInviteCode(req, res) {
  const code = String(req.params.code || "").trim();

  // ✅ plain: take user_id from body (NO auth, NO middleware)
  const user_id = asInt(req.body?.user_id);

  if (!code) return res.status(400).json({ ok: false, error: "Missing code" });
  if (!user_id)
    return res.status(400).json({ ok: false, error: "user_id is required" });

  const seats = clampInt(req.body?.seats, 1, 1, 10);

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    // lock invite
    const [[inv]] = await conn.query(
      `
      SELECT invite_id, ride_id, invite_code, created_by, max_guests, expires_at
      FROM ride_invites
      WHERE invite_code = ?
      FOR UPDATE
      `,
      [code]
    );

    if (!inv) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Invite not found" });
    }
    if (isExpired(inv.expires_at)) {
      await conn.rollback();
      return res.status(410).json({ ok: false, error: "Invite expired" });
    }

    // host must exist (safety)
    const [[host]] = await conn.query(
      `
      SELECT participant_id, user_id
      FROM ride_participants
      WHERE ride_id = ? AND role='host' AND join_status='joined'
      LIMIT 1
      `,
      [inv.ride_id]
    );
    if (!host) {
      await conn.rollback();
      return res
        .status(409)
        .json({ ok: false, error: "Ride has no active host" });
    }

    // prevent host from joining as guest using invite
    if (Number(host.user_id) === Number(user_id)) {
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        error: "Host cannot join using invite code",
      });
    }

    // already participant?
    const [[existing]] = await conn.query(
      `
      SELECT participant_id, role, join_status
      FROM ride_participants
      WHERE ride_id = ? AND user_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [inv.ride_id, user_id]
    );

    if (existing) {
      // if removed, block rejoin
      if (existing.join_status === "removed") {
        await conn.rollback();
        return res
          .status(403)
          .json({ ok: false, error: "You were removed from this ride" });
      }

      // if left -> re-join as guest (unless host)
      if (existing.join_status === "left") {
        if (existing.role === "host") {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            error: "Host cannot rejoin using invite",
          });
        }

        await conn.query(
          `
          UPDATE ride_participants
          SET join_status='joined', seats=?, updated_at=NOW()
          WHERE participant_id = ?
          `,
          [seats, existing.participant_id]
        );

        await conn.commit();
        notifyDriverGuestJoined({ req, rideId: inv.ride_id, driverUserId: host.user_id, guestUserId: user_id, seats, status: "rejoined" });
        return res.json({
          ok: true,
          data: { ride_id: inv.ride_id, status: "rejoined", seats },
        });
      }

      // already joined
      await conn.rollback();
      return res.status(200).json({
        ok: true,
        data: { ride_id: inv.ride_id, status: "already_joined" },
      });
    }

    // capacity check by guest count (not seats)
    const [[cnt]] = await conn.query(
      `
      SELECT COUNT(*) AS joined_guests
      FROM ride_participants
      WHERE ride_id = ? AND role='guest' AND join_status='joined'
      `,
      [inv.ride_id]
    );

    const joinedGuests = Number(cnt?.joined_guests || 0);
    if (joinedGuests >= Number(inv.max_guests || 0)) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Guest limit reached" });
    }

    // insert participant
    await conn.query(
      `
      INSERT INTO ride_participants (ride_id, user_id, role, seats, join_status)
      VALUES (?, ?, 'guest', ?, 'joined')
      `,
      [inv.ride_id, user_id, seats]
    );

    // Create ride_bookings row for guest + recalculate fare split
    const [[rideInfo]] = await conn.query(
      `SELECT fare_cents, currency, pickup_place, dropoff_place,
              pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
              COALESCE(seats_booked, 1) AS seats_booked, passenger_id
       FROM rides WHERE ride_id = ? LIMIT 1`,
      [inv.ride_id]
    );

    if (rideInfo) {
      const totalFare    = Number(rideInfo.fare_cents || 0);
      const oldSeats     = Number(rideInfo.seats_booked || 1);
      const newTotalSeats = oldSeats + seats;

      const guestFare = totalFare > 0 ? Math.round(totalFare * seats / newTotalSeats) : 0;
      const hostFare  = totalFare > 0 ? totalFare - guestFare : 0;

      // Adjust host booking fare
      if (rideInfo.passenger_id && hostFare >= 0) {
        await conn.query(
          `UPDATE ride_bookings SET fare_cents = ? WHERE ride_id = ? AND passenger_id = ?`,
          [hostFare, inv.ride_id, rideInfo.passenger_id]
        );
      }

      // Insert guest booking
      await conn.query(
        `INSERT INTO ride_bookings
           (ride_id, passenger_id, seats, status, requested_at,
            pickup_place, dropoff_place, pickup_lat, pickup_lng,
            dropoff_lat, dropoff_lng, fare_cents, currency)
         VALUES (?, ?, ?, 'accepted', NOW(), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          inv.ride_id, user_id, seats,
          rideInfo.pickup_place, rideInfo.dropoff_place,
          rideInfo.pickup_lat,   rideInfo.pickup_lng,
          rideInfo.dropoff_lat,  rideInfo.dropoff_lng,
          guestFare, rideInfo.currency || 'BTN',
        ]
      );

      // Update seats_booked count
      await conn.query(
        `UPDATE rides SET seats_booked = ? WHERE ride_id = ?`,
        [newTotalSeats, inv.ride_id]
      );
    }

    await conn.commit();
    notifyDriverGuestJoined({ req, rideId: inv.ride_id, driverUserId: host.user_id, guestUserId: user_id, seats, status: "joined" });
    return res.json({
      ok: true,
      data: { ride_id: inv.ride_id, status: "joined", seats },
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    return res
      .status(500)
      .json({ ok: false, error: e.message || "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}


/* =========================================================
   4) LIST PARTICIPANTS
   GET /api/rides/:ride_id/participants
========================================================= */
export async function listParticipants(req, res) {
  const ride_id = asInt(req.params.ride_id);
  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });

  try {
    const [rows] = await mysqlPool.query(
      `
      SELECT participant_id, ride_id, user_id, role, seats, join_status, stage, joined_at, updated_at
      FROM ride_participants
      WHERE ride_id = ?
      ORDER BY (role='host') DESC, joined_at ASC
      `,
      [ride_id]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

/* =========================================================
   5) LEAVE RIDE (guest or host)
   POST /api/rides/:ride_id/participants/leave
========================================================= */
export async function leaveRide(req, res) {
  const ride_id = asInt(req.params.ride_id);
  const user_id = asInt(req.user?.user_id);

  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });
  if (!user_id) return res.status(401).json({ ok: false, error: "Unauthorized" });

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const [[p]] = await conn.query(
      `
      SELECT participant_id, role, join_status
      FROM ride_participants
      WHERE ride_id = ? AND user_id = ?
      FOR UPDATE
      `,
      [ride_id, user_id]
    );

    if (!p) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Not a participant" });
    }

    if (p.join_status !== "joined") {
      await conn.rollback();
      return res.json({ ok: true, data: { status: p.join_status } });
    }

    // if host leaves, you can either allow it or block it.
    // Here: allow host to leave, but note: ride now has no active host unless you reassign in your ride logic.
    await conn.query(
      `
      UPDATE ride_participants
      SET join_status='left', updated_at=NOW()
      WHERE participant_id = ?
      `,
      [p.participant_id]
    );

    await conn.commit();
    return res.json({ ok: true, data: { status: "left" } });
  } catch (e) {
    if (conn) await conn.rollback();
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    if (conn) conn.release();
  }
}

/* =========================================================
   6) REMOVE GUEST (host only)
   POST /api/rides/:ride_id/participants/:user_id/remove
========================================================= */
export async function removeGuest(req, res) {
  const ride_id = asInt(req.params.ride_id);
  const host_id = asInt(req.user?.user_id);
  const target_user_id = asInt(req.params.user_id);

  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });
  if (!host_id) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!target_user_id) return res.status(400).json({ ok: false, error: "Invalid target user_id" });

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    await ensureHostOrThrow(conn, ride_id, host_id);

    const [[p]] = await conn.query(
      `
      SELECT participant_id, role, join_status
      FROM ride_participants
      WHERE ride_id = ? AND user_id = ?
      FOR UPDATE
      `,
      [ride_id, target_user_id]
    );

    if (!p) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Target user is not a participant" });
    }

    if (p.role !== "guest") {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Only guests can be removed" });
    }

    if (p.join_status === "removed") {
      await conn.rollback();
      return res.json({ ok: true, data: { status: "already_removed" } });
    }

    await conn.query(
      `
      UPDATE ride_participants
      SET join_status='removed', updated_at=NOW()
      WHERE participant_id = ?
      `,
      [p.participant_id]
    );

    await conn.commit();
    return res.json({ ok: true, data: { status: "removed" } });
  } catch (e) {
    if (conn) await conn.rollback();
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || "Server error" });
  } finally {
    if (conn) conn.release();
  }
}

/* =========================================================
   7) LIST AVAILABLE SHARED RIDES NEARBY
   GET /api/rides/available-shared?lat=&lng=&radius_km=
========================================================= */
export async function listAvailableSharedRides(req, res) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radius = Math.min(Number(req.query.radius_km) || 10, 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: "lat and lng are required" });
  }

  try {
    const [rows] = await mysqlPool.query(
      `SELECT
         r.ride_id,
         r.trip_type,
         r.pickup_place,
         r.dropoff_place,
         r.pickup_lat,
         r.pickup_lng,
         r.dropoff_lat,
         r.dropoff_lng,
         r.fare_cents,
         r.currency,
         COALESCE(r.capacity_seats, 4)          AS capacity_seats,
         COALESCE(r.seats_booked, 1)             AS seats_booked,
         (COALESCE(r.capacity_seats,4) - COALESCE(r.seats_booked,1)) AS seats_available,
         r.status,
         r.created_at,
         (
           6371 * acos(
             cos(radians(?)) * cos(radians(r.pickup_lat)) *
             cos(radians(r.pickup_lng) - radians(?)) +
             sin(radians(?)) * sin(radians(r.pickup_lat))
           )
         ) AS distance_km
       FROM rides r
       WHERE r.trip_type IN ('group','pool')
         AND r.status IN ('driver_searching','accepted','driver_accepted')
         AND (COALESCE(r.capacity_seats,4) - COALESCE(r.seats_booked,1)) > 0
       HAVING distance_km <= ?
       ORDER BY distance_km ASC
       LIMIT 30`,
      [lat, lng, lat, radius]
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
}

/* =========================================================
   8) JOIN RIDE DIRECTLY (no invite code — Grab style)
   POST /api/rides/:ride_id/join-direct
   body: { user_id, seats? }
========================================================= */
export async function joinRideDirectly(req, res) {
  const ride_id = asInt(req.params.ride_id);
  const user_id = asInt(req.body?.user_id);

  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });
  if (!user_id) return res.status(400).json({ ok: false, error: "user_id is required" });

  const seats = clampInt(req.body?.seats, 1, 1, 10);

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    // fetch ride with lock
    const [[ride]] = await conn.query(
      `SELECT ride_id, trip_type, status, passenger_id,
              capacity_seats, seats_booked,
              fare_cents, currency,
              pickup_place, dropoff_place,
              pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
       FROM rides WHERE ride_id = ? FOR UPDATE`,
      [ride_id]
    );

    if (!ride) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Ride not found" });
    }

    const allowedStatuses = ["driver_searching", "accepted", "driver_accepted"];
    if (!allowedStatuses.includes(ride.status)) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Ride is no longer accepting passengers" });
    }

    if (!["group", "pool"].includes(String(ride.trip_type || "").toLowerCase())) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "This ride is not a shared ride" });
    }

    // prevent host from joining as guest
    if (Number(ride.passenger_id) === Number(user_id)) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "You are the host of this ride" });
    }

    // capacity check
    const currentSeats = Number(ride.seats_booked || 1);
    const capacity     = Number(ride.capacity_seats || 4);
    if (currentSeats + seats > capacity) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Not enough seats available" });
    }

    // already a participant?
    const [[existing]] = await conn.query(
      `SELECT participant_id, role, join_status
       FROM ride_participants
       WHERE ride_id = ? AND user_id = ?
       LIMIT 1 FOR UPDATE`,
      [ride_id, user_id]
    );

    if (existing) {
      if (existing.join_status === "removed") {
        await conn.rollback();
        return res.status(403).json({ ok: false, error: "You were removed from this ride" });
      }
      if (existing.join_status === "joined") {
        await conn.rollback();
        return res.status(200).json({ ok: true, data: { ride_id, status: "already_joined" } });
      }
      // re-join if left
      await conn.query(
        `UPDATE ride_participants SET join_status='joined', seats=?, updated_at=NOW() WHERE participant_id=?`,
        [seats, existing.participant_id]
      );
      await conn.commit();
      notifyDriverGuestJoined({ req, rideId: ride_id, driverUserId: ride.passenger_id, guestUserId: user_id, seats, status: "rejoined" });
      return res.json({ ok: true, data: { ride_id, status: "rejoined", seats } });
    }

    // insert participant
    await conn.query(
      `INSERT INTO ride_participants (ride_id, user_id, role, seats, join_status) VALUES (?, ?, 'guest', ?, 'joined')`,
      [ride_id, user_id, seats]
    );

    // fare split
    const totalFare     = Number(ride.fare_cents || 0);
    const newTotalSeats = currentSeats + seats;
    const guestFare     = totalFare > 0 ? Math.round(totalFare * seats / newTotalSeats) : 0;
    const hostFare      = totalFare > 0 ? totalFare - guestFare : 0;

    if (ride.passenger_id && hostFare >= 0) {
      await conn.query(
        `UPDATE ride_bookings SET fare_cents=? WHERE ride_id=? AND passenger_id=?`,
        [hostFare, ride_id, ride.passenger_id]
      );
    }

    await conn.query(
      `INSERT INTO ride_bookings
         (ride_id, passenger_id, seats, status, requested_at,
          pickup_place, dropoff_place, pickup_lat, pickup_lng,
          dropoff_lat, dropoff_lng, fare_cents, currency)
       VALUES (?, ?, ?, 'accepted', NOW(), ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ride_id, user_id, seats,
        ride.pickup_place, ride.dropoff_place,
        ride.pickup_lat,   ride.pickup_lng,
        ride.dropoff_lat,  ride.dropoff_lng,
        guestFare, ride.currency || "BTN",
      ]
    );

    await conn.query(
      `UPDATE rides SET seats_booked=? WHERE ride_id=?`,
      [newTotalSeats, ride_id]
    );

    await conn.commit();
    notifyDriverGuestJoined({ req, rideId: ride_id, driverUserId: ride.passenger_id, guestUserId: user_id, seats, status: "joined" });
    return res.json({ ok: true, data: { ride_id, status: "joined", seats } });
  } catch (e) {
    try { await conn?.rollback(); } catch {}
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    try { conn?.release(); } catch {}
  }
}

/* =========================================================
   9) REVOKE / EXPIRE INVITE (host only)
   POST /api/rides/:ride_id/invites/:code/revoke
========================================================= */
export async function revokeInvite(req, res) {
  const ride_id = asInt(req.params.ride_id);
  const host_id = asInt(req.user?.user_id);
  const code = String(req.params.code || "").trim();

  if (!ride_id) return res.status(400).json({ ok: false, error: "Invalid ride_id" });
  if (!host_id) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!code) return res.status(400).json({ ok: false, error: "Missing code" });

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    await ensureHostOrThrow(conn, ride_id, host_id);

    const [r] = await conn.query(
      `
      UPDATE ride_invites
      SET expires_at = NOW()
      WHERE ride_id = ? AND invite_code = ?
      `,
      [ride_id, code]
    );

    await conn.commit();
    return res.json({ ok: true, data: { affected: r.affectedRows || 0 } });
  } catch (e) {
    if (conn) await conn.rollback();
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message || "Server error" });
  } finally {
    if (conn) conn.release();
  }
}
