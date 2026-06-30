// src/routes/fares.route.js
import { Router } from "express";
import { withConn, qConn } from "../db/mysql.js";

const router = Router();

/**
 * GET /fares/routes?type=inter_city|intra_city
 *
 * Returns all available from/to pairs from the fare tables.
 * Frontend uses this to populate the route picker dropdowns.
 */
router.get("/routes", async (req, res) => {
  const type = String(req.query.type || "").toLowerCase();

  if (!["inter_city", "intra_city"].includes(type)) {
    return res
      .status(400)
      .json({ success: false, message: "type must be inter_city or intra_city" });
  }

  try {
    const rows = await withConn((conn) => {
      if (type === "inter_city") {
        return qConn(
          conn,
          `SELECT from_city AS \`from\`, to_city AS \`to\`
           FROM inter_city_fares
           ORDER BY from_city, to_city`,
          [],
        );
      } else {
        return qConn(
          conn,
          `SELECT from_zone AS \`from\`, to_zone AS \`to\`
           FROM intra_city_fares
           ORDER BY from_zone, to_zone`,
          [],
        );
      }
    });

    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error("[fares/routes]", e);
    return res
      .status(500)
      .json({ success: false, message: e?.message || "Failed to fetch fare routes" });
  }
});

export default router;
