import express from "express";
import { withConn } from "../db/mysql.js";
import { DriverOnlineSession } from "../models/DriverOnlineSession.js";

const SORT_MAP = {
  total: "total_earn_cents",
  trips: "trip_count",
  trip_earn: "trip_earn_cents",
  adj_earn: "adj_earn_cents",
  name: "d.full_name",
  last_trip: "last_trip_at",
};

export function earningsRouter(mysqlPool) {
  const router = express.Router();

  // GET /earnings?period=day|week|month&start=YYYY-MM-DD&end=YYYY-MM-DD&driver_id=NN
  router.get("/earnings", async (req, res) => {
    try {
      const { period, start, end, driver_id } = req.query;
      if (!period || !start || !end || !driver_id) {
        return res
          .status(400)
          .json({ message: "period, start, end, driver_id are required" });
      }

      // Time bounds
      const startDate = new Date(`${start}T00:00:00.000Z`);
      const endDate = new Date(`${end}T23:59:59.999Z`);
      const endPlusOne = new Date(
        new Date(`${end}T00:00:00.000Z`).getTime() + 24 * 3600 * 1000,
      );

      // ---------- SUMMARY (uses v_driver_payouts.total_cents) ----------
      const summary = await withConn(async (conn) => {
        const [rows] = await conn.query(
          `
          SELECT
            COALESCE(SUM(v.total_cents), 0) / 100.0 AS earnings,
            COUNT(*)                               AS trips
          FROM v_driver_payouts v
          JOIN rides r ON r.ride_id = v.ride_id
          WHERE v.driver_id = ?
            AND r.status = 'completed'
            AND r.completed_at >= ?
            AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
        `,
          [driver_id, start, end],
        );
        return rows?.[0] || { earnings: 0, trips: 0 };
      });

      // ---------- TRIPS LIST (latest first) ----------
      const trips = await withConn(async (conn) => {
        const [rows] = await conn.query(
          `
          SELECT
            r.ride_id AS id,
            CONCAT(
              COALESCE(NULLIF(r.pickup_place, ''), '—'),
              ' → ',
              COALESCE(NULLIF(r.dropoff_place, ''), '—')
            ) AS route,
            v.total_cents / 100.0 AS amt,
            DATE_FORMAT(r.completed_at, '%Y-%m-%d %H:%i') AS \`when\`
          FROM v_driver_payouts v
          JOIN rides r ON r.ride_id = v.ride_id
          WHERE v.driver_id = ?
            AND r.status = 'completed'
            AND r.completed_at >= ?
            AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
          ORDER BY r.completed_at DESC
          LIMIT 200
        `,
          [driver_id, start, end],
        );
        return rows.map((r) => ({
          id: String(r.id),
          route: r.route,
          amt: Number(r.amt),
          when: r.when,
        }));
      });

      // ---------- CHART (grouped by period) ----------
      const chart = await withConn(async (conn) => {
        let sql;

        if (period === "day") {
          // Hourly buckets for the day range
          sql = `
            SELECT
              DATE_FORMAT(DATE_FORMAT(r.completed_at, '%Y-%m-%d %H:00:00'), '%H:00') AS label,
              SUM(v.total_cents) / 100.0 AS value
            FROM v_driver_payouts v
            JOIN rides r ON r.ride_id = v.ride_id
            WHERE v.driver_id = ?
              AND r.status = 'completed'
              AND r.completed_at >= ?
              AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY label
            ORDER BY label
          `;
        } else if (period === "week") {
          // Day-of-week buckets (Mon..Sun depending on MySQL locale)
          sql = `
            SELECT
              DATE_FORMAT(r.completed_at, '%a') AS label,
              SUM(v.total_cents) / 100.0 AS value,
              MIN(r.completed_at) AS min_ts
            FROM v_driver_payouts v
            JOIN rides r ON r.ride_id = v.ride_id
            WHERE v.driver_id = ?
              AND r.status = 'completed'
              AND r.completed_at >= ?
              AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY label
            ORDER BY min_ts
          `;
        } else {
          // Default: group by week-in-month label for the given range
          // (same approach you used earlier)
          sql = `
            SELECT
              CONCAT(
                'Wk ',
                WEEK(r.completed_at, 3)
                - WEEK(DATE_SUB(r.completed_at, INTERVAL DAYOFMONTH(r.completed_at) - 1 DAY), 3)
                + 1
              ) AS label,
              SUM(v.total_cents) / 100.0 AS value,
              MIN(r.completed_at) AS min_ts
            FROM v_driver_payouts v
            JOIN rides r ON r.ride_id = v.ride_id
            WHERE v.driver_id = ?
              AND r.status = 'completed'
              AND r.completed_at >= ?
              AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY label
            ORDER BY min_ts
          `;
        }

        const [rows] = await conn.query(sql, [driver_id, start, end]);
        return rows.map((r) => ({
          label: r.label,
          value: Number(r.value),
        }));
      });

      // ---------- Online hours from Mongo (optional — fails gracefully) ----------
      let hours = 0;
      try {
        const onlineAgg = await DriverOnlineSession.aggregate([
          {
            $match: {
              driver_id: Number(driver_id),
              started_at: { $lt: endPlusOne },
              $or: [{ ended_at: null }, { ended_at: { $gt: startDate } }],
            },
          },
          {
            $project: {
              overlapStart: {
                $cond: [
                  { $gt: ["$started_at", startDate] },
                  "$started_at",
                  startDate,
                ],
              },
              overlapEnd: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$ended_at", null] },
                      { $lt: ["$ended_at", endPlusOne] },
                    ],
                  },
                  "$ended_at",
                  endPlusOne,
                ],
              },
            },
          },
          {
            $project: {
              seconds: {
                $divide: [{ $subtract: ["$overlapEnd", "$overlapStart"] }, 1000],
              },
            },
          },
          { $group: { _id: null, total_seconds: { $sum: "$seconds" } } },
        ]);
        const onlineSeconds = Math.max(0, Math.round(onlineAgg?.[0]?.total_seconds || 0));
        hours = Math.round((onlineSeconds / 3600) * 10) / 10;
      } catch (mongoErr) {
        console.warn("[earnings] MongoDB online-hours unavailable:", mongoErr?.message);
      }

      // Keep your original response shape
      res.json({
        summary: {
          earnings: Number(summary.earnings || 0), // Nu.
          trips: Number(summary.trips || 0),
          hours,
          acc: 1,
          comp: 1,
        },
        trips,
        chart,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Server error" });
    }
  });

  // get earnings of all the drivers
  router.get("/admin/earnings/drivers", async (req, res) => {
    try {
      const { start, end, sort_by, sort_dir, limit, offset, q } =
        req.query || {};

      if (!start || !end) {
        return res
          .status(400)
          .json({ message: "start and end are required (YYYY-MM-DD)" });
      }
      const startStr = String(start).slice(0, 10);
      const endStr = String(end).slice(0, 10);

      const sortCol = SORT_MAP[String(sort_by || "total")] || SORT_MAP.total;
      const dir =
        String(sort_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
      const lim = Math.max(1, Math.min(200, parseInt(limit || "50", 10)));
      const off = Math.max(0, parseInt(offset || "0", 10));

      // Optional search filter on driver name/phone
      const whereSearch = [];
      const paramsSearch = [];
      if (q && String(q).trim().length > 0) {
        whereSearch.push("(d.user_name LIKE ? OR d.phone LIKE ?)");
        const like = `%${String(q).trim()}%`;
        paramsSearch.push(like, like);
      }
      const whereSearchSql = whereSearch.length
        ? `WHERE ${whereSearch.join(" AND ")}`
        : "";

      // We’ll build a derived table of earnings per driver in range, then join drivers for identity fields.
      const sql = `
        WITH
        range_rides AS (
          SELECT r.driver_id,
                 r.completed_at,
                 re.driver_earnings_cents
          FROM rides r
          JOIN ride_earnings re ON re.ride_id = r.ride_id
          WHERE r.status = 'completed'
            AND r.completed_at >= ?
            AND r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)
        ),
        range_adj AS (
          SELECT da.driver_id,
                 da.created_at,
                 CASE WHEN da.amount_cents > 0 THEN da.amount_cents ELSE 0 END AS pos_amount_cents
          FROM driver_adjustments da
          WHERE da.created_at >= ?
            AND da.created_at < DATE_ADD(?, INTERVAL 1 DAY)
        ),
        agg AS (
          SELECT
            d.driver_id,
            COALESCE(SUM(rr.driver_earnings_cents), 0) AS trip_earn_cents,
            COALESCE(COUNT(rr.completed_at), 0)        AS trip_count,
            COALESCE((
              SELECT SUM(pos_amount_cents) FROM range_adj ra WHERE ra.driver_id = d.driver_id
            ), 0) AS adj_earn_cents,
            GREATEST(
              COALESCE((
                SELECT MAX(rr2.completed_at) FROM range_rides rr2 WHERE rr2.driver_id = d.driver_id
              ), '1970-01-01'),
              COALESCE((
                SELECT MAX(ra2.created_at) FROM range_adj ra2 WHERE ra2.driver_id = d.driver_id
              ), '1970-01-01')
            ) AS last_trip_at
          FROM drivers d
          LEFT JOIN range_rides rr ON rr.driver_id = d.driver_id
          ${whereSearchSql}
          GROUP BY d.driver_id
        ),
        final AS (
          SELECT
            a.driver_id,
            a.trip_count,
            a.trip_earn_cents,
            a.adj_earn_cents,
            (a.trip_earn_cents + a.adj_earn_cents) AS total_earn_cents,
            a.last_trip_at
          FROM agg a
        )
        SELECT
          f.driver_id,
          u.user_name,
          u.phone,
          f.trip_count,
          ROUND(f.trip_earn_cents / 100, 2) AS trip_earn_nu,
          ROUND(f.adj_earn_cents  / 100, 2) AS adj_earn_nu,
          ROUND(f.total_earn_cents / 100, 2) AS total_earn_nu,
          CASE WHEN f.last_trip_at IS NULL OR f.last_trip_at = '1970-01-01' THEN NULL
               ELSE DATE_FORMAT(f.last_trip_at, '%Y-%m-%d %H:%i')
          END AS last_trip_at
        FROM final f
        JOIN drivers d ON d.driver_id = f.driver_id
        JOIN users u ON u.user_id = d.user_id AND u.is_active = 1
        ORDER BY ${sortCol} ${dir}
        LIMIT ? OFFSET ?;
      `;

      const countSql = `
        SELECT COUNT(*) AS total_rows
        FROM drivers d
        ${whereSearchSql};
      `;

      // params order: rides window (2), adj window (2), (optional search) + limit/offset
      const params = [
        startStr,
        endStr,
        startStr,
        endStr,
        ...paramsSearch,
        lim,
        off,
      ];
      const countParams = [...paramsSearch];

      const [[countRow]] = await mysqlPool.query(countSql, countParams);
      const [rows] = await mysqlPool.query(sql, params);

      res.json({
        window: { start: startStr, end: endStr },
        total_rows: Number(countRow?.total_rows || 0),
        rows: (rows || []).map((r) => ({
          driver_id: Number(r.driver_id),
          user_name: r.user_name,
          phone: r.phone,
          trips: Number(r.trip_count || 0),
          trip_earn_nu: Number(r.trip_earn_nu || 0),
          adj_earn_nu: Number(r.adj_earn_nu || 0),
          total_earn_nu: Number(r.total_earn_nu || 0),
          last_trip_at: r.last_trip_at || null,
        })),
      });
    } catch (e) {
      console.error("[GET /api/admin/earnings/drivers] error:", e);
      res.status(500).json({ message: "Server error" });
    }
  });

  router.get("/payouts", async (req, res) => {
    try {
      const { ride_id, driver_id, start, end } = req.query || {};
      const limit = Math.max(
        1,
        Math.min(500, parseInt(req.query?.limit ?? "200", 10)),
      );
      const offset = Math.max(0, parseInt(req.query?.offset ?? "0", 10));
      const hasDateFilter = !!(start && end);

      const selectCols = `
        v.ride_id,
        r.service_type,
        r.trip_type,
        r.requested_at,
        r.accepted_at,
        r.arrived_pickup_at,
        r.started_at,
        r.completed_at,
        r.pickup_place,
        r.dropoff_place,
        r.distance_m,
        r.duration_s,
        r.payment_method,

        v.driver_id,
        v.currency,
        ROUND(v.total_cents/100, 2)        AS driver_take_home_nu,
        ROUND(v.base_fare_cents/100, 2)    AS base_gross_nu,
        ROUND(v.time_cents/100, 2)         AS time_gross_nu,
        ROUND(v.tips_cents/100, 2)         AS tips_nu,
        ROUND(v.platform_fee_cents/100, 2) AS platform_fee_nu,
        ROUND(v.tax_cents/100, 2)          AS tax_nu,

        u.user_name  AS driver_name,
        u.phone      AS driver_phone,

        p.user_id     AS passenger_id,
        p.user_name   AS passenger_name,
        p.phone       AS passenger_phone,

        rr.rating     AS ride_rating,
        rr.comment    AS ride_comments
      `;

      const fromSql = `
        FROM v_driver_payouts v
        JOIN rides r    ON r.ride_id = v.ride_id AND r.status = 'completed'
        JOIN drivers d  ON d.driver_id = v.driver_id
        JOIN users u    ON u.user_id = d.user_id AND u.is_active = 1
        JOIN users p    ON p.user_id = r.passenger_id AND p.is_active = 1
        LEFT JOIN ride_ratings rr ON rr.ride_id = r.ride_id
      `;

      const where = [];
      const params = [];

      if (ride_id) {
        where.push(`v.ride_id = ?`);
        params.push(Number(ride_id));
      }
      if (driver_id) {
        where.push(`v.driver_id = ?`);
        params.push(Number(driver_id));
      }
      if (start && end) {
        where.push(`r.completed_at >= ?`);
        where.push(`r.completed_at < DATE_ADD(?, INTERVAL 1 DAY)`);
        params.push(String(start).slice(0, 10), String(end).slice(0, 10));
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const sql = `
        SELECT ${selectCols}
        ${fromSql}
        ${whereSql}
        ORDER BY v.ride_id DESC
        LIMIT ? OFFSET ?
      `;

      const countSql = `
        SELECT COUNT(*) AS cnt
        ${fromSql}
        ${whereSql}
      `;

      const [countRows] = await mysqlPool.query(countSql, params);
      const total = Number(countRows?.[0]?.cnt || 0);

      const [rows] = await mysqlPool.query(sql, [...params, limit, offset]);

      res.json({
        data: rows.map((r) => ({
          driver_details: {
            driver_id: Number(r.driver_id),
            driver_name: r.driver_name,
            driver_phone: r.driver_phone,
          },
          passenger_details: {
            passenger_id: Number(r.passenger_id),
            passenger_name: r.passenger_name,
            passenger_phone: r.passenger_phone,
          },
          ride_details: {
            ride_id: Number(r.ride_id),
            service_type: r.service_type,
            trip_type: r.trip_type,
            requested_at: r.requested_at
              ? new Date(r.requested_at).toISOString()
              : null,
            accepted_at: r.accepted_at
              ? new Date(r.accepted_at).toISOString()
              : null,
            arrived_pickup_at: r.arrived_pickup_at
              ? new Date(r.arrived_pickup_at).toISOString()
              : null,
            started_at: r.started_at
              ? new Date(r.started_at).toISOString()
              : null,
            completed_at: r.completed_at
              ? new Date(r.completed_at).toISOString()
              : null,
            pickup_place: r.pickup_place,
            dropoff_place: r.dropoff_place,
            distance_m: Number(r.distance_m) / 1000,
            duration_s: Number(r.duration_s) / 60,
            driver_ratings: {
              rating: r.ride_rating ? Number(r.ride_rating) : null,
              comments: r.ride_comments || null,
            },
          },
          fare_details: {
            currency: r.currency,
            driver_take_home_nu: Number(r.driver_take_home_nu),
            base_gross_nu: Number(r.base_gross_nu),
            time_gross_nu: Number(r.time_gross_nu),
            tips_nu: Number(r.tips_nu),
            platform_fee_nu: Number(r.platform_fee_nu),
            tax_nu: Number(r.tax_nu),
            payment_method: r.payment_method || "unknown", // Placeholder; extend v_driver_payouts if needed
          },
        })),
        meta: { limit, offset, count: total },
      });
    } catch (e) {
      console.error("[GET /payouts] error:", e);
      res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}
