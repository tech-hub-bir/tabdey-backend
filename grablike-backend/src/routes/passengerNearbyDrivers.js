// src/routes/passengerNearbyDrivers.js
import express from "express";
import { getRedis } from "../matching/redis.js";
import { driverHash } from "../matching/redisKeys.js";

const redis = getRedis();
const ONLINE_STATUSES = new Set(["online", "available", "idle"]);

async function enrichDriver(mysqlPool, driverId) {
  const did = Number(driverId);
  if (!Number.isFinite(did)) return null;

  const conn = await mysqlPool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT
         d.driver_id,
         u.user_name,
         u.phone,
         u.profile_image,
         dv.vehicle_id,
         dv.vehicle_type,
         dv.license_plate AS plate_number,
         (SELECT ROUND(AVG(rating), 1) FROM ride_ratings WHERE driver_id = d.driver_id) AS rating,
         (SELECT COUNT(*) FROM rides WHERE driver_id = d.driver_id AND status = 'completed') AS trips_completed
       FROM drivers d
       LEFT JOIN users u          ON u.user_id    = d.user_id
       LEFT JOIN driver_vehicles dv ON dv.driver_id = d.driver_id
       WHERE d.driver_id = ?
       LIMIT 1`,
      [did]
    );
    return rows[0] ?? null;
  } finally {
    conn.release();
  }
}

export default function makePassengerNearbyDriversRouter(mysqlPool) {
  const router = express.Router();

  /**
   * GET /api/passengers/nearby-drivers
   *
   * Returns online drivers near the passenger's current location.
   *
   * Headers:
   *   Authorization: Bearer <passenger JWT>
   *
   * Query params:
   *   lat          (required)  Passenger latitude
   *   lng          (required)  Passenger longitude
   *   radiusKm     (optional)  Search radius in km        — default 5
   *   service_type (optional)  Filter by service type prefix (e.g. "bike", "car")
   *   limit        (optional)  Max drivers to return      — default 20, max 50
   */
  router.get("/passengers/nearby-drivers", async (req, res) => {
    try {
      const { lat, lng, service_type } = req.query;
      const radiusKm = parseFloat(req.query.radiusKm ?? "5");
      const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 50);

      if (!lat || !lng) {
        return res
          .status(400)
          .json({ ok: false, error: "lat and lng are required" });
      }

      const userLat = parseFloat(lat);
      const userLng = parseFloat(lng);

      if (isNaN(userLat) || isNaN(userLng) || isNaN(radiusKm)) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid lat, lng, or radiusKm" });
      }

      // Scan all geo keys across all cities.
      // Key pattern: geo:drivers:city:<cityId>:<serviceCode>
      const pattern = service_type
        ? `geo:drivers:city:*:${service_type}*`
        : `geo:drivers:city:*`;

      let cursor = "0";
      const geoKeys = new Set();
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          200
        );
        cursor = next;
        for (const k of keys) geoKeys.add(k);
      } while (cursor !== "0");

      if (!geoKeys.size) {
        return res.json({ ok: true, drivers: [] });
      }

      // Query each key; collect closest position per driver with distance.
      // georadius with WITHDIST + WITHCOORD returns: [member, distStr, [lon, lat]]
      const seen = new Map(); // driverId -> { dist_km, lat, lng, serviceCode }

      for (const gKey of geoKeys) {
        // over-fetch so status filtering still leaves enough results
        if (seen.size >= limit * 4) break;

        let raw = [];
        try {
          raw = await redis.georadius(
            gKey,
            userLng,
            userLat,
            radiusKm,
            "km",
            "WITHCOORD",
            "WITHDIST",
            "ASC",
            "COUNT",
            limit * 2
          );
        } catch (e) {
          console.warn(
            "[passengerNearbyDrivers] georadius error",
            gKey,
            e.message
          );
          continue;
        }

        // Extract serviceCode from key tail (after "geo:drivers:city:<cityId>:")
        const parts = gKey.split(":");
        const serviceCode = parts.slice(4).join(":");

        for (const entry of raw) {
          const [id, distStr, [lonStr, latStr]] = entry;
          const idStr = String(id);
          const dist = parseFloat(distStr);

          if (!seen.has(idStr) || seen.get(idStr).dist_km > dist) {
            seen.set(idStr, {
              dist_km: dist,
              lat: parseFloat(latStr),
              lng: parseFloat(lonStr),
              serviceCode,
            });
          }
        }
      }

      if (!seen.size) {
        return res.json({ ok: true, drivers: [] });
      }

      // Batch-fetch status from Redis hashes
      const ids = Array.from(seen.keys());
      const pipe = redis.multi();
      for (const id of ids) pipe.hget(driverHash(id), "status");
      const statuses = await pipe.exec();

      const onlineIds = ids.filter((id, i) => {
        const s = String(statuses[i]?.[1] ?? "").toLowerCase();
        return ONLINE_STATUSES.has(s);
      });

      if (!onlineIds.length) {
        return res.json({ ok: true, drivers: [] });
      }

      // Sort by distance, cap at limit
      onlineIds.sort((a, b) => seen.get(a).dist_km - seen.get(b).dist_km);
      const topIds = onlineIds.slice(0, limit);

      // Enrich with MySQL profile data
      const drivers = await Promise.all(
        topIds.map(async (id) => {
          const geo = seen.get(id);
          const db = await enrichDriver(mysqlPool, id);
          return {
            driver_id: Number(id),
            distance_km: parseFloat(geo.dist_km.toFixed(2)),
            location: { lat: geo.lat, lng: geo.lng },
            service_code: geo.serviceCode,
            status: "online",
            driver_name: db?.user_name ?? null,
            phone: db?.phone ?? null,
            profile_image: db?.profile_image ?? null,
            vehicle_type: db?.vehicle_type ?? null,
            vehicle_id: db?.vehicle_id ?? null,
            plate_number: db?.plate_number ?? null,
            rating: db?.rating != null ? parseFloat(Number(db.rating).toFixed(1)) : null,
            trips_completed: db?.trips_completed != null ? Number(db.trips_completed) : null,
          };
        })
      );

      return res.json({ ok: true, count: drivers.length, drivers });
    } catch (e) {
      console.error("[passengerNearbyDrivers] error:", e);
      return res.status(500).json({ ok: false, error: "Internal server error" });
    }
  });

  return router;
}
