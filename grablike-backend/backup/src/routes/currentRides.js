// src/routes/currentRides.js
import express from "express";
import { getRedis } from "../matching/redis.js";
import {
  currentRidesKey as keyFor,
  currentPassengerRideKey,
} from "../matching/redisKeys.js";

const ACTIVE_STATES = [
  "started",
  "arrived_pickup",
  "accepted",
  "offered_to_driver",
  "requested",
  "scheduled",
];

const isActiveStatus = (s) =>
  ACTIVE_STATES.includes(String(s || "").toLowerCase());

/**
 * Build the router so we can use mysqlPool (needed for passenger lookup fallback).
 */
export default function currentRidesRouter(mysqlPool) {
  const router = express.Router();
  const redis = getRedis(); // ioredis client
  const TTL = Number(process.env.RIDES_TTL_SECONDS || 0);

  const sendBadReq = (res, msg) =>
    res.status(400).json({ ok: false, error: msg });

  const refreshTTL = async (key) => {
    if (TTL > 0) await redis.expire(key, TTL);
  };

  /* =========================
     ✅ Ride Waypoints helper (DB)
     - Returns array in the exact shape WaitingForDriver expects:
       [{ lat, lng, address }]
  ========================= */
  async function fetchRideWaypoints(conn, rideId) {
    const rid = String(rideId || "").trim();
    if (!rid) return [];

    const [rows] = await conn.query(
      `
      SELECT order_index, lat, lng, address
      FROM ride_waypoints
      WHERE ride_id = ?
      ORDER BY order_index ASC
      `,
      [rid]
    );

    return (rows || []).map((w, i) => ({
      lat: Number(w.lat),
      lng: Number(w.lng),
      address: w.address || `Stop ${i + 1}`,
    }));
  }

  async function attachWaypointsToRide(rideObj) {
    try {
      if (!mysqlPool?.getConnection) return rideObj;

      const rideId =
        rideObj?.request_id ??
        rideObj?.ride_id ??
        rideObj?.rideId ??
        rideObj?.id ??
        null;

      const rid = String(rideId || "").trim();
      if (!rid) return rideObj;

      // If already attached, keep it
      if (Array.isArray(rideObj?.waypoints) && rideObj.waypoints.length) {
        return rideObj;
      }

      const conn = await mysqlPool.getConnection();
      try {
        const wps = await fetchRideWaypoints(conn, rid);
        return { ...rideObj, waypoints: wps };
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch {
      return rideObj;
    }
  }

  /** Compact, consistent ride shape for passenger-fastpath */
  const toPassengerSnapshot = (ride) => ({
    request_id: Number(
      ride?.request_id ?? ride?.rideId ?? ride?.ride_id ?? 0
    ),
    passenger_id: ride?.passenger_id != null ? Number(ride.passenger_id) : null,
    driver_id: ride?.driver_id != null ? Number(ride.driver_id) : null,
    status: String(ride?.status || "").toLowerCase(),
    pickup_place: ride?.pickup_place ?? null,
    dropoff_place: ride?.dropoff_place ?? null,
    pickup_lat: ride?.pickup_lat ?? null,
    pickup_lng: ride?.pickup_lng ?? null,
    dropoff_lat: ride?.dropoff_lat ?? null,
    dropoff_lng: ride?.dropoff_lng ?? null,
    currency: ride?.currency ?? null,
    fare_cents: ride?.fare_cents ?? null,
    requested_at: ride?.requested_at ?? null,
    accepted_at: ride?.accepted_at ?? null,
    arrived_pickup_at: ride?.arrived_pickup_at ?? null,
    started_at: ride?.started_at ?? null,

    booking_type: ride?.booking_type ?? null,
    scheduled_at: ride?.scheduled_at ?? null,

    // ✅ include waypoints if already present on ride object
    waypoints: Array.isArray(ride?.waypoints) ? ride.waypoints : [],

    raw: ride ?? null,
  });

  /* ---------------- helpers: mirror to passenger keys ---------------- */

  async function setPassengerKey(userId, snapshot) {
    const k = currentPassengerRideKey(String(userId));
    if (isActiveStatus(snapshot?.status)) {
      await redis.set(k, JSON.stringify(snapshot));
      if (TTL > 0) await redis.expire(k, TTL);
    } else {
      await redis.del(k);
    }
  }

  async function clearPassengerKey(userId) {
    try {
      await redis.del(currentPassengerRideKey(String(userId)));
    } catch {}
  }

  /** Determine if a ride is GROUP (from ride object or DB fallback). */
  async function isGroupRide(rideId, rideObj) {
    const bt = String(rideObj?.booking_type || "").toUpperCase();
    if (bt) return bt === "GROUP";

    if (!mysqlPool?.query || !rideId) return false;
    try {
      const [[r]] = await mysqlPool.query(
        `SELECT booking_type FROM rides WHERE ride_id = ? LIMIT 1`,
        [rideId]
      );
      return String(r?.booking_type || "").toUpperCase() === "GROUP";
    } catch {
      return false;
    }
  }

  /**
   * ✅ Mirror a ride into/clear from passenger key(s):
   * - Always mirror to the main passenger_id (host in normal rides)
   * - If GROUP ride: also mirror to ALL joined participants (host + guests)
   */
  async function mirrorPassengerCurrent(ride) {
    try {
      const rideId = String(
        ride?.request_id ?? ride?.rideId ?? ride?.ride_id ?? ""
      ).trim();
      if (!rideId) return;

      const snapshot = toPassengerSnapshot(ride);

      const pid =
        ride?.passenger_id ??
        ride?.passengerId ??
        ride?.passenger ??
        ride?.passengerID;

      if (pid) {
        await setPassengerKey(pid, snapshot);
      }

      const group = await isGroupRide(rideId, ride);
      if (!group) return;

      if (!mysqlPool?.query) return;

      const [rows] = await mysqlPool.query(
        `
        SELECT user_id
        FROM ride_participants
        WHERE ride_id = ? AND join_status = 'joined'
        `,
        [rideId]
      );

      const ids = new Set();
      if (pid) ids.add(String(pid));
      for (const r of rows || []) {
        if (r?.user_id != null) ids.add(String(r.user_id));
      }

      await Promise.all([...ids].map((uid) => setPassengerKey(uid, snapshot)));
    } catch (e) {
      console.warn("[mirrorPassengerCurrent] skipped:", e?.message);
    }
  }

  /**
   * ✅ Clear passenger key(s) for a ride:
   * - Always clears main passenger_id key
   * - If GROUP ride: clears all joined participants
   */
  async function clearPassengerMirrorsForRide(rideId, rideObjMaybe) {
    try {
      const rid = String(rideId || "").trim();
      if (!rid) return;

      const pid =
        rideObjMaybe?.passenger_id ??
        rideObjMaybe?.passengerId ??
        rideObjMaybe?.passenger ??
        rideObjMaybe?.passengerID;

      if (pid) await clearPassengerKey(pid);

      const group = await isGroupRide(rid, rideObjMaybe);
      if (!group) return;
      if (!mysqlPool?.query) return;

      const [rows] = await mysqlPool.query(
        `
        SELECT user_id
        FROM ride_participants
        WHERE ride_id = ? AND join_status = 'joined'
        `,
        [rid]
      );

      await Promise.all(
        (rows || [])
          .map((r) => r?.user_id)
          .filter(Boolean)
          .map((uid) => clearPassengerKey(uid))
      );
    } catch {}
  }

  /* ========================= DRIVER (Redis) ========================= */

  router.get("/driver/current-rides", async (req, res) => {
    try {
      const driverId = String(req.query.driver_id || "").trim();
      if (!driverId) return sendBadReq(res, "driver_id is required");

      const key = keyFor(driverId);
      const all = await redis.hgetall(key);
      const data = Object.values(all)
        .map((s) => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      return res.json({ ok: true, data });
    } catch (e) {
      console.error("[GET current-rides] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  router.get("/driver/current-rides/:rideId", async (req, res) => {
    try {
      const driverId = String(req.query.driver_id || "").trim();
      const rideId = String(req.params.rideId || "").trim();
      if (!driverId) return sendBadReq(res, "driver_id is required");
      if (!rideId) return sendBadReq(res, "rideId is required");

      const key = keyFor(driverId);
      const raw = await redis.hget(key, rideId);
      if (!raw)
        return res.status(404).json({ ok: false, error: "not_found" });

      let ride = null;
      try {
        ride = JSON.parse(raw);
      } catch {}
      return res.json({ ok: true, data: ride });
    } catch (e) {
      console.error("[GET one current-ride] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  router.post("/driver/current-rides", async (req, res) => {
    try {
      const driverId = String(req.body?.driver_id || "").trim();
      const ride = req.body?.ride;
      if (!driverId) return sendBadReq(res, "driver_id is required");
      if (!ride || typeof ride !== "object")
        return sendBadReq(res, "ride object is required");

      const rideId = String(ride.request_id || ride.rideId || "").trim();
      if (!rideId) return sendBadReq(res, "ride.request_id is required");

      const key = keyFor(driverId);
      await redis.hset(key, rideId, JSON.stringify(ride));
      await refreshTTL(key);

      await mirrorPassengerCurrent(ride);

      return res.json({ ok: true, data: { ride_id: rideId } });
    } catch (e) {
      console.error("[POST current-rides] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  router.put("/driver/current-rides/bulk", async (req, res) => {
    try {
      const driverId = String(req.body?.driver_id || "").trim();
      const rides = Array.isArray(req.body?.rides) ? req.body.rides : [];
      if (!driverId) return sendBadReq(res, "driver_id is required");
      if (!rides.length) return sendBadReq(res, "rides[] required");

      const key = keyFor(driverId);
      const obj = {};
      for (const r of rides) {
        const rid = String(r?.request_id || r?.rideId || "").trim();
        if (rid) obj[rid] = JSON.stringify(r);
      }
      if (!Object.keys(obj).length)
        return sendBadReq(res, "no valid rides (missing request_id)");

      await redis.hset(key, obj);
      await refreshTTL(key);

      await Promise.all(rides.map((r) => mirrorPassengerCurrent(r)));

      return res.json({ ok: true, count: Object.keys(obj).length });
    } catch (e) {
      console.error("[PUT bulk current-rides] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  router.delete("/driver/current-rides/:rideId", async (req, res) => {
    try {
      const driverId = String(req.query.driver_id || "").trim();
      const rideId = String(req.params.rideId || "").trim();
      if (!driverId) return sendBadReq(res, "driver_id is required");
      if (!rideId) return sendBadReq(res, "rideId path param is required");

      const key = keyFor(driverId);

      const raw = await redis.hget(key, rideId);
      let ride = null;
      try {
        ride = raw ? JSON.parse(raw) : null;
      } catch {}

      const removed = await redis.hdel(key, rideId);

      await clearPassengerMirrorsForRide(rideId, ride);

      return res.json({ ok: true, removed });
    } catch (e) {
      console.error("[DELETE one current-ride] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  router.delete("/driver/current-rides", async (req, res) => {
    try {
      const driverId = String(req.query.driver_id || "").trim();
      if (!driverId) return sendBadReq(res, "driver_id is required");

      const key = keyFor(driverId);

      try {
        const fields = await redis.hkeys(key);
        if (fields?.length) {
          const arr = await Promise.all(fields.map((f) => redis.hget(key, f)));
          for (let i = 0; i < fields.length; i++) {
            const rid = fields[i];
            const s = arr[i];
            let r = null;
            try {
              r = JSON.parse(s);
            } catch {}

            await clearPassengerMirrorsForRide(rid, r);
          }
          await redis.hdel(key, ...fields);
          return res.json({ ok: true, removed: fields.length });
        }
      } catch {}

      return res.json({ ok: true, removed: 0 });
    } catch (e) {
      console.error("[DELETE all current-rides] error:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ========================= PASSENGER (Redis + MySQL fallback) ========================= */

  /**
   * GET /passenger/current-ride?passenger_id=:id
   */
  router.get("/passenger/current-ride", async (req, res) => {
    try {
      const pid = String(req.query.passenger_id || "").trim();
      if (!pid) return sendBadReq(res, "passenger_id is required");

      const k = currentPassengerRideKey(pid);

      // 1) Redis fast path
      const raw = await redis.get(k);
      if (raw) {
        try {
          let ride = JSON.parse(raw);
          if (ride?.status && isActiveStatus(ride.status)) {
            if (TTL > 0) await redis.expire(k, TTL);

            // ✅ ALWAYS attach ride.waypoints from DB for this ride_id
            ride = await attachWaypointsToRide(ride);

            // ✅ keep cache warm with waypoints included
            try {
              const snap = toPassengerSnapshot(ride);
              await redis.set(k, JSON.stringify(snap));
              if (TTL > 0) await redis.expire(k, TTL);
            } catch {}

            return res.json({ ok: true, data: ride });
          }
        } catch {
          // continue to fallback
        }
      }

      // 2) MySQL fallback
      if (!mysqlPool?.getConnection) {
        console.error("[/passenger/current-ride] mysqlPool not ready");
        return res.status(500).json({ ok: false, error: "server_error" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [rows] = await conn.query(
          `
          SELECT
            r.ride_id       AS request_id,
            r.passenger_id,
            r.driver_id,
            r.status,
            r.pickup_place,
            r.dropoff_place,
            r.pickup_lat, r.pickup_lng,
            r.dropoff_lat, r.dropoff_lng,
            r.currency, r.fare_cents,
            r.requested_at, r.accepted_at, r.arrived_pickup_at, r.started_at,
            r.booking_type, r.scheduled_at
          FROM rides r
          LEFT JOIN ride_participants p
            ON p.ride_id = r.ride_id
           AND p.user_id = ?
           AND p.join_status = 'joined'
          WHERE (r.passenger_id = ? OR p.user_id IS NOT NULL)
            AND r.status IN (?,?,?,?,?,?)
          ORDER BY
            FIELD(r.status, 'started','arrived_pickup','accepted','offered_to_driver','requested','scheduled'),
            COALESCE(r.started_at, r.arrived_pickup_at, r.accepted_at, r.requested_at) DESC
          LIMIT 1
        `,
          [pid, pid, ...ACTIVE_STATES]
        );

        if (!rows?.length) {
          await redis.del(k);
          return res.status(404).json({ ok: false, error: "no_active_ride" });
        }

        let ride = rows[0];

        // ✅ attach waypoints (same conn)
        try {
          const wps = await fetchRideWaypoints(conn, ride.request_id);
          ride = { ...ride, waypoints: wps };
        } catch {}

        // populate Redis for next time (for THIS caller)
        if (isActiveStatus(ride?.status)) {
          await redis.set(k, JSON.stringify(toPassengerSnapshot(ride)));
          if (TTL > 0) await redis.expire(k, TTL);
        } else {
          await redis.del(k);
        }

        return res.json({ ok: true, data: ride });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (e) {
      console.error("[/passenger/current-ride] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });
  /* =========================
     ✅ Ride details by id (MySQL)
     If this router is mounted at /rides, these become:
     GET /rides/by-id/:id
     GET /rides/:id
  ========================= */

  // ✅ Alias must be BEFORE "/:id"
  router.get("/by-id/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "ride_id required" });

    try {
      if (!mysqlPool?.getConnection) {
        return res.status(500).json({ ok: false, error: "mysql_not_ready" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[ride]] = await conn.query(
          "SELECT * FROM rides WHERE ride_id = ? LIMIT 1",
          [id]
        );

        if (!ride) return res.status(404).json({ ok: false, error: "Ride not found" });
        return res.json({ ok: true, data: ride });
      } finally {
        try { conn.release(); } catch {}
      }
    } catch (e) {
      console.error("[GET /by-id/:id]", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ✅ Main: GET "/:id"
  router.get("/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "ride_id required" });

    try {
      if (!mysqlPool?.getConnection) {
        return res.status(500).json({ ok: false, error: "mysql_not_ready" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[ride]] = await conn.query(
          "SELECT * FROM rides WHERE ride_id = ? LIMIT 1",
          [id]
        );

        if (!ride) return res.status(404).json({ ok: false, error: "Ride not found" });
        return res.json({ ok: true, data: ride });
      } finally {
        try { conn.release(); } catch {}
      }
    } catch (e) {
      console.error("[GET /:id]", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });


  return router;
}
