// src/routes/driverLookup.js
import express from "express";
import { resolveDriverDetailsFromOrderBatchedIds } from "../utils/resolveDriverId.js";
/**
 * Mount with:
 *   import makeCustomerLookupRouter from "./routes/customerLookup.js";
 *   app.use("/api", makeCustomerLookupRouter(mysqlPool));
 */
export default function makeCustomerLookupRouter(mysqlPool) {
  const router = express.Router();

  // GET customer details using userId /api/user_id?userId=12
  router.get("/user_id", async (req, res) => {
   try {
      const raw = req.query.userId;
      const userId = Number(raw);
      console.log("User Id: ", userId);

      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, error: "Valid userId is required" });
      }
      
      const conn = await mysqlPool.getConnection();
      try {
        const [[userDetails]] = await conn.query(
         "SELECT * FROM users WHERE user_id = ? LIMIT 1",
          [userId]
        );

        return res.json({
          ok: true,
          details: userDetails || null,
        });
      } finally {
        try { conn.release(); } catch {}
      }
    } catch (err) {
      console.error("[GET /api/user_id] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  // get user details from user table using merchant id /api/merchant_id?merchantId=12
  router.get("/merchant_id", async (req, res) => {
   try {
      const raw = req.query.merchantId;
      const merchantId = Number(raw);
      console.log("Merchant Id: ", merchantId);

      if (!Number.isFinite(merchantId) || merchantId <= 0) {
        return res.status(400).json({ ok: false, error: "Valid merchantId is required" });
      }
      
      const conn = await mysqlPool.getConnection();
      try {
        const [[merchantUserId]] = await conn.query(
         "SELECT user_id FROM merchant_business_details WHERE business_id = ? LIMIT 1",
          [merchantId]
        );

        // get user details from users table
        const [[merchantDetails]] = await conn.query(
          "SELECT * FROM users WHERE user_id = ? LIMIT 1",
          [merchantUserId?.user_id]
        ); 
        return res.json({
          ok: true,
          details: merchantDetails || null,
        });
      } finally {
        try { conn.release(); } catch {}
      }
    } catch (err) {
      console.error("[GET /api/merchant_id] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  
  return router;
}
