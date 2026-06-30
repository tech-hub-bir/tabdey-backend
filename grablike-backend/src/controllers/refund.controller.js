// src/controllers/refund.controller.js
import { withConn } from "../db/mysql.js";
import { getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

export async function refundRide(req, res) {
  const { ride_id, reason = "ADMIN_REFUND" } = req.body;

  if (!ride_id) {
    return res.status(400).json({ ok: false, error: "ride_id required" });
  }

  try {
    await withConn(async (conn) => {
      await conn.beginTransaction();

      const [[pricing]] = await conn.query(
        `
        SELECT *
        FROM ride_pricing_snapshots
        WHERE ride_id = ?
        FOR UPDATE
        `,
        [ride_id]
      );

      if (!pricing) {
        throw new Error("Pricing snapshot not found");
      }

      const [[ride]] = await conn.query(
        `SELECT * FROM rides WHERE ride_id = ? FOR UPDATE`,
        [ride_id]
      );

      if (!ride) throw new Error("Ride not found");

      if (ride.status === "refunded") {
        throw new Error("Already refunded");
      }

      // mark ride refunded
      await conn.execute(
        `
        UPDATE rides
        SET status = 'refunded',
            refunded_at = NOW()
        WHERE ride_id = ?
        `,
        [ride_id]
      );

      // mark snapshot refunded (soft)
      await conn.execute(
        `
        UPDATE ride_pricing_snapshots
        SET refunded_at = NOW()
        WHERE ride_id = ?
        `,
        [ride_id]
      );

      await conn.commit();

      return {
        passenger_id: ride.passenger_id,
        platform_fee_refund_nu: pricing.platform_fee_cents / 100,
        gst_refund_nu: pricing.gst_cents / 100,
        reason,
      };
    });

    // Push to passenger about the refund
    if (result?.passenger_id) {
      const refundNu = ((result.platform_fee_refund_nu || 0) + (result.gst_refund_nu || 0)).toFixed(2);
      getPushTokensByUserIds([result.passenger_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Ride Refunded",
            body: `Your ride #${ride_id} has been refunded. Nu ${refundNu} will be returned to your account.`,
            data: { type: "ride_refunded", ride_id: String(ride_id) },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    res.json({ ok: true, ride_id, refunded: true });
  } catch (e) {
    console.error("[refundRide]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
