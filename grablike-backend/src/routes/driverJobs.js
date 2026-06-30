// src/routes/driverJobs.js
import { Router } from "express";
import { computeFareCents } from "../utils/fare.js"; // used only as a fallback

export function driverJobsRouter(mysqlPool) {
  const r = Router();

  // GET /api/driver/jobs/incoming?driver_id=123
  r.get("/incoming", async (req, res) => {
    const driverId = Number(req.query.driver_id);
    if (!driverId) return res.status(400).json({ error: "driver_id required" });

    const [rows] = await mysqlPool.query(
      `
      SELECT
        ride_id            AS request_id,
        pickup_place       AS pickup,
        dropoff_place      AS dropoff,
        distance_m,
        duration_s,
        currency,
        trip_type,
        pool_batch_id,
        fare_cents                    -- ✅ stored passenger fare (cents)
      FROM rides
      WHERE (status IN ('offered_to_driver')
             AND (offer_driver_id IS NULL OR offer_driver_id = ?))
        AND (driver_id IS NULL OR driver_id = ?)
      ORDER BY requested_at DESC
      LIMIT 50
      `,
      [driverId, driverId]
    );

    const items = rows.map((r) => {
      // Prefer stored cents; fallback to an estimate only if missing
      const cents =
        r.fare_cents != null
          ? Number(r.fare_cents)
          : computeFareCents({ distance_m: r.distance_m, duration_s: r.duration_s })?.total_cents ?? null;

      return {
        request_id: r.request_id,
        pickup: r.pickup,
        dropoff: r.dropoff,
        distance_km:
          r.distance_m != null
            ? Math.round((r.distance_m / 1000) * 10) / 10
            : null,
        eta_min: r.duration_s != null ? Math.round(r.duration_s / 60) : null,
        currency: r.currency,
        trip_type: r.trip_type,
        pool_batch_id: r.pool_batch_id,
        fare_cents: Number.isFinite(cents) ? cents : null,     // ✅ expose fare_cents
        fare: Number.isFinite(cents) ? cents / 100 : null,     // convenience units for UI
      };
    });

    res.json({ items });
  });

  // GET /api/driver/jobs/active?driver_id=123
r.get("/active", async (req, res) => {
  const driverId = Number(req.query.driver_id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ error: "driver_id required" });
  }

  try {
    const [rows] = await mysqlPool.query(
      `
      SELECT
        r.ride_id              AS request_id,
        r.driver_id,
        r.passenger_id,
        r.pickup_place         AS pickup,
        r.dropoff_place        AS dropoff,
        r.pickup_lat,
        r.pickup_lng,
        r.dropoff_lat,
        r.dropoff_lng,
        r.distance_m,
        r.duration_s,
        r.currency,
        r.status,
        r.trip_type,
        r.service_type,
        r.pool_batch_id,
        r.accepted_at,
        r.arrived_pickup_at,
        r.started_at,
        r.requested_at,
        r.completed_at,
        r.fare_cents,                -- stored passenger fare (optional)

        /* Optional earnings breakdown if present */
        re.base_cents,
        re.distance_cents,
        re.time_cents,
        re.surge_cents,
        re.tolls_cents,
        re.tips_cents,
        re.other_adj_cents,
        re.platform_fee_cents,
        re.tax_cents,
        re.driver_earnings_cents

      FROM rides r
      LEFT JOIN ride_earnings re
        ON re.ride_id = r.ride_id
      WHERE r.driver_id = ?
        AND r.status IN ('accepted','arrived_pickup','started')
      ORDER BY r.accepted_at DESC
      LIMIT 50
      `,
      [driverId]
    );

    const items = rows.map((r) => {
      // Prefer stored fare_cents; otherwise try to derive from earnings; otherwise use your fallback
      const stored = Number(r.fare_cents);
      const hasStored = Number.isFinite(stored);

      const derivedFromBreakdown =
        Number(r.base_cents || 0) +
        Number(r.distance_cents || 0) +
        Number(r.time_cents || 0) +
        Number(r.surge_cents || 0) +
        Number(r.tolls_cents || 0) +
        Number(r.tips_cents || 0) +
        Number(r.other_adj_cents || 0) +
        Number(r.tax_cents || 0);

      let cents = hasStored
        ? stored
        : Number.isFinite(derivedFromBreakdown) && derivedFromBreakdown > 0
        ? derivedFromBreakdown
        : null;

      if (!Number.isFinite(cents)) {
        // final fallback to your calculator (if present)
        try {
          const calc = computeFareCents?.({
            distance_m: r.distance_m,
            duration_s: r.duration_s,
          });
          if (calc && Number.isFinite(calc.total_cents)) {
            cents = calc.total_cents;
          }
        } catch {}
      }

      return {
        // identity
        request_id: r.request_id,
        driver_id: r.driver_id,
        passenger_id: r.passenger_id,

        // places & coords
        pickup: r.pickup,
        dropoff: r.dropoff,
        pickup_lat: r.pickup_lat,
        pickup_lng: r.pickup_lng,
        dropoff_lat: r.dropoff_lat,
        dropoff_lng: r.dropoff_lng,

        // distances & time
        distance_m: r.distance_m,
        duration_s: r.duration_s,
        distance_km:
          r.distance_m != null
            ? Math.round((Number(r.distance_m) / 1000) * 10) / 10
            : null,
        eta_min:
          r.duration_s != null ? Math.round(Number(r.duration_s) / 60) : null,

        // meta
        currency: r.currency,
        status: r.status,
        trip_type: r.trip_type,
        service_type: r.service_type,
        pool_batch_id: r.pool_batch_id,

        // timestamps
        requested_at: r.requested_at,
        accepted_at: r.accepted_at,
        arrived_pickup_at: r.arrived_pickup_at,
        started_at: r.started_at,
        completed_at: r.completed_at,

        // fares
        fare_cents: Number.isFinite(cents) ? cents : null,
        fare: Number.isFinite(cents) ? cents / 100 : null,

        // optional breakdown (if ride_earnings exists)
        earnings_breakdown: {
          base_cents: r.base_cents ?? null,
          distance_cents: r.distance_cents ?? null,
          time_cents: r.time_cents ?? null,
          surge_cents: r.surge_cents ?? null,
          tolls_cents: r.tolls_cents ?? null,
          tips_cents: r.tips_cents ?? null,
          other_adj_cents: r.other_adj_cents ?? null,
          tax_cents: r.tax_cents ?? null,
          platform_fee_cents: r.platform_fee_cents ?? null,
          driver_earnings_cents: r.driver_earnings_cents ?? null,
        },
      };
    });

    res.json({ items });
  } catch (err) {
    console.error("[/api/driver/jobs/active] error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


  // GET /api/driver/jobs/history?driver_id=123
  r.get("/history", async (req, res) => {
    const driverId = Number(req.query.driver_id);
    if (!driverId) return res.status(400).json({ error: "driver_id required" });

    const [rows] = await mysqlPool.query(
      `
      SELECT
        r.ride_id          AS request_id,
        r.pickup_place     AS pickup,
        r.dropoff_place    AS dropoff,
        r.completed_at,
        r.distance_m,
        r.duration_s,
        r.trip_type,
        r.pool_batch_id,
        r.fare_cents,                    -- ✅ if you stored the passenger fare
        re.base_cents,
        re.distance_cents,
        re.time_cents,
        re.surge_cents,
        re.tolls_cents,
        re.tips_cents,
        re.other_adj_cents,
        re.platform_fee_cents,
        re.tax_cents
      FROM rides r
      LEFT JOIN ride_earnings re ON re.ride_id = r.ride_id
      WHERE r.driver_id = ?
        AND r.status = 'completed'
      ORDER BY r.completed_at DESC
      LIMIT 50
      `,
      [driverId]
    );

    const items = rows.map((r) => {
      // Prefer the stored passenger fare if available.
      let fareCents = Number.isFinite(Number(r.fare_cents))
        ? Number(r.fare_cents)
        : null;

      // If not stored, fallback to earnings sum (passenger facing) OR compute
      if (fareCents == null) {
        if (r.base_cents != null) {
          const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
          const sum =
            toNum(r.base_cents) +
            toNum(r.distance_cents) +
            toNum(r.time_cents) +
            toNum(r.surge_cents) +
            toNum(r.tolls_cents) +
            toNum(r.tips_cents) +
            toNum(r.other_adj_cents);
          fareCents = sum;
        } else {
          fareCents =
            computeFareCents({
              distance_m: r.distance_m,
              duration_s: r.duration_s,
            })?.total_cents ?? null;
        }
      }

      return {
        request_id: r.request_id,
        pickup: r.pickup,
        dropoff: r.dropoff,
        finished_at: r.completed_at,
        trip_type: r.trip_type,
        pool_batch_id: r.pool_batch_id,
        fare_cents: Number.isFinite(fareCents) ? fareCents : null, // ✅ expose fare_cents
        fare: Number.isFinite(fareCents) ? fareCents / 100 : null, // convenience units for UI
      };
    });

    res.json({ items });
  });

  // Admin/ops list
  r.get("/rides", async (_req, res) => {
    try {
      const [rows] = await mysqlPool.query(`
        SELECT
          r.ride_id,
          r.passenger_id,
          r.driver_id,
          r.pickup_place,
          r.dropoff_place,
          r.pickup_lat,
          r.pickup_lng,
          r.dropoff_lat,
          r.dropoff_lng,
          r.distance_m,
          r.duration_s,
          r.currency,
          r.status,
          r.created_at          AS ride_created_at,
          r.accepted_at,
          r.arrived_pickup_at,
          r.started_at,
          r.completed_at,
          r.cancelled_at,
          r.service_type,
          r.trip_type,
          r.pool_batch_id,
          r.offer_driver_id,
          r.offer_expire_at,
          r.fare_cents,                         -- ✅ include it here too

          u.user_name           AS driver_name,
          u.phone               AS driver_phone,
          u2.user_name          AS passenger_name,
          u2.phone              AS passenger_phone,

          re.base_cents,
          re.distance_cents,
          re.time_cents,
          re.surge_cents,
          re.tolls_cents,
          re.tips_cents,
          re.other_adj_cents,
          re.platform_fee_cents,
          re.tax_cents,

          ra.rating_id,
          ra.rating             AS rating_score,
          ra.comment            AS rating_review,
          ra.created_at         AS rating_created_at
        FROM rides r
        LEFT JOIN users u  ON u.user_id  = r.driver_id
        LEFT JOIN users u2 ON u2.user_id = r.passenger_id
        LEFT JOIN ride_earnings re ON re.ride_id = r.ride_id
        LEFT JOIN ride_ratings  ra ON ra.ride_id = r.ride_id
        ORDER BY r.created_at DESC
      `);

      const items = rows.map((row) => {
        // prefer stored passenger fare
        const fareCentsFromRide =
          row.fare_cents != null ? Number(row.fare_cents) : null;

        // earnings object: useful for dashboards
        const earnings =
          row.base_cents != null
            ? {
                base_cents: row.base_cents,
                distance_cents: row.distance_cents,
                time_cents: row.time_cents,
                surge_cents: row.surge_cents,
                tolls_cents: row.tolls_cents,
                tips_cents: row.tips_cents,
                other_adj_cents: row.other_adj_cents,
                platform_fee_cents: row.platform_fee_cents,
                tax_cents: row.tax_cents,
              }
            : computeFareCents({
                distance_m: row.distance_m,
                duration_s: row.duration_s,
              });

        return {
          ride_id: row.ride_id,
          passenger_id: row.passenger_id,
          passenger_name: row.passenger_name,
          passenger_phone: row.passenger_phone,
          driver_id: row.driver_id,
          driver_name: row.driver_name,
          driver_phone: row.driver_phone,
          pickup_place: row.pickup_place,
          pickup_lat: row.pickup_lat,
          pickup_lng: row.pickup_lng,
          dropoff_place: row.dropoff_place,
          dropoff_lat: row.dropoff_lat,
          dropoff_lng: row.dropoff_lng,
          distance_m: row.distance_m ?? 0,
          duration_s: row.duration_s ?? 0,
          currency: row.currency,
          status: row.status,
          created_at: row.ride_created_at?.toISOString?.() ?? row.ride_created_at,
          accepted_at: row.accepted_at?.toISOString?.() ?? row.accepted_at,
          arrived_pickup_at: row.arrived_pickup_at?.toISOString?.() ?? row.arrived_pickup_at,
          started_at: row.started_at?.toISOString?.() ?? row.started_at,
          completed_at: row.completed_at?.toISOString?.() ?? row.completed_at,
          cancelled_at: row.cancelled_at?.toISOString?.() ?? row.cancelled_at,
          ride_type: row.service_type,
          trip_type: row.trip_type,
          pool_batch_id: row.pool_batch_id,
          offer_driver_id: row.offer_driver_id,
          offer_expire_at: row.offer_expire_at?.toISOString?.() ?? row.offer_expire_at,

          // ✅ expose stored passenger fare cents (+ units convenience)
          fare_cents: fareCentsFromRide,
          fare: fareCentsFromRide != null ? fareCentsFromRide / 100 : null,

          earnings,
          rating:
            row.rating_id != null
              ? {
                  rating_id: row.rating_id,
                  score: row.rating_score,
                  review: row.rating_review,
                  created_at: row.rating_created_at?.toISOString?.() ?? row.rating_created_at,
                }
              : null,
        };
      });

      res.json({ items });
    } catch (e) {
      console.error("[/rides] error:", e);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Example: driver summary/details
  r.get("/details/:driver_id", async (req, res) => {
    const driverId = Number(req.params.driver_id);
    if (!driverId) return res.status(400).json({ error: "driver_id required" });

    try {
      const [rows] = await mysqlPool.query(
        `
        SELECT 
          u.user_id AS id,
          u.user_name AS name,
          u.phone,
          COUNT(DISTINCT r.ride_id) AS total_trips,
          AVG(ra.rating) AS avg_rating,
          SUM(
            COALESCE(re.base_cents,0) + COALESCE(re.distance_cents,0) + COALESCE(re.time_cents,0) +
            COALESCE(re.surge_cents,0) + COALESCE(re.tolls_cents,0)  + COALESCE(re.tips_cents,0) +
            COALESCE(re.other_adj_cents,0) - COALESCE(re.platform_fee_cents,0) + COALESCE(re.tax_cents,0)
          ) / 100 AS total_earnings
        FROM users u
        LEFT JOIN rides r ON r.driver_id = u.user_id AND r.status = 'completed'
        LEFT JOIN ride_earnings re ON re.ride_id = r.ride_id
        LEFT JOIN ride_ratings ra ON ra.ride_id = r.ride_id
        WHERE u.user_id = ?
        GROUP BY u.user_id, u.user_name, u.phone
        `,
        [driverId]
      );

      if (!rows.length) return res.status(404).json({ error: "Driver not found" });
      res.json(rows[0]);
    } catch (err) {
      console.error("[/driver/details] error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  return r;
}
