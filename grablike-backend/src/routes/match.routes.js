import express from "express";
import matcher from "../matching/matcher.js";

const router = express.Router();

/**
 * Driver accepts current offer
 * POST /rides/match/accept
 * body: { rideId, driverId }
 */
router.post("/accept", async (req, res) => {
  try {
    const { rideId, driverId } = req.body || {};
    if (!rideId || !driverId)
      return res.status(400).json({ ok: false, message: "rideId & driverId required" });

    const out = await matcher.acceptOffer({
      io: req.app.locals.io,
      rideId: String(rideId),
      driverId: String(driverId),
    });

    if (!out.ok) return res.status(409).json(out);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[accept] error:", e);
    res.status(500).json({ ok: false, message: e?.message || "server error" });
  }
});

/**
 * Driver rejects current offer
 * POST /rides/match/reject
 * body: { rideId, driverId }
 */
router.post("/reject", async (req, res) => {
  try {
    const { rideId, driverId } = req.body || {};
    if (!rideId || !driverId)
      return res.status(400).json({ ok: false, message: "rideId & driverId required" });

    const out = await matcher.rejectOffer({
      io: req.app.locals.io,
      rideId: String(rideId),
      driverId: String(driverId),
    });

    return res.json(out);
  } catch (e) {
    console.error("[reject] error:", e);
    res.status(500).json({ ok: false, message: e?.message || "server error" });
  }
});

export default router;
