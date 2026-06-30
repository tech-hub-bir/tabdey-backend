import express from "express";
import { withConn } from "../db/mysql.js";
import { computeFareCents } from "../utils/fare.js";
import { getPushTokensByUserIds, getPushTokensByDriverIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";
import { creditReferral } from "./referralRoutes.js";

export const ridesRouter = express.Router();


// Accept a ride
ridesRouter.post("/driver/ride/:id/accept", async (req, res) => {
  const { id } = req.params;
  const { driver_id } = req.body || {};
  if (!driver_id) return res.status(400).json({ message: "driver_id required" });

  try {
    const result = await withConn(async (conn) => {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM rides WHERE ride_id=? FOR UPDATE", [id]);
      const ride = rows[0];
      if (!ride) {
        await conn.rollback();
        return { status: 404, body: { message: "Ride not found" } };
      }
      const expired = ride.offer_expire_at && new Date(ride.offer_expire_at) < new Date();
      const canAccept = (ride.status === "offered_to_driver" || ride.status === "requested") &&
                        (!ride.offer_driver_id || Number(ride.offer_driver_id) === Number(driver_id)) &&
                        !expired;
      if (!canAccept && ride.status !== "accepted") {
        await conn.rollback();
        return { status: 409, body: { message: "Ride already taken or not offered to this driver" } };
      }
      if (ride.status !== "accepted") {
        await conn.query(
          "UPDATE rides SET status='accepted', accepted_at=UTC_TIMESTAMP(), driver_id=? WHERE ride_id=?",
          [driver_id, id]
        );
      }
      await conn.commit();
      return { status: 200, body: { ok: true }, passenger_id: ride.passenger_id };
    });

    if (result.status === 200 && result.passenger_id) {
      getPushTokensByUserIds([result.passenger_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Driver Accepted",
            body: "Your driver is on the way to pick you up.",
            data: { type: "ride_accepted", ride_id: id, driver_id: String(driver_id) },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Arrived at pickup
ridesRouter.post("/driver/ride/:id/arrived", async (req, res) => {
  const { id } = req.params;
  try {
    const passenger_id = await withConn(async (conn) => {
      const [upd] = await conn.query(
        "UPDATE rides SET status='arrived_pickup', arrived_pickup_at=UTC_TIMESTAMP() WHERE ride_id=? AND status IN ('accepted','arrived_pickup')",
        [id]
      );
      if (upd.affectedRows > 0) {
        const [[ride]] = await conn.query("SELECT passenger_id FROM rides WHERE ride_id=?", [id]);
        return ride?.passenger_id ?? null;
      }
      return null;
    });

    if (passenger_id) {
      getPushTokensByUserIds([passenger_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Driver Arrived",
            body: "Your driver has arrived at the pickup point.",
            data: { type: "driver_arrived", ride_id: id },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

// Start trip
ridesRouter.post("/driver/ride/:id/start", async (req, res) => {
  const { id } = req.params;
  try {
    const passenger_id = await withConn(async (conn) => {
      const [upd] = await conn.query(
        "UPDATE rides SET status='started', started_at=UTC_TIMESTAMP() WHERE ride_id=? AND status IN ('arrived_pickup','started')",
        [id]
      );
      if (upd.affectedRows > 0) {
        const [[ride]] = await conn.query("SELECT passenger_id FROM rides WHERE ride_id=?", [id]);
        return ride?.passenger_id ?? null;
      }
      return null;
    });

    if (passenger_id) {
      getPushTokensByUserIds([passenger_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Trip Started",
            body: "Your trip is underway. Hang tight!",
            data: { type: "trip_started", ride_id: id },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});

// Complete trip (compute a dummy fare and upsert earnings)
ridesRouter.post("/driver/ride/:id/complete", async (req, res) => {
  const { id } = req.params;
  let driverIdForPush, passengerIdForPush, earningsCentsForPush;
  try {
    await withConn(async (conn) => {
      await conn.beginTransaction();
      const [rows] = await conn.query("SELECT * FROM rides WHERE ride_id=? FOR UPDATE", [id]);
      const ride = rows[0];
      if (!ride) {
        await conn.rollback();
        return res.status(404).json({ message: "Ride not found" });
      }
      const cents = computeFareCents({
        distance_m: ride.distance_m || 3000,
        duration_s: ride.duration_s || 600
      });
      await conn.query(
        "UPDATE rides SET status='completed', completed_at=UTC_TIMESTAMP() WHERE ride_id=?",
        [id]
      );
      const upsert = `INSERT INTO ride_earnings
        (ride_id, base_cents, distance_cents, time_cents, surge_cents, tolls_cents, tips_cents, other_adj_cents, platform_fee_cents, tax_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          base_cents=VALUES(base_cents),
          distance_cents=VALUES(distance_cents),
          time_cents=VALUES(time_cents),
          surge_cents=VALUES(surge_cents),
          tolls_cents=VALUES(tolls_cents),
          tips_cents=VALUES(tips_cents),
          other_adj_cents=VALUES(other_adj_cents),
          platform_fee_cents=VALUES(platform_fee_cents),
          tax_cents=VALUES(tax_cents)`;
      await conn.query(upsert, [
        id,
        cents.base_cents, cents.distance_cents, cents.time_cents,
        cents.surge_cents, cents.tolls_cents, cents.tips_cents,
        cents.other_adj_cents, cents.platform_fee_cents, cents.tax_cents
      ]);
      await conn.commit();
      driverIdForPush = ride.driver_id;
      passengerIdForPush = ride.passenger_id;
      earningsCentsForPush = cents;

      // Credit referral if this is the passenger's first completed ride.
      // Uses the same connection (already committed), never throws.
      if (ride.passenger_id) {
        await creditReferral(conn, ride.passenger_id);
      }
    });

    if (passengerIdForPush) {
      getPushTokensByUserIds([passengerIdForPush]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "You've Arrived",
            body: "Your trip has been completed. Thank you for riding!",
            data: { type: "trip_completed", ride_id: id },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    if (driverIdForPush) {
      const driverEarned = earningsCentsForPush
        ? ((earningsCentsForPush.base_cents + earningsCentsForPush.distance_cents + earningsCentsForPush.time_cents) / 100).toFixed(2)
        : "0.00";
      getPushTokensByDriverIds([driverIdForPush]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Trip Completed",
            body: `Trip complete! You earned Nu ${driverEarned}.`,
            data: { type: "trip_completed", ride_id: id },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Server error" });
  }
});



