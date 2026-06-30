import express from "express";
import { withConn } from "../db/mysql.js";

export const getDeliveryRideId = express.Router();

/**
 * GET /api/delivery/ride-by-order?order_id=ORD123
 * Returns the delivery_ride_id for a given order_id
 */
getDeliveryRideId.get("/ride-by-order", async (req, res) => {
  const { order_id } = req.query;

  if (!order_id) {
    return res.status(400).json({ message: "order_id required" });
  }

  try {
    const result = await withConn(async (conn) => {
      const [[row]] = await conn.query(
        `SELECT order_id, delivery_ride_id, delivery_batch_id, delivery_driver_id
         FROM orders
         WHERE order_id = ?
         LIMIT 1`,
        [String(order_id)]
      );

      if (!row) {
        return { status: 404, body: { message: "Order not found" } };
      }

      if (!row.delivery_ride_id) {
        return { status: 404, body: { message: "No delivery ride assigned to this order yet" } };
      }

      return {
        status: 200,
        body: {
          ok: true,
          order_id: String(row.order_id),
          delivery_ride_id: String(row.delivery_ride_id),
          delivery_driver_id: row.delivery_driver_id ? String(row.delivery_driver_id) : null,
          delivery_batch_id: row.delivery_batch_id ? String(row.delivery_batch_id) : null,
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("[GET /ride-by-order] error:", e?.message || e);
    return res.status(500).json({ message: "Server error" });
  }
});

getDeliveryRideId.get("/ride", async (req, res) => {
  const delivery_batch_id = req.query.delivery_batch_id;

  if (!delivery_batch_id) {
    return res.status(400).json({ message: "delivery_batch_id required" });
  }

  try {
    const result = await withConn(async (conn) => {
      const [rows] = await conn.query(
        `
        SELECT DISTINCT delivery_ride_id
        FROM orders
        WHERE delivery_batch_id = ?
          AND delivery_ride_id IS NOT NULL
        LIMIT 1
        `,
        [delivery_batch_id]
      );

      const row = rows?.[0];
      if (!row?.delivery_ride_id) {
        return {
          status: 404,
          body: { message: "delivery_ride_id not found for this delivery_batch_id" },
        };
      }

      return {
        status: 200,
        body: {
          ok: true,
          delivery_batch_id: String(delivery_batch_id),
          delivery_ride_id: String(row.delivery_ride_id),
        },
      };
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("[GET /ride] error:", e?.message || e);
    return res.status(500).json({ message: "Server error" });
  }
});
