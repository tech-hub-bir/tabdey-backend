import express from "express";
import { withConn } from "../db/mysql.js";

export function getBatchAndRideId() {
  const router = express.Router();

  router.get("/get-batch-ride-id", async (req, res) => {
    try {
      const business_id_raw = req.query.business_id;
      const business_id =
        business_id_raw != null && String(business_id_raw).trim() !== ""
          ? Number(business_id_raw)
          : null;

      if (!Number.isFinite(business_id) || business_id <= 0) {
        return res
          .status(400)
          .json({ ok: false, error: "business_id is required and must be a number" });
      }

      const rows = await withConn(async (conn) => {
        const [result] = await conn.query(
          `
          SELECT order_id, batch_id, delivery_ride_id, delivery_driver_id, status
          FROM orders
          WHERE business_id = ?
            AND status NOT IN ('DELIVERED', 'DECLINED')
            AND batch_id IS NOT NULL
            AND delivery_ride_id IS NOT NULL
            AND batch_id <> ''
            AND delivery_ride_id <> ''
          ORDER BY created_at DESC
          `,
          [business_id]
        );
        return result || [];
      });

      // Group: batch_id -> { batch_id, ride_id, order_ids: [] }
      const grouped = new Map();

      for (const r of rows) {
        const batchId = String(r.batch_id || "").trim();
        const rideId = String(r.delivery_ride_id || "").trim();
        const orderId = r.order_id;

        if (!batchId || !rideId) continue;

        if (!grouped.has(batchId)) {
          grouped.set(batchId, {
            batch_id: batchId,
            ride_id: rideId,
            driver_id: r.delivery_driver_id,
            order_ids: [],
          });
        }

        const item = grouped.get(batchId);

        // If batch has multiple ride IDs (rare), keep latest seen (because ORDER BY created_at DESC)
        if (rideId && item.ride_id !== rideId) item.ride_id = rideId;

        item.order_ids.push(orderId);
      }

      const data = Array.from(grouped.values()).map((x) => ({
        ...x,
        order_ids: Array.from(new Set(x.order_ids)),
      }));

      res.json({ ok: true, data });
    } catch (e) {
      console.error("[GET /get-batch-ride-id] error:", e);
      res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  return router;
}
