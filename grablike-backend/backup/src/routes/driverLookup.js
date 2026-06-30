// src/routes/driverLookup.js
import express from "express";
import { resolveDriverDetailsFromOrderBatchedIds } from "../utils/resolveDriverId.js";
/**
 * Mount with:
 *   import makeDriverLookupRouter from "./routes/driverLookup.js";
 *   app.use("/api", makeDriverLookupRouter(mysqlPool));
 */
export default function makeDriverLookupRouter(mysqlPool) {
  const router = express.Router();

  // GET driver details using driverId /api/driver_id?driverId=12
  router.get("/driver_id", async (req, res) => {
    try {
      const raw = req.query.driverId;
      const driverId = Number(raw);
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

        const userId = row.user_id;

        const [[userDetails]] = await conn.query(
          "SELECT * FROM users WHERE user_id = ? LIMIT 1",
          [userId],
        );

        return res.json({
          ok: true,
          details: userDetails || null,
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error("[GET /api/driver_id] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });
  // GET /api/driver-id?userId=123
  router.get("/driver-id", async (req, res) => {
    try {
      const raw = req.query.userId;
      const userId = Number(raw);

      if (!Number.isFinite(userId) || userId <= 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Valid userId is required" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[row]] = await conn.query(
          "SELECT driver_id FROM drivers WHERE user_id = ? LIMIT 1",
          [userId],
        );

        if (!row) {
          return res.status(404).json({
            ok: false,
            error: `No driver found for user_id=${userId}`,
          });
        }

        return res.json({
          ok: true,
          user_id: userId,
          driver_id: row.driver_id,
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error("[GET /api/driver-id] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // (Optional) Path-style variant:
  // GET /api/drivers/by-user/123
  router.get("/drivers/by-user/:userId", async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Valid userId is required" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[row]] = await conn.query(
          "SELECT driver_id FROM drivers WHERE user_id = ? LIMIT 1",
          [userId],
        );

        if (!row) {
          return res.status(404).json({
            ok: false,
            error: `No driver found for user_id=${userId}`,
          });
        }

        return res.json({
          ok: true,
          user_id: userId,
          driver_id: row.driver_id,
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error("[GET /api/drivers/by-user/:userId] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // GET /api/get-driver-vehicle-details?driverId=456 using driver_id instead of userID
  router.get("/vehicle-details", async (req, res) => {
    try {
      const raw = req.query.driverId;
      const driverId = Number(raw);

      if (!Number.isFinite(driverId) || driverId <= 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Valid driverId is required" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[row]] = await conn.query(
          `SELECT v.vehicle_id, v.make, v.model, v.year, v.color, v.license_plate, v.vehicle_type, v.actual_capacity, v.features, v.insurance_expiry, v.code
           FROM driver_vehicles v
           JOIN drivers d ON v.driver_id = d.driver_id
           WHERE d.driver_id = ? LIMIT 1`,
          [driverId],
        );

        if (!row) {
          return res.status(404).json({
            ok: false,
            error: `No vehicle found for driver_id=${driverId}`,
          });
        }

        return res.json({
          ok: true,
          details: {
            vehicle_id: row.vehicle_id,
            make: row.make,
            model: row.model,
            year: row.year,
            color: row.color,
            license_plate: row.license_plate,
            vehicle_type: row.vehicle_type,
            actual_capacity: row.actual_capacity,
            features: row.features,
            insurance_expiry: row.insurance_expiry,
            code: row.code,
          },
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error("Error getting the vehicle details:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // get driver details (including user details) from batch_id
  router.get("/order/:batchId/driver", async (req, res) => {
    try {
      const batchId = req.params.batchId;
      console.log("Batch Id: ", batchId);
      if (!batchId) {
        return res
          .status(400)
          .json({ ok: false, error: "batchId is required" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const result = await resolveDriverDetailsFromOrderBatchedIds(conn, {
          batchId: batchId,
        });

        if (!result) {
          return res.status(404).json({
            ok: false,
            error: `No driver found for batch_id=${batchId}`,
          });
        }

        return res.json({
          ok: true,
          details: result.user_details || null,
          driver_id: result.driver_id,
          rating: result.rating,
          comment: result.comment,
        });
      } finally {
        try {
          conn.release();
        } catch {}
      }
    } catch (err) {
      console.error("Error getting the driver details from batchId:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });
  return router;
}
