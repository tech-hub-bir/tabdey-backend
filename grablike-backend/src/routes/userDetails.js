// src/routes/driverLookup.js
import express from "express";

/**
 * Mount with:
 *   import makeDriverLookupRouter from "./routes/driverLookup.js";
 *   app.use("/api", makeDriverLookupRouter(mysqlPool));
 */
export default function userDetailsLookUp(mysqlPool) {
  const router = express.Router();

  // GET /api/user_id?userId=123
  router.get("/user_id", async (req, res) => {
    try {
      const raw = req.query.userId;
      const userId = Number(raw);

      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, error: "Valid userId is required" });
      }

      const conn = await mysqlPool.getConnection();
      try {
        const [[row]] = await conn.query(
          "SELECT * FROM users WHERE user_id = ? LIMIT 1",
          [userId]
        );

        if (!row) {
          return res.status(404).json({
            ok: false,
            error: `No driver found for user_id=${userId}`,
          });
        }

        return res.json({
          ok: true,
          details: row,
        });
      } finally {
        try { conn.release(); } catch {}
      }
    } catch (err) {
      console.error("[GET /api/driver-id] error:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  });

  return router;
}
