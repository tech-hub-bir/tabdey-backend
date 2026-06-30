import express from "express";
import { withConn } from "../db/mysql.js";
import { getPushTokensByDriverIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

/**
 * Factory: returns a router (keeps signature consistent with earningsRouter(mysqlPool))
 * Note: we use withConn() inside (same as your earningsRouter), so mysqlPool param is optional.
 */
export function ratingsRouter(mysqlPool) {
  const router = express.Router();

  /**
   * GET /api/ratings?driver_id=1&limit=20&offset=0
   * Response:
   * {
   *   summary: { avg, count, dist: {5,4,3,2,1} },
   *   reviews: [{ id, rating, comment, route, when }]
   * }
   */
  router.get("/ratings", async (req, res) => {
    try {
      const driverId = Number(req.query.driver_id);
      const limit = Math.max(0, Math.min(200, Number(req.query.limit ?? 20)));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      if (!driverId) {
        return res.status(400).json({ message: "driver_id is required" });
      }

      const summary = await withConn(async (conn) => {
        const [rows] = await conn.query(
          `
          SELECT
            COALESCE(AVG(rr.rating), 0) AS avg_rating,
            COUNT(*) AS total,
            SUM(CASE WHEN rr.rating = 5 THEN 1 ELSE 0 END) AS s5,
            SUM(CASE WHEN rr.rating = 4 THEN 1 ELSE 0 END) AS s4,
            SUM(CASE WHEN rr.rating = 3 THEN 1 ELSE 0 END) AS s3,
            SUM(CASE WHEN rr.rating = 2 THEN 1 ELSE 0 END) AS s2,
            SUM(CASE WHEN rr.rating = 1 THEN 1 ELSE 0 END) AS s1
          FROM ride_ratings rr
          JOIN rides r ON r.ride_id = rr.ride_id
          WHERE rr.driver_id = ? AND r.status = 'completed'
          `,
          [driverId]
        );
        const row = rows?.[0] || {};
        return {
          avg: Number(row.avg_rating || 0),
          count: Number(row.total || 0),
          dist: {
            5: Number(row.s5 || 0),
            4: Number(row.s4 || 0),
            3: Number(row.s3 || 0),
            2: Number(row.s2 || 0),
            1: Number(row.s1 || 0),
          },
        };
      });

      const reviews = await withConn(async (conn) => {
        const [rows] = await conn.query(
          `
          SELECT
            rr.rating_id AS id,
            rr.rating,
            rr.comment,
            CONCAT(
              COALESCE(NULLIF(r.pickup_place, ''), '—'),
              ' → ',
              COALESCE(NULLIF(r.dropoff_place, ''), '—')
            ) AS route,
            DATE_FORMAT(rr.created_at, '%Y-%m-%d %H:%i') AS \`when\`
          FROM ride_ratings rr
          JOIN rides r ON r.ride_id = rr.ride_id
          WHERE rr.driver_id = ? AND r.status = 'completed'
          ORDER BY rr.created_at DESC
          LIMIT ? OFFSET ?
          `,
          [driverId, limit, offset]
        );
        return rows.map((r) => ({
          id: String(r.id),
          rating: Number(r.rating),
          comment: r.comment || "",
          route: r.route || "",
          when: r.when || "",
        }));
      });

      res.json({ summary, reviews });
    } catch (e) {
      console.error("[GET /ratings] error:", e);
      res.status(500).json({ message: "Server error" });
    }
  });

  /**
   * POST /api/ratings
   * body: { ride_id, driver_id, passenger_id?, rating (1..5), comment? }
   * Enforces: one rating per ride (via UNIQUE KEY on ride_id in ride_ratings).
   */
  router.post("/ratings", async (req, res) => {
    try {
      const { ride_id, driver_id, passenger_id, rating, comment } = req.body || {};
      if (!ride_id || !driver_id || !rating) {
        return res.status(400).json({ message: "ride_id, driver_id, rating are required" });
      }
      if (rating < 1 || rating > 5) {
        return res.status(400).json({ message: "rating must be 1..5" });
      }

      const result = await withConn(async (conn) => {
        // ensure the ride belongs to the driver and is completed
        const [[ride]] = await conn.query(
          `SELECT ride_id FROM rides WHERE ride_id=? AND driver_id=? AND status='completed' LIMIT 1`,
          [ride_id, driver_id]
        );
        if (!ride) return { ok: false, code: "INVALID_RIDE" };

        // insert or update (if you want to allow edits)
        await conn.query(
          `
          INSERT INTO ride_ratings (ride_id, driver_id, passenger_id, rating, comment)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE rating=VALUES(rating), comment=VALUES(comment)
          `,
          [ride_id, driver_id, passenger_id ?? null, rating, comment ?? null]
        );
        return { ok: true };
      });

      if (!result.ok && result.code === "INVALID_RIDE") {
        return res.status(400).json({ message: "Ride not found for driver or not completed" });
      }

      // Push to driver: new rating received
      const stars = "★".repeat(Number(rating)) + "☆".repeat(5 - Number(rating));
      getPushTokensByDriverIds([driver_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "New Rating",
            body: `You received a ${rating}-star rating ${stars} for your trip.`,
            data: { type: "new_rating", ride_id: String(ride_id), rating: Number(rating) },
          }).catch(() => {});
        }
      }).catch(() => {});

      res.json({ ok: true });
    } catch (e) {
      console.error("[POST /ratings] error:", e);
      res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}
