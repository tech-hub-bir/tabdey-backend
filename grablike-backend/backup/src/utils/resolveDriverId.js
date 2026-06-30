// src/utils/resolveDriverId.js (ESM)
export async function resolveDriverIdFromUserId({ userId, baseUrl }) {
  if (!userId) throw new Error("userId is required to resolve driver_id");

  const url = `${String(baseUrl || "").replace(
    /\/+$/,
    "",
  )}/api/drivers/by-user/${encodeURIComponent(String(userId))}`;

  const res = await fetch(url, { method: "GET" });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json?.error || json?.message || "Driver lookup failed");
  }

  // Accept a few common response shapes safely:
  const driverId =
    json?.driver_id ??
    json?.data?.driver_id ??
    json?.data?.driver?.driver_id ??
    json?.driver?.driver_id ??
    null;

  if (!driverId) throw new Error("driver_id not found for this user");

  return String(driverId);
}

export async function resolveUserIdFromDriverId({ mysqlPool, driverId }) {
  if (!driverId) throw new Error("driverId is required to resolve user_id");
  try {
    console.log("Driver Id: ", driverId);

    if (!Number.isFinite(driverId) || driverId <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Valid driverId is required" });
    }

    const conn = await mysqlPool.getConnection();
    try {
      const [[row]] = await conn.query(
        "SELECT user_id FROM drivers WHERE driver_id = ? LIMIT 1",
        [driverId],
      );

      if (!row) {
        return res.status(404).json({
          ok: false,
          error: `No driver found for driver_id=${driverId}`,
        });
      }
      console.log("User Id: ", row.user_id);
      return String(row.user_id);
    } finally {
      try {
        conn.release();
      } catch {}
    }
  } catch (err) {
    console.error("[GET /api/driver_id] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

// get driver details (including user details) from batch_id
export async function resolveDriverDetailsFromOrderBatchedIds(db, { batchId }) {
  if (!batchId) throw new Error("batchId is required");

  let conn;
  let isConnectionProvided = typeof db.query === "function"; // simple check for connection

  try {
    if (isConnectionProvided) {
      conn = db; // use the provided connection directly
    } else {
      conn = await db.getConnection(); // assume it's a pool
    }

    // First, get the driver_id from the orders table for this batch
    // Use LIMIT 1 because all orders in a batch share the same driver
    const [[orderRow]] = await conn.query(
      `SELECT delivery_driver_id FROM orders WHERE batch_id = ? LIMIT 1`,
      [batchId],
    );

    if (!orderRow || !orderRow.delivery_driver_id) return null;

    const driverId = orderRow.delivery_driver_id;

    // Get driver and user details, plus average rating and count
    const [[driverInfo]] = await conn.query(
      `SELECT 
          d.driver_id,
          d.user_id,
          u.*,
          (SELECT ROUND(AVG(rating), 1) FROM ride_ratings WHERE driver_id = d.driver_id) AS avg_rating,
          (SELECT COUNT(*) FROM ride_ratings WHERE driver_id = d.driver_id) AS rating_count
       FROM drivers d
       JOIN users u ON u.user_id = d.user_id
       WHERE d.driver_id = ?`,
      [driverId],
    );

    if (!driverInfo) return null;

    // Return user details and rating info (rename avg_rating to rating for consistency)
    return {
      driver_id: String(driverInfo.driver_id),
      user_details: {
        ...driverInfo,
        // Remove fields that are not part of user table if necessary
        driver_id: undefined,
        user_id: driverInfo.user_id,
        avg_rating: undefined, // we'll add rating below
        rating_count: undefined,
      },
      rating: driverInfo.avg_rating,
      rating_count: driverInfo.rating_count,
    };
  } finally {
    // Only release if we acquired the connection ourselves
    if (!isConnectionProvided && conn) {
      try {
        conn.release();
      } catch {}
    }
  }
}
