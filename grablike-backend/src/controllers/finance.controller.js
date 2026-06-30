// src/controllers/finance.controller.js
import { withConn } from "../db/mysql.js";

export async function getGstReport(req, res) {
  const { from, to, service_type, city_id } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error: "from and to dates are required",
    });
  }

  try {
    const data = await withConn(async (conn) => {
      const params = [from, to];
      let filters = "";

      if (service_type) {
        filters += " AND r.service_type = ? ";
        params.push(service_type);
      }
      if (city_id) {
        filters += " AND r.city_id = ? ";
        params.push(city_id);
      }

      const [rows] = await conn.query(
        `
        SELECT
          DATE_FORMAT(r.completed_at, '%Y-%m') AS month,
          COUNT(*) AS total_rides,
          SUM(p.platform_fee_cents) AS platform_fee_cents,
          SUM(p.gst_cents) AS gst_cents
        FROM ride_pricing_snapshots p
        JOIN rides r ON r.ride_id = p.ride_id
        WHERE r.status = 'completed'
          AND r.completed_at BETWEEN ? AND ?
          ${filters}
        GROUP BY month
        ORDER BY month ASC
        `,
        params
      );

      return rows.map((r) => ({
        month: r.month,
        total_rides: Number(r.total_rides),
        platform_fee_nu: Number((r.platform_fee_cents / 100).toFixed(2)),
        gst_nu: Number((r.gst_cents / 100).toFixed(2)),
      }));
    });

    res.json({ ok: true, data });
  } catch (e) {
    console.error("[GST REPORT]", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}

// get all the finance summary (temporary alias)
export async function getFinanceSummary(req, res) {
  try {
    const summary = await withConn(async (conn) => {
      const [rows] = await conn.query(
        `
        SELECT *
        FROM ride_pricing_snapshots
        ORDER BY id DESC
        `
      );

      return {
        rows,          // ✅ all rows
        count: rows.length,
      };
    });

    return res.json({ ok: true, data: summary });
  } catch (e) {
    console.error("[FINANCE SUMMARY]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

