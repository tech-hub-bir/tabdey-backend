// src/services/deliveryBatchService.js
import { query, getPool } from "../db/mysql.js";

/* ========= CONFIG (tune these) ========= */

// Orders created within this window (minutes) can be batched together
const BATCH_WINDOW_MIN = 8;

// Max distance between addresses to allow batching
const MAX_DISTANCE_KM = 2.5;

// Treat these statuses as "finished" (not active for batch)
const NON_ACTIVE_STATUSES = [
  "DELIVERED",
  "CANCELLED_USER",
  "CANCELLED_MERCHANT",
  "CANCELLED_SYSTEM",
  "CANCELLED",
];

/* ========= small helpers ========= */

function toRad(v) {
  return (v * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (
    lat1 == null ||
    lon1 == null ||
    lat2 == null ||
    lon2 == null ||
    isNaN(lat1) ||
    isNaN(lon1) ||
    isNaN(lat2) ||
    isNaN(lon2)
  )
    return Infinity;

  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/* ========= 1. Attach order to batch ========= */
/**
 * Called right after you create an order row.
 * - serviceType: "FOOD" or "MART"
 * - orderId: orders.order_id (string)
 *
 * It will:
 *   1) Load this order (business_id, delivery_lat/lng…)
 *   2) Try to join an existing nearby batch for same business+service
 *   3) Or create a new batch row
 *   4) Update orders.batch_id & order_items.batch_id
 */
export async function attachOrderToBatch(serviceType, orderId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Load order
    const [rows] = await conn.execute(
      `
      SELECT order_id, user_id, business_id, batch_id,
             delivery_lat, delivery_lng,
             created_at, status, service_type
      FROM orders
      WHERE order_id = ?
      FOR UPDATE
    `,
      [orderId]
    );
    const order = rows[0];
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (!order.business_id) {
      throw new Error(
        `Order ${orderId} has no business_id – set this from order_items when creating the order.`
      );
    }

    // Already in batch
    if (order.batch_id) {
      await conn.commit();
      return order.batch_id;
    }

    const now = new Date();
    const windowStart = new Date(
      now.getTime() - BATCH_WINDOW_MIN * 60 * 1000
    );

    // Find existing orders from same business/service with a batch
    const [others] = await conn.execute(
      `
      SELECT order_id, delivery_lat, delivery_lng, batch_id
      FROM orders
      WHERE business_id = ?
        AND service_type = ?
        AND batch_id IS NOT NULL
        AND status NOT IN (${NON_ACTIVE_STATUSES.map(() => "?").join(",")})
        AND created_at >= ?
      FOR UPDATE
    `,
      [order.business_id, serviceType, ...NON_ACTIVE_STATUSES, windowStart]
    );

    let chosenBatchId = null;

    // Try to join existing batch based on distance
    for (const o of others) {
      const dist = haversineKm(
        Number(order.delivery_lat),
        Number(order.delivery_lng),
        Number(o.delivery_lat),
        Number(o.delivery_lng)
      );
      if (dist <= MAX_DISTANCE_KM && o.batch_id) {
        chosenBatchId = o.batch_id;
        break;
      }
    }

    // If no suitable batch, create a new one
    if (!chosenBatchId) {
      const [res] = await conn.execute(
        `
        INSERT INTO delivery_batches
          (business_id, service_type, status)
        VALUES (?, ?, 'FORMING')
      `,
        [order.business_id, serviceType]
      );
      chosenBatchId = res.insertId;
    }

    // Attach order to batch
    await conn.execute(
      `
      UPDATE orders
      SET batch_id = ?
      WHERE order_id = ?
    `,
      [chosenBatchId, order.order_id]
    );

    // Mirror batch_id down to items for convenience
    await conn.execute(
      `
      UPDATE order_items
      SET batch_id = ?
      WHERE order_id = ?
    `,
      [chosenBatchId, order.order_id]
    );

    await conn.commit();
    return chosenBatchId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ========= 2. Recompute batch status from its orders ========= */
/**
 * Call this whenever merchant changes an order status.
 * It updates delivery_batches.status based on all orders in that batch.
 */
export async function recomputeBatchStatus(batchId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [orders] = await conn.execute(
      `
      SELECT order_id, status
      FROM orders
      WHERE batch_id = ?
      FOR UPDATE
    `,
    [batchId]
    );

    if (orders.length === 0) {
      await conn.execute(
        `UPDATE delivery_batches SET status = 'CANCELLED' WHERE batch_id = ?`,
        [batchId]
      );
      await conn.commit();
      return;
    }

    const statuses = orders.map((o) => o.status);

    const allDone = statuses.every((s) =>
      NON_ACTIVE_STATUSES.concat("DELIVERED").includes(s)
    );
    const anyReady = statuses.some((s) => s === "READY");

    const [batchRows] = await conn.execute(
      `SELECT status FROM delivery_batches WHERE batch_id = ? FOR UPDATE`,
      [batchId]
    );
    const current = batchRows[0]?.status || "FORMING";
    let next = current;

    if (allDone) {
      next = "COMPLETED";
    } else if (current === "FORMING" && anyReady) {
      next = "READY_FOR_PICKUP";
    }

    if (next !== current) {
      await conn.execute(
        `UPDATE delivery_batches SET status = ? WHERE batch_id = ?`,
        [next, batchId]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ========= 3. Assign driver to batch ========= */

export async function assignDriverToBatch(batchId, driverId) {
  await query(
    `
    UPDATE delivery_batches
    SET driver_id = ?, status = 'ASSIGNED_DRIVER'
    WHERE batch_id = ?
  `,
    [driverId, batchId]
  );
}

/* ========= 4. Driver picked up all orders in the batch ========= */
/**
 * Called when driver hits "Picked up all" in the app.
 *  -> all non-cancelled orders: ON_THE_WAY
 *  -> batch: IN_PROGRESS
 */
export async function markBatchPickedUp(batchId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.execute(
      `
      UPDATE orders
      SET status = 'ON_THE_WAY'
      WHERE batch_id = ?
        AND status IN ('PENDING','CONFIRMED','PREPARING','READY')
    `,
      [batchId]
    );

    await conn.execute(
      `
      UPDATE delivery_batches
      SET status = 'IN_PROGRESS'
      WHERE batch_id = ?
    `,
      [batchId]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ========= 5. One order delivered ========= */
/**
 * Driver presses "Delivered" for a specific order in the batch.
 */
export async function markOrderDelivered(orderId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [oRows] = await conn.execute(
      `
      SELECT order_id, batch_id
      FROM orders
      WHERE order_id = ?
      FOR UPDATE
    `,
      [orderId]
    );
    const order = oRows[0];
    if (!order) throw new Error(`Order ${orderId} not found`);

    await conn.execute(
      `
      UPDATE orders
      SET status = 'DELIVERED'
      WHERE order_id = ?
    `,
      [orderId]
    );

    if (order.batch_id) {
      const [orders] = await conn.execute(
        `
        SELECT status
        FROM orders
        WHERE batch_id = ?
        FOR UPDATE
      `,
        [order.batch_id]
      );

      const allDone = orders.every((o) =>
        NON_ACTIVE_STATUSES.concat("DELIVERED").includes(o.status)
      );

      if (allDone) {
        await conn.execute(
          `
          UPDATE delivery_batches
          SET status = 'COMPLETED'
          WHERE batch_id = ?
        `,
          [order.batch_id]
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ========= 6. Load batch + orders (for driver UI) ========= */

export async function getBatchWithOrders(batchId) {
  const batchRows = await query(
    `
    SELECT batch_id, business_id, service_type, driver_id, status
    FROM delivery_batches
    WHERE batch_id = ?
  `,
    [batchId]
  );
  const batch = batchRows[0];
  if (!batch) return null;

  const orders = await query(
    `
    SELECT order_id, user_id, status,
           delivery_lat, delivery_lng, delivery_address
    FROM orders
    WHERE batch_id = ?
      AND status NOT IN (${NON_ACTIVE_STATUSES.map(() => "?").join(",")})
  `,
    [batchId, ...NON_ACTIVE_STATUSES]
  );

  return { batch, orders };
}
