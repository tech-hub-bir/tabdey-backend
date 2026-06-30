// src/routes/nearbyDriversApi.js (ESM)
import express from "express";
import { driverHash } from "../matching/redisKeys.js";
import { getRedis } from "../matching/redis.js";

const redis = getRedis();
const norm = (s) => String(s || "").trim();

/** DB helper (adjust column names to your schema) */
async function getUserAndDriver(mysqlPool, driverId) {
  const did = Number(driverId);
  if (!Number.isFinite(did)) return { user: null, driver: null };

  const conn = await mysqlPool.getConnection();
  try {
    const [rows] = await conn.execute(
      `
  SELECT
    u.user_id         AS user_id,
    u.user_name       AS user_name,
    u.email           AS email,
    u.phone           AS phone,
    u.role            AS role,
    u.profile_image   AS profile_image,

    d.driver_id       AS driver_id,
    d.user_id         AS driver_user_id,
    d.license_number  AS license_number,
    d.license_expiry  AS license_expiry,

    dv.vehicle_id     AS vehicle_id,
    dv.vehicle_type   AS vehicle_type
  FROM drivers d
  LEFT JOIN users u
    ON u.user_id = d.user_id
  LEFT JOIN driver_vehicles dv
    ON dv.driver_id = d.driver_id
  WHERE d.driver_id = ?
  LIMIT 1
  `,
      [did]
    );

    if (!rows.length) return { user: null, driver: null };

    const r = rows[0];
    const user = {
      id: r.user_id,
      user_name: r.user_name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      profile_image: r.profile_image
    };

    const driver = r.driver_id
      ? {
          id: r.driver_id,
          user_id: r.driver_user_id,
          vehicle_id: r.vehicle_id,
          vehicle_type: r.vehicle_type,
          license_number: r.license_number,
          license_expiry: r.license_expiry,
        }
      : null;

    return { user, driver };
  } finally {
    try {
      conn.release();
    } catch {}
  }
}

/** Factory: pass mysqlPool when mounting */
export default function makeNearbyDriversRouter(mysqlPool) {
  const router = express.Router();

  /**
   * GET /api/nearby-drivers
   * Query (one of the service filters is required):
   * - cityId               (required)
   * - service_code         (exact)        e.g. delivery_bike
   * - service_code_prefix  (prefix match) e.g. D
   * - lng, lat, radiusKm, limit
   */
  // GET /api/nearby-drivers
  // Works even when the user does NOT pass service_code or service_code_prefix.
  // In that case we default to `service_code_prefix = 'D'`.
  router.get("/nearby-drivers", async (req, res) => {
    try {
      const { cityId, service_code, service_code_prefix, lng, lat, radiusKm } =
        req.query;
      const limit = parseInt(req.query.limit || "20", 10);

      if (!cityId || !lng || !lat || !radiusKm) {
        return res.status(400).json({ error: "Missing required params" });
      }

      const city = String(cityId).trim();
      const lon = parseFloat(lng);
      const la = parseFloat(lat);
      const rKm = parseFloat(radiusKm);

      if ([lon, la, rKm].some((n) => Number.isNaN(n))) {
        return res.status(400).json({ error: "Invalid lng/lat/radiusKm" });
      }

      // Decide which keys to search
      const keysToSearch = [];
      if (service_code) {
        keysToSearch.push(
          `geo:drivers:city:${city}:${String(service_code).trim()}`
        );
      } else {
        const prefix = (service_code_prefix ?? "D").toString().trim(); // <-- default to 'D'
        const pattern = `geo:drivers:city:${city}:${prefix}*`;
        let cursor = "0";
        do {
          const [next, batch] = await redis.scan(
            cursor,
            "MATCH",
            pattern,
            "COUNT",
            200
          );
          cursor = next;
          for (const k of batch) keysToSearch.push(k);
        } while (cursor !== "0");
        if (keysToSearch.length === 0) {
          return res.json({ drivers: [], searched_keys: [] });
        }
      }

      // Geo search each key and union driver IDs up to limit
      const collected = new Set();
      for (const gKey of keysToSearch) {
        if (collected.size >= limit) break;
        const take = Math.max(1, limit - collected.size);
        const ids = await redis.georadius(
          gKey,
          lon,
          la,
          rKm,
          "km",
          "ASC",
          "COUNT",
          take
        );
        for (const id of ids) collected.add(String(id));
      }

      if (!collected.size) {
        return res.json({ drivers: [], searched_keys: keysToSearch });
      }

      // Status filter
      const idArr = Array.from(collected);
      const pipe = redis.multi();
      for (const id of idArr) pipe.hget(driverHash(id), "status");
      const statuses = await pipe.exec();

      const isAvail = (s) =>
        ["available", "online", "idle"].includes(String(s || "").toLowerCase());
      const avail = [];
      for (let i = 0; i < idArr.length; i++) {
        const id = idArr[i];
        const s = statuses[i] ? statuses[i][1] : null;
        if (isAvail(s)) avail.push({ id, status: s });
      }

      if (!avail.length) {
        return res.json({ drivers: [], searched_keys: keysToSearch });
      }

      // Enrich (optional; keep if you already had the helper)
      const detailed = await Promise.all(
        avail.map(async ({ id, status }) => {
          const { user, driver } = await getUserAndDriver(mysqlPool, id);
          return { id, status, user, driver };
        })
      );

      return res.json({
        drivers: detailed,
        searched_keys: keysToSearch,
      });
    } catch (e) {
      console.error("nearby prefix search error:", e);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
