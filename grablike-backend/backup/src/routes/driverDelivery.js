// src/routes/driverDelivery.js
import express from "express";
import matcher from "../matching/matcher.js";
import { rideHash } from "../matching/redisKeys.js";
import * as redisMod from "../matching/redis.js";
import { mysqlPool } from "../db/mysql.js";
import { getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

const getRedis =
  redisMod.getRedis ?? (redisMod.default && redisMod.default.getRedis);
const redis = getRedis();

const router = express.Router();

/* =====================================================================
   SOCKET ROOM HELPERS (business-based)
   ===================================================================== */
const businessRoom = (id) => `business:${id}`;
const merchantRoom = (id) => `merchant:${id}`; // ✅ optional fallback room

function roomSize(io, room) {
  return io?.sockets?.adapter?.rooms?.get(room)?.size ?? 0;
}

function logRoomNotify(io, room, event, payload) {
  const size = roomSize(io, room);
  console.log(
    `[notify] event=${event} room=${room} sockets=${size} payload=${JSON.stringify(
      payload
    )}`
  );
}

function emitToBusinessAndMerchant(io, businessId, event, payload) {
  const bRoom = businessRoom(businessId);
  const mRoom = merchantRoom(businessId);

  // emit to business room
  logRoomNotify(io, bRoom, event, payload);
  io.to(bRoom).emit(event, payload);

  // emit to merchant room as fallback (in case merchant app joins merchant:ID)
  if (mRoom !== bRoom) {
    logRoomNotify(io, mRoom, event, payload);
    io.to(mRoom).emit(event, payload);
  }
}

async function getBusinessIdByOrderId(orderId) {
  const [[row]] = await mysqlPool.query(
    `SELECT business_id FROM orders WHERE order_id = ? LIMIT 1`,
    [String(orderId)]
  );
  return row?.business_id ?? null;
}

/* =====================================================================
   HELPER QUERIES – run directly on MySQL via mysqlPool
   (Adjust table/column names if yours are slightly different.)
   ===================================================================== */

// When a driver is assigned to a BATCH job
async function assignBatchDriver(batch_id, driver_id, ride_id) {
  // 1) Update the batch master row (if you have delivery_batches table)
  await mysqlPool.execute(
    `
    UPDATE delivery_batches
       SET driver_id = ?, ride_id = ?, status = 'ASSIGNED', assigned_at = NOW()
     WHERE batch_id = ?
    `,
    [driver_id, ride_id, batch_id]
  );

  // 2) Update all orders that belong to this batch
  await mysqlPool.execute(
    `
    UPDATE orders
       SET delivery_driver_id = ?,
           delivery_ride_id   = ?,
           delivery_status    = 'ASSIGNED',
           status             = 'ASSIGNED'
     WHERE delivery_batch_id = ?
    `,
    [driver_id, ride_id, batch_id]
  );
}

// When driver presses "Picked up all orders" at merchant
async function markBatchPickedUp(batch_id) {
  await mysqlPool.execute(
    `
    UPDATE delivery_batches
       SET status = 'IN_PROGRESS',
           picked_up_at = NOW()
     WHERE batch_id = ?
    `,
    [batch_id]
  );

  await mysqlPool.execute(
    `
    UPDATE orders
       SET delivery_status = 'ON_THE_WAY',
           status         = 'ON_THE_WAY'
     WHERE delivery_batch_id = ?
    `,
    [batch_id]
  );
}

// Mark one specific order as delivered
async function markOrderDelivered(orderId, driver_id, ride_id) {
  await mysqlPool.execute(
    `
    UPDATE orders
       SET delivery_status    = 'DELIVERED',
           status             = 'DELIVERED',
           delivered_at       = NOW(),
           delivery_driver_id = ?,
           delivery_ride_id   = ?
     WHERE order_id = ?
    `,
    [driver_id, ride_id, String(orderId)]
  );
}

/* =====================================================================
   POST /driver/delivery/accept
   Driver accepts a delivery job (single or batch)
   ===================================================================== */
router.post("/accept", async (req, res) => {
  const { rideId, driverId } = req.body || {};
  if (!rideId || !driverId) {
    return res
      .status(400)
      .json({ ok: false, error: "rideId and driverId required" });
  }

  try {
    // 1) Let matcher enforce race lock
    const result = await matcher.acceptOffer({
      io: req.app.get("io"),
      rideId,
      driverId: String(driverId),
    });

    if (!result.ok) {
      return res
        .status(409)
        .json({ ok: false, error: result.reason || "already_taken" });
    }

    // 2) Read ride metadata from Redis (job_type, batch_id)
    const ride = await redis.hgetall(rideHash(rideId));
    const job_type = ride?.job_type || "SINGLE";
    const batch_id = ride?.batch_id ? Number(ride.batch_id) : null;

    // 3) If batch job → update merchant DB directly
    if (job_type === "BATCH" && batch_id) {
      try {
        await assignBatchDriver(batch_id, Number(driverId), Number(rideId));
      } catch (e) {
        console.error(
          "[driverDelivery.accept] assignBatchDriver error:",
          e?.message || e
        );
      }
    }

    return res.json({ ok: true, job_type, batch_id });
  } catch (e) {
    console.error("[driverDelivery.accept] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* =====================================================================
   POST /driver/delivery/pickup
   Driver confirms pickup at merchant (usually for batch)
   ===================================================================== */
router.post("/pickup", async (req, res) => {
  const { rideId, driverId } = req.body || {};
  if (!rideId || !driverId) {
    return res
      .status(400)
      .json({ ok: false, error: "rideId and driverId required" });
  }

  try {
    const ride = await redis.hgetall(rideHash(rideId));
    if (!ride) {
      return res.status(404).json({ ok: false, error: "ride_not_found" });
    }

    const job_type = ride.job_type || "SINGLE";
    const batch_id = ride.batch_id ? Number(ride.batch_id) : null;

    if (job_type === "BATCH" && batch_id) {
      try {
        await markBatchPickedUp(batch_id);

        // Push to all customers in this batch: order is on the way
        const [batchOrders] = await mysqlPool.query(
          `SELECT DISTINCT user_id FROM orders WHERE delivery_batch_id = ? AND user_id IS NOT NULL`,
          [batch_id]
        );
        const customerIds = batchOrders.map((r) => r.user_id).filter(Boolean);
        if (customerIds.length) {
          getPushTokensByUserIds(customerIds).then((tokens) => {
            if (tokens.length) {
              sendPushToTokens(tokens, {
                title: "Order On The Way",
                body: "Your order has been picked up and is on the way!",
                data: { type: "order_picked_up", ride_id: String(rideId), batch_id },
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch (e) {
        console.error(
          "[driverDelivery.pickup] markBatchPickedUp error:",
          e?.message || e
        );
      }
    }

    // Update ride status in Redis for your own tracking
    await redis.hset(rideHash(rideId), { status: "picked_up" });

    // Notify via sockets (ride room)
    const io = req.app.get("io");
    try {
      io.to(`ride:${rideId}`).emit("deliveryPickedUp", {
        ride_id: String(rideId),
        driver_id: String(driverId),
        job_type,
        batch_id,
      });
    } catch (e) {
      console.error(
        "[driverDelivery.pickup] socket emit error:",
        e?.message || e
      );
    }

    return res.json({ ok: true, job_type, batch_id });
  } catch (e) {
    console.error("[driverDelivery.pickup] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* =====================================================================
   POST /driver/delivery/deliver
   Driver has delivered ONE order
   ===================================================================== */
router.post("/deliver", async (req, res) => {
  const { rideId, driverId, orderId } = req.body || {};
  if (!rideId || !driverId || !orderId) {
    return res.status(400).json({
      ok: false,
      error: "rideId, driverId and orderId required",
    });
  }

  try {
    const ride = await redis.hgetall(rideHash(rideId));
    if (!ride) {
      return res.status(404).json({ ok: false, error: "ride_not_found" });
    }

    const job_type = ride.job_type || "SINGLE";
    const batch_id = ride.batch_id ? Number(ride.batch_id) : null;

    // 1) Mark order delivered in merchant tables
    try {
      await markOrderDelivered(orderId, Number(driverId), Number(rideId));
    } catch (e) {
      console.error(
        "[driverDelivery.deliver] markOrderDelivered error:",
        e?.message || e
      );
    }

    // Push to the customer that their order was delivered
    try {
      const [[orderRow]] = await mysqlPool.query(
        `SELECT user_id FROM orders WHERE order_id = ? LIMIT 1`,
        [String(orderId)]
      );
      if (orderRow?.user_id) {
        getPushTokensByUserIds([orderRow.user_id]).then((tokens) => {
          if (tokens.length) {
            sendPushToTokens(tokens, {
              title: "Order Delivered",
              body: "Your order has been delivered. Enjoy!",
              data: { type: "order_delivered", order_id: String(orderId), ride_id: String(rideId) },
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[driverDelivery.deliver] push notify error:", e?.message || e);
    }

    const io = req.app.get("io");

    // 2) Notify user app TrackOrder (optional)
    try {
      io.to(`order:${orderId}`).emit("orderStatus", {
        order_id: String(orderId),
        status: "DELIVERED",
      });
    } catch (e) {
      console.error(
        "[driverDelivery.deliver] socket orderStatus error:",
        e?.message || e
      );
    }

    // ✅ 3) Notify merchant/business that this order is DELIVERED
    try {
      const business_id = await getBusinessIdByOrderId(orderId);

      if (business_id) {
        const payload = {
          order_id: String(orderId),
          delivery_status: "DELIVERED",
          status: "DELIVERED",
          ride_id: String(rideId),
          driver_id: String(driverId),
          job_type,
          batch_id,
        };

        emitToBusinessAndMerchant(io, business_id, "orderDelivered", payload);
      } else {
        console.warn(
          "[notify] orderDelivered skipped: business_id not found for order",
          orderId
        );
      }
    } catch (e) {
      console.warn("[notify] orderDelivered error:", e?.message || e);
    }

    return res.json({
      ok: true,
      job_type,
      batch_id,
      order_id: String(orderId),
    });
  } catch (e) {
    console.error("[driverDelivery.deliver] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* =====================================================================
   POST /driver/delivery/batch/create
   Create batch for a business (you used merchant_id before; now it is business_id)
   ===================================================================== */
router.post("/batch/create", async (req, res) => {
  const { business_id, order_ids } = req.body || {};

  if (!business_id || !Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({
      ok: false,
      error: "business_id & order_ids[] required",
    });
  }

  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Create batch master row
    const [batchRow] = await conn.execute(
      `
      INSERT INTO delivery_batches (
        merchant_id,
        total_orders,
        status,
        created_at
      )
      VALUES (?, ?, 'forming', NOW())
      `,
      [business_id, order_ids.length]
    );
    const batch_id = batchRow.insertId;

    // 2) Ensure these orders belong to this business_id
    const [orders] = await conn.query(
      `
      SELECT DISTINCT o.order_id
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.order_id IN (?)
         AND oi.business_id = ?
      `,
      [order_ids, business_id]
    );

    console.log("[batch.create] incoming", { business_id, order_ids });
    console.log("[batch.create] matched orders:", orders);

    if (!orders.length) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "No matching orders for given order_ids + business_id",
      });
    }

    const orderIdList = orders.map((r) => r.order_id);

    // 3) Attach order_items to this batch
    await conn.query(
      `
      UPDATE order_items
         SET batch_id = ?
       WHERE order_id IN (?)
         AND business_id = ?
      `,
      [batch_id, orderIdList, business_id]
    );

    // 4) Update orders → link to batch + set delivery_status
    await conn.query(
      `
      UPDATE orders
         SET delivery_status   = 'PENDING',
             business_id      = ?,
             delivery_batch_id = ?,
             batch_id          = ?
       WHERE order_id IN (?)
      `,
      [business_id, batch_id, batch_id, orderIdList]
    );

    await conn.commit();

    console.log("[delivery.batch.create] created batch", {
      batch_id,
      business_id,
      orderIdList,
    });

    return res.json({ ok: true, batch_id });
  } catch (e) {
    await conn.rollback();
    console.error("[delivery.batch.create] error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    conn.release();
  }
});

/* =====================================================================
   POST /driver/delivery/drop-stage
   Mark one specific order status (DELIVERED, etc.)
   + notify merchant when DELIVERED
   ===================================================================== */
router.post("/drop-stage", async (req, res) => {
  const { delivery_ride_id, order_id, status, driver_id } = req.body || {};
  console.log("[drop-stage] incoming:", {
    delivery_ride_id,
    order_id,
    status,
    driver_id,
  });

  if (!delivery_ride_id || !order_id || !status) {
    return res.status(400).json({
      ok: false,
      error: "Missing delivery_ride_id, order_id or status",
    });
  }

  const newStatus = String(status).toUpperCase(); // expect "DELIVERED"

  const conn = await mysqlPool.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.query(
      `
      SELECT order_id, status, delivery_status, delivery_ride_id, delivery_driver_id, business_id, user_id
        FROM orders
       WHERE order_id = ?
       LIMIT 1
       FOR UPDATE
      `,
      [String(order_id)]
    );

    if (!order) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Order not found" });
    }

    console.log("[drop-stage] found:", order);

    if (
      order.delivery_ride_id != null &&
      String(order.delivery_ride_id) !== String(delivery_ride_id)
    ) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "Order does not belong to this delivery_ride_id",
      });
    }

    const [upd] = await conn.query(
      `
      UPDATE orders
         SET status = ?,
             delivery_status = ?,
             delivery_driver_id = COALESCE(?, delivery_driver_id),
             delivery_ride_id   = COALESCE(?, delivery_ride_id),
             delivered_at = CASE WHEN ? = 'DELIVERED' THEN NOW() ELSE delivered_at END
       WHERE order_id = ?
      `,
      [
        newStatus,
        newStatus,
        driver_id ? String(driver_id) : null,
        delivery_ride_id ? String(delivery_ride_id) : null,
        newStatus,
        String(order_id),
      ]
    );

    console.log("[drop-stage] affectedRows:", upd?.affectedRows);

    if (!upd?.affectedRows) {
      await conn.rollback();
      return res
        .status(500)
        .json({ ok: false, error: "Update affected 0 rows" });
    }

    await conn.commit();

    // ✅ Notify merchant/business ONLY when DELIVERED
    try {
      const io = req.app.get("io");
      const business_id =
        order?.business_id ?? (await getBusinessIdByOrderId(order_id));

      if (business_id && newStatus === "DELIVERED") {
        const payload = {
          order_id: String(order_id),
          delivery_status: "DELIVERED",
          status: "DELIVERED",
          delivery_ride_id: String(delivery_ride_id),
          driver_id: driver_id ? String(driver_id) : null,
        };

        emitToBusinessAndMerchant(io, business_id, "orderDelivered", payload);
      } else {
        console.log("[notify] drop-stage not emitting", {
          newStatus,
          business_id,
          order_id: String(order_id),
        });
      }
    } catch (e) {
      console.warn("[notify] drop-stage notify error:", e?.message || e);
    }

    // Push to customer when their order is delivered
    if (newStatus === "DELIVERED" && order?.user_id) {
      getPushTokensByUserIds([order.user_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Order Delivered",
            body: "Your order has been delivered. Enjoy!",
            data: { type: "order_delivered", order_id: String(order_id), delivery_ride_id: String(delivery_ride_id) },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      order_id: String(order_id),
      delivery_status: newStatus,
      status: newStatus,
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    console.error("[drop-stage] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

export default router;
