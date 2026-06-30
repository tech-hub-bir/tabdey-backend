// src/routes/matching.js (ESM)
import express from "express";
import matcher from "../matching/matcher.js";
import {
  driverHash,
  rideHash,
  currentPassengerRideKey,
  currentRidesKey,
} from "../matching/redisKeys.js";
import { getRedis } from "../matching/redis.js";
import { applyCancellationPolicy } from "../services/cancellations.js";
import { walletTransfer } from "../services/wallet/walletTransfer.js";
import {
  BOOKING_TYPE,
  TRIP_TYPE,
  VALID_TRIP_TYPES,
  VALID_BOOKING_TYPES,
} from "../constants/rideTypes.js";

const redis = getRedis();

const driverRoom = (driverId) => `driver:${driverId}`;
const passengerRoom = (passengerId) => `passenger:${passengerId}`;
const rideRoom = (rideId) => `ride:${rideId}`;

export function makeMatchingRouter(io, mysqlPool) {
  const router = express.Router();

  // Supports INSTANT + SCHEDULED bookings + POOL + WAYPOINTS
  router.post("/request", async (req, res) => {
    try {
      console.log(
        "[/rides/match/request] req.body:",
        JSON.stringify(req.body, null, 2),
      );
    } catch {}

    const {
      passenger_id,

      // city + service
      cityId: cityIdRaw = "thimphu",
      serviceType,
      service_code,

      // geo
      pickup,
      dropoff,
      pickup_place,
      dropoff_place,
      distance_m,
      duration_s,

      // ✅ new payload pricing fields from frontend
      subtotal_fare: subtotalFareRaw, // Nu (e.g. 129.51)
      total_fare: totalFareRaw, // Nu (e.g. 171.51)
      platform_fee: platformFeeRaw, // Nu
      gst: gstRaw, // Nu
      platform_fee_rule_id: platformFeeRuleIdRaw,

      // legacy / fallback
      base_fare: baseFareUnitsRaw, // Nu
      fare: fareRaw, // Nu
      fare_cents: fareCentsRaw, // cents

      trip_type: tripTypeRaw = "instant",
      pool_batch_id: poolBatchRaw = null,
      currency: currencyRaw = "BTN",
      payment_method: payment_method,
      offer_code = null,
      seats: seatsRaw = 1,

      // waypoints
      waypoints: waypointsRaw = [],

      // optional
      merchant_id = null,

      // scheduling
      booking_type: bookingTypeRaw = "INSTANT", // INSTANT | SCHEDULED
      scheduled_at: scheduledAtRaw = null,

      // preferred driver (from DriversNearby screen)
      preferred_driver_id: preferredDriverIdRaw = null,

      // airport / flight metadata (optional, from FlightArrival flow)
      flight_number: flightNumberRaw = null,
      airport_code: airportCodeRaw = null,
      airport_name: airportNameRaw = null,

      // fare negotiation — passenger's self-set offer price (optional)
      offered_fare_cents: offeredFareCentsRaw = null,
      // minimum fare floor for this ride type (from vehicle config)
      min_fare_cents: minFareCentsRaw = null,
    } = req.body || {};

    /* -------------------- basic validation -------------------- */
    if (!passenger_id) {
      return res.status(400).json({ error: "passenger_id is required" });
    }

    if (
      !Array.isArray(pickup) ||
      pickup.length !== 2 ||
      isNaN(pickup[0]) ||
      isNaN(pickup[1])
    ) {
      return res.status(400).json({ error: "pickup must be [lat, lng]" });
    }

    if (
      !Array.isArray(dropoff) ||
      dropoff.length !== 2 ||
      isNaN(dropoff[0]) ||
      isNaN(dropoff[1])
    ) {
      return res.status(400).json({ error: "dropoff must be [lat, lng]" });
    }

    if (!service_code || String(service_code).trim().length === 0) {
      return res.status(400).json({ error: "service_code is required" });
    }

    /* -------------------- normalize city -------------------- */
    // keep your system consistent (redis geoKey, DB, etc.)
    const cityId = String(cityIdRaw || "thimphu").trim();

    /* -------------------- normalize booking_type & trip_type -------------------- */
    const normalizedBookingType = String(bookingTypeRaw || "").toUpperCase();
    const booking_type = VALID_BOOKING_TYPES.includes(normalizedBookingType)
      ? normalizedBookingType
      : BOOKING_TYPE.INSTANT;

    const trip_type = (() => {
      const direct = String(tripTypeRaw ?? "")
        .trim()
        .toLowerCase();
      if (VALID_TRIP_TYPES.includes(direct)) return direct;

      // fallback from booking_type
      if (booking_type === BOOKING_TYPE.SCHEDULED) return TRIP_TYPE.SCHEDULED;
      if (booking_type === BOOKING_TYPE.GROUP) return TRIP_TYPE.GROUP;
      return TRIP_TYPE.INSTANT;
    })();

    let scheduled_at = null; // JS Date or null
    if (booking_type === "SCHEDULED") {
      if (!scheduledAtRaw) {
        return res
          .status(400)
          .json({ error: "scheduled_at is required for scheduled booking" });
      }

      const d = new Date(scheduledAtRaw);
      if (isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ error: "scheduled_at must be a valid datetime" });
      }

      // must be at least 2 mins in future
      if (d.getTime() < Date.now() + 2 * 60 * 1000) {
        return res.status(400).json({
          error: "scheduled_at must be at least 2 minutes from now",
        });
      }

      scheduled_at = d;
    }

    /* -------------------- normalize numbers -------------------- */
    const distInt = Number.isFinite(Number(distance_m))
      ? Math.max(0, Math.trunc(Number(distance_m)))
      : null;

    const durInt = Number.isFinite(Number(duration_s))
      ? Math.max(0, Math.trunc(Number(duration_s)))
      : null;

    const currency = (currencyRaw || "BTN")
      .toString()
      .slice(0, 8)
      .toUpperCase();

    const seats = Number.isFinite(Number(seatsRaw))
      ? Math.max(1, Math.trunc(Number(seatsRaw)))
      : 1;

    const toCents = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    };

    // ✅ Prefer new payload amounts
    const subtotalFareCents = toCents(subtotalFareRaw);
    const totalFareCents = toCents(totalFareRaw);
    const platformFeeCents = toCents(platformFeeRaw);
    const gstCents = toCents(gstRaw);

    // Legacy fallbacks
    const legacyFareUnits = Number.isFinite(Number(fareRaw))
      ? Number(fareRaw)
      : Number.isFinite(Number(baseFareUnitsRaw))
        ? Number(baseFareUnitsRaw)
        : null;

    const legacyFareCents = Number.isFinite(Number(fareCentsRaw))
      ? Number(fareCentsRaw)
      : null;

    /**
     * ✅ DB mapping:
     *   rides.base_fare_cents = subtotal (before fees/tax)
     *   rides.fare_cents      = total payable
     *
     * If frontend doesn't send new fields, fallback to legacy behaviour.
     */
    const base_fare_cents =
      subtotalFareCents != null
        ? subtotalFareCents
        : legacyFareCents != null
          ? legacyFareCents
          : legacyFareUnits != null
            ? Math.round(legacyFareUnits * 100)
            : null;

    const fare_cents =
      totalFareCents != null
        ? totalFareCents
        : legacyFareCents != null
          ? legacyFareCents
          : legacyFareUnits != null
            ? Math.round(legacyFareUnits * 100)
            : null;

    // If you require totals to exist (recommended)
    if (fare_cents == null) {
      return res.status(400).json({
        error:
          "total_fare (preferred) or fare/fare_cents is required to request a ride",
      });
    }

    // optional sanity check
    if (base_fare_cents != null && fare_cents < base_fare_cents) {
      return res.status(400).json({
        error: "total_fare cannot be less than subtotal_fare",
      });
    }

    // keep units version for matcher + payloads (driver UI)
    const fareUnits = fare_cents / 100;
    const baseFareUnits =
      base_fare_cents != null ? base_fare_cents / 100 : null;

    // minimum fare floor for this ride type
    const min_fare_cents = (() => {
      const n = Number(minFareCentsRaw);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 5000; // default Nu 50
    })();

    // passenger's negotiated offer — must be positive, above floor, and below system fare
    const offered_fare_cents = (() => {
      const n = Number(offeredFareCentsRaw);
      if (!Number.isFinite(n) || n <= 0) return null;
      const cents = Math.round(n);
      if (cents < min_fare_cents) return null; // below ride-type floor, ignore
      return cents < fare_cents ? cents : null; // only honour if genuinely lower
    })();

    const platform_fee_rule_id = Number.isFinite(Number(platformFeeRuleIdRaw))
      ? Number(platformFeeRuleIdRaw)
      : null;

    const preferred_driver_id =
      preferredDriverIdRaw != null && String(preferredDriverIdRaw).trim() !== ""
        ? String(preferredDriverIdRaw).trim()
        : null;

    const flight_number =
      flightNumberRaw != null && String(flightNumberRaw).trim() !== ""
        ? String(flightNumberRaw).trim().slice(0, 20)
        : null;
    const airport_code =
      airportCodeRaw != null && String(airportCodeRaw).trim() !== ""
        ? String(airportCodeRaw).trim().slice(0, 10).toUpperCase()
        : null;
    const airport_name =
      airportNameRaw != null && String(airportNameRaw).trim() !== ""
        ? String(airportNameRaw).trim().slice(0, 100)
        : null;

    /* -------------------- waypoints normalize -------------------- */
    const MAX_WPS = 5;
    let waypoints = [];
    try {
      if (waypointsRaw != null) {
        if (!Array.isArray(waypointsRaw)) {
          return res
            .status(400)
            .json({ error: "waypoints must be an array if provided" });
        }

        if (waypointsRaw.length > MAX_WPS) {
          return res.status(400).json({
            error: `Too many waypoints: maximum ${MAX_WPS} allowed, got ${waypointsRaw.length}`,
          });
        }

        waypoints = waypointsRaw
          .slice(0, MAX_WPS)
          .map((w, i) => {
            const lat = Number(w?.lat ?? w?.latitude);
            const lng = Number(w?.lng ?? w?.longitude);
            const addr = (w?.address ?? "").toString().trim();
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return { order_index: i, lat, lng, address: addr || null };
          })
          .filter(Boolean);
      }
    } catch {
      waypoints = [];
    }

    let conn;
    try {
      conn = await mysqlPool.getConnection();

      /* -------------------- validate service_code exists -------------------- */
      const [[rideTypeRow]] = await conn.query(
        `SELECT id FROM ride_types WHERE code = ? AND is_active = 1 LIMIT 1`,
        [String(service_code).trim()],
      );
      if (!rideTypeRow) {
        conn.release();
        conn = null;
        return res.status(400).json({
          error: `Unknown or inactive service_code: "${service_code}". Check /api/get-ride-types for valid codes.`,
        });
      }

      await conn.beginTransaction();

      /* -------------------- pool_batch_id handling -------------------- */
      let pool_batch_id = null;
      if (trip_type === "pool") {
        const numericProvided = Number(poolBatchRaw);
        if (Number.isFinite(numericProvided) && numericProvided > 0) {
          pool_batch_id = numericProvided;
        } else {
          const [pbIns] = await conn.execute(
            `INSERT INTO pool_batches (city_id, service_type, status, created_at)
           VALUES (?, ?, 'forming', NOW())`,
            [cityId, serviceType || service_code],
          );
          pool_batch_id = Number(pbIns.insertId);
        }
      }

      /* -------------------- initial ride status -------------------- */
      // scheduled rides stay in 'scheduled' state until the worker dispatches them
      const initialStatus =
        booking_type === BOOKING_TYPE.SCHEDULED ? "scheduled" : "requested";

      /* -------------------- insert ride shell -------------------- */
      // NOTE: requires rides table to have booking_type + scheduled_at + base_fare_cents columns
      const [ins] = await conn.execute(
        `
      INSERT INTO rides (
        passenger_id, service_type, status, requested_at,
        pickup_place, dropoff_place,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        distance_m, duration_s, currency,
        trip_type, pool_batch_id,
        fare_cents, base_fare_cents,
        booking_type, scheduled_at, payment_method,
        flight_number, airport_code, airport_name
      ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          passenger_id,
          serviceType || service_code,
          initialStatus,
          pickup_place ?? null,
          dropoff_place ?? null,
          Number(pickup[0]),
          Number(pickup[1]),
          Number(dropoff[0]),
          Number(dropoff[1]),
          distInt,
          durInt,
          currency,
          trip_type,
          pool_batch_id,
          fare_cents,
          base_fare_cents ?? null,
          booking_type,
          scheduled_at ? new Date(scheduled_at) : null,
          payment_method,
          flight_number,
          airport_code,
          airport_name,
        ],
      );

      const rideId = String(ins.insertId);

      // GROUP ride: create host participant row (required for invites)
      if (booking_type === BOOKING_TYPE.GROUP) {
        await conn.execute(
          `
          INSERT INTO ride_participants (ride_id, user_id, role, seats, join_status)
          VALUES (?, ?, 'host', ?, 'joined')
          ON DUPLICATE KEY UPDATE
            role='host',
            join_status='joined',
            seats=VALUES(seats),
            updated_at=NOW()
          `,
          [rideId, passenger_id, seats], // seats = host seats (usually 1)
        );
      }

      let bookingId = null;

      /* -------------------- persist waypoints -------------------- */
      if (waypoints.length) {
        const values = waypoints.map((w) => [
          rideId,
          w.order_index,
          w.lat,
          w.lng,
          w.address,
        ]);

        await conn.query(
          `INSERT INTO ride_waypoints (ride_id, order_index, lat, lng, address)
         VALUES ?`,
          [values],
        );
      }

      /* -------------------- pool / group bookings row -------------------- */
      if (trip_type === "pool" || booking_type === BOOKING_TYPE.GROUP) {
        const [insBk] = await conn.execute(
          `
        INSERT INTO ride_bookings (
          ride_id, passenger_id, seats, status, requested_at,
          pickup_place, dropoff_place, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          fare_cents, currency
        )
        VALUES (?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            rideId,
            passenger_id,
            seats,
            initialStatus, // ✅ keep consistent (scheduled vs requested)
            pickup_place ?? null,
            dropoff_place ?? null,
            Number(pickup[0]),
            Number(pickup[1]),
            Number(dropoff[0]),
            Number(dropoff[1]),
            fare_cents ?? 0,
            currency,
          ],
        );
        bookingId = String(insBk.insertId);
      }

      await conn.commit();

      /* -------------------- if SCHEDULED: return now, DO NOT MATCH -------------------- */
      if (booking_type === BOOKING_TYPE.SCHEDULED) {
        return res.json({
          ok: true,
          rideId,
          bookingId,
          trip_type,
          pool_batch_id,
          booking_type,
          scheduled_at: scheduled_at ? scheduled_at.toISOString() : null,
          status: "scheduled",
        });
      }

      /* -------------------- INSTANT: kick off matcher -------------------- */
      await matcher.requestRide({
        io,
        cityId,
        service_code,
        serviceType: serviceType || service_code,
        pickup,
        dropoff,
        pickup_place,
        dropoff_place,
        distance_m: distInt,
        duration_s: durInt,

        // ✅ align meaning
        fare: fareUnits, // total payable in units
        fare_cents: fare_cents, // total payable in cents
        base_fare: baseFareUnits, // subtotal in units (legacy param name)
        offered_fare_cents, // passenger's negotiated offer (null if not set)
        min_fare_cents,     // ride-type minimum floor

        rideId,
        passenger_id: String(passenger_id),
        trip_type,
        pool_batch_id,
        booking_id: bookingId || null,
        seats,

        payment_method,
        offer_code,

        waypoints: waypoints.map((w) => ({
          lat: w.lat,
          lng: w.lng,
          address: w.address,
        })),

        merchant_id,

        // (kept as passthrough in your earlier route)
        booking_type,
        scheduled_at: scheduled_at ? scheduled_at.toISOString() : null,

        // optional extra meta (doesn't affect matcher logic if ignored elsewhere)
        platform_fee_rule_id,
        platform_fee_cents: platformFeeCents,
        gst_cents: gstCents,

        preferred_driver_id,

        // flight / airport metadata
        flight_number,
        airport_code,
        airport_name,
      });

      return res.json({
        ok: true,
        rideId,
        bookingId,
        trip_type,
        pool_batch_id,
        booking_type,
        payment_method,
        scheduled_at: scheduled_at ? scheduled_at.toISOString() : null,
        status: "requested",
      });
    } catch (e) {
      try {
        await conn?.rollback();
      } catch {}
      console.error("[/rides/match/request] error:", e);
      return res.status(500).json({ error: "Server error" });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  // ------------------------ POST /cancel ------------------------
  // body: { rideId, by: 'passenger'|'driver'|'system', reason? }
  router.post("/cancel", async (req, res) => {
    const { rideId, by, reason } = req.body || {};
    const ride_id = Number(rideId);

    if (!ride_id || !Number.isFinite(ride_id)) {
      return res.status(400).json({ ok: false, error: "rideId is required" });
    }

    const cancelled_by =
      by === "passenger" || by === "driver" || by === "system" ? by : "system";

    const now = new Date();

    let conn;
    try {
      conn = await mysqlPool.getConnection();
      await conn.beginTransaction();

      // 1) Lock the ride row
      const [rows] = await conn.query(
        `SELECT *
         FROM rides
        WHERE ride_id = ?
        FOR UPDATE`,
        [ride_id],
      );

      if (!rows || !rows.length) {
        await conn.rollback();
        return res.status(404).json({ ok: false, error: "ride_not_found" });
      }

      const ride = rows[0];
      const prevStatus = String(ride.status || "").toLowerCase();

      const ACTIVE_STATES = [
        "requested",
        "offered_to_driver",
        "accepted",
        "arrived_pickup",
        "started",
      ];
      if (!ACTIVE_STATES.includes(prevStatus)) {
        await conn.rollback();
        return res
          .status(400)
          .json({ ok: false, error: "ride_already_finished" });
      }

      // 2) Decide new status
      let newStatus = "cancelled_system";
      if (cancelled_by === "passenger") newStatus = "cancelled_rider";
      else if (cancelled_by === "driver") newStatus = "cancelled_driver";

      // -----------------------------------------------------------------
      // 3) CANCELLATION POLICY – FETCH RULES FROM DATABASE
      // -----------------------------------------------------------------
      let policy = {
        applied: false,
        stage: null,
        rule_id: null,
        fee_cents: 0,
        driver_share_cents: 0,
        platform_share_cents: 0,
        estimated_fare_cents: ride.fare_cents || 0,
      };

      const estimated_fare_cents = ride.fare_cents || 0;

      // ----- Passenger Cancellation -----
      if (cancelled_by === "passenger") {
        // First, check if there's a free cancellation rule for this status
        const [freeRules] = await conn.query(
          `SELECT * FROM cancellation_rules
         WHERE cancelled_by = ?
           AND ride_status = ?
           AND is_free = TRUE`,
          [cancelled_by, prevStatus],
        );

        let isFreeCancellation = false;
        if (freeRules.length > 0 && ride.accepted_at) {
          const acceptedAt = new Date(ride.accepted_at);
          const diffMinutes =
            (now.getTime() - acceptedAt.getTime()) / 1000 / 60;
          if (diffMinutes <= freeRules[0].grace_minutes) {
            isFreeCancellation = true;
            policy.applied = true;
            policy.stage = freeRules[0].stage;
            policy.rule_id = freeRules[0].rule_id;
            // fee_cents remains 0, no transfer
          }
        }

        // If not free, and we're in a fee‑eligible status, fetch the appropriate fee rule
        if (
          !isFreeCancellation &&
          (prevStatus === "accepted" || prevStatus === "arrived_pickup")
        ) {
          const stage =
            prevStatus === "arrived_pickup" ? "no_show" : "late_cancel";

          const [ruleRows] = await conn.query(
            `SELECT * FROM cancellation_rules
           WHERE cancelled_by = ?
             AND ride_status = ?
             AND stage = ?`,
            [cancelled_by, prevStatus, stage],
          );

          if (ruleRows.length === 0) {
            console.warn(`[/rides/match/cancel] no rule for ${cancelled_by}/${prevStatus}/${stage} — skipping fee`);
          } else {
          const rule = ruleRows[0];
          let fee_cents = Math.round(
            estimated_fare_cents * (rule.fee_percent / 100),
          );
          fee_cents = Math.min(
            Math.max(fee_cents, rule.min_fee_cents),
            rule.max_fee_cents,
          );

          policy.applied = true;
          policy.stage = rule.stage;
          policy.rule_id = rule.rule_id;
          policy.fee_cents = fee_cents;
          policy.driver_share_cents = fee_cents; // 100% to driver
          policy.platform_share_cents = 0;

          // ----- Transfer passenger -> driver using walletTransfer -----
          if (fee_cents > 0 && ride.driver_id) {
            try {
              const [passengerWalletRows] = await conn.query(
                `SELECT wallet_id FROM wallets WHERE user_id = ?`,
                [ride.passenger_id],
              );
              const [driverUserRows] = await conn.query(
                `SELECT user_id FROM drivers WHERE driver_id = ?`,
                [ride.driver_id],
              );
              const driverUserId = driverUserRows?.[0]?.user_id;
              const [driverWalletRows] = driverUserId
                ? await conn.query(`SELECT wallet_id FROM wallets WHERE user_id = ?`, [driverUserId])
                : [[]];

              if (passengerWalletRows?.length && driverWalletRows?.length) {
                const fee_nu = fee_cents / 100;
                const transferResult = await walletTransfer(conn, {
                  from_wallet: passengerWalletRows[0].wallet_id,
                  to_wallet: driverWalletRows[0].wallet_id,
                  driver_credit_nu: fee_nu,
                  passenger_debit_nu: fee_nu,
                  reason: "cancellation_fee",
                  meta: { ride_id, stage: policy.stage, cancelled_by },
                });
                if (transferResult.ok) {
                  policy.transaction_id_dr = transferResult.transaction_id_dr;
                  policy.transaction_id_cr = transferResult.transaction_id_cr;
                } else {
                  console.warn("[/rides/match/cancel] cancellation fee transfer skipped:", transferResult.reason);
                  policy.fee_transfer_skipped = true;
                }
              } else {
                console.warn("[/rides/match/cancel] wallet not found — skipping fee transfer. passenger:", !!passengerWalletRows?.length, "driver:", !!driverWalletRows?.length);
                policy.fee_transfer_skipped = true;
              }
            } catch (walletErr) {
              console.warn("[/rides/match/cancel] wallet transfer error (non-fatal):", walletErr?.message);
              policy.fee_transfer_skipped = true;
            }
          }
        } // end else (rule found)
        } // end if (!isFreeCancellation)
      }

      // ----- Driver Cancellation (unjustified) -----
      else if (cancelled_by === "driver") {
        // ⚠️ Replace with your business logic to determine "unjustified"
        const isUnjustified = true; // Example: always penalise unless reason is 'safety', etc.

        if (
          isUnjustified &&
          (prevStatus === "accepted" || prevStatus === "arrived_pickup")
        ) {
          const stage =
            prevStatus === "arrived_pickup" ? "driver_no_show" : "unjustified";

          const [ruleRows] = await conn.query(
            `SELECT * FROM cancellation_rules
           WHERE cancelled_by = ?
             AND ride_status = ?
             AND stage = ?`,
            [cancelled_by, prevStatus, stage],
          );

          if (ruleRows.length === 0) {
            throw new Error(
              `No cancellation rule found for ${cancelled_by} / ${prevStatus} / ${stage}`,
            );
          }

          const rule = ruleRows[0];
          let fee_cents = Math.round(
            estimated_fare_cents * (rule.fee_percent / 100),
          );
          fee_cents = Math.min(
            Math.max(fee_cents, rule.min_fee_cents),
            rule.max_fee_cents,
          );

          policy.applied = true;
          policy.stage = rule.stage;
          policy.rule_id = rule.rule_id;
          policy.fee_cents = fee_cents;
          policy.driver_share_cents = 0;
          policy.platform_share_cents = fee_cents;

          // ----- Transfer driver -> system wallet using walletTransfer -----
          if (fee_cents > 0 && ride.driver_id) {
            try {
              const [driverUserRows] = await conn.query(
                `SELECT user_id FROM drivers WHERE driver_id = ?`,
                [ride.driver_id],
              );
              const driverUserId = driverUserRows?.[0]?.user_id;
              const [driverWalletRows] = driverUserId
                ? await conn.query(`SELECT wallet_id FROM wallets WHERE user_id = ?`, [driverUserId])
                : [[]];

              if (driverWalletRows?.length) {
                const SYSTEM_WALLET_ID = "NET000001";
                const fee_nu = fee_cents / 100;
                const transferResult = await walletTransfer(conn, {
                  from_wallet: driverWalletRows[0].wallet_id,
                  to_wallet: SYSTEM_WALLET_ID,
                  driver_credit_nu: fee_nu,
                  passenger_debit_nu: fee_nu,
                  reason: "driver_penalty",
                  meta: { ride_id, stage: policy.stage, cancelled_by },
                });
                if (transferResult.ok) {
                  policy.transaction_id_dr = transferResult.transaction_id_dr;
                  policy.transaction_id_cr = transferResult.transaction_id_cr;
                } else {
                  console.warn("[/rides/match/cancel] driver penalty transfer skipped:", transferResult.reason);
                  policy.fee_transfer_skipped = true;
                }
              } else {
                console.warn("[/rides/match/cancel] driver wallet not found — skipping penalty transfer");
                policy.fee_transfer_skipped = true;
              }
            } catch (walletErr) {
              console.warn("[/rides/match/cancel] driver penalty error (non-fatal):", walletErr?.message);
              policy.fee_transfer_skipped = true;
            }
          }
        }
      }

      // -----------------------------------------------------------------
      // 4) Update ride as cancelled
      // -----------------------------------------------------------------
      await conn.query(
        `UPDATE rides
          SET status        = ?,
              cancelled_at  = ?,
              cancel_reason = ?
        WHERE ride_id       = ?`,
        [newStatus, now, reason || null, ride_id],
      );

      await conn.commit();

      // -----------------------------------------------------------------
      // 5) Clean Redis (non‑critical, outside transaction)
      // -----------------------------------------------------------------
      const driver_id = ride.driver_id ? Number(ride.driver_id) : null;
      const passenger_id = ride.passenger_id ? Number(ride.passenger_id) : null;

      try {
        if (driver_id) {
          const dKey = currentRidesKey(String(driver_id));
          await redis.hdel(dKey, String(ride_id));
        }
      } catch (e) {
        console.error(
          "[/rides/match/cancel] redis.hdel driver current ride error:",
          e?.message || e,
        );
      }

      try {
        if (passenger_id) {
          const pKey = currentPassengerRideKey(String(passenger_id));
          await redis.del(pKey);
        }
      } catch (e) {
        console.error(
          "[/rides/match/cancel] redis.del passenger current ride error:",
          e?.message || e,
        );
      }

      // -----------------------------------------------------------------
      // 6) Emit socket events
      // -----------------------------------------------------------------
      const payload = {
        ride_id,
        request_id: ride_id,
        cancelled_by,
        reason: reason || null,
        policy,
        status: newStatus,
      };

      try {
        if (driver_id) {
          io.to(driverRoom(driver_id))
            .to(rideRoom(ride_id))
            .emit("rideCancelled", payload);
        } else {
          io.to(rideRoom(ride_id)).emit("rideCancelled", payload);
        }

        if (passenger_id) {
          io.to(passengerRoom(passenger_id))
            .to(rideRoom(ride_id))
            .emit("rideCancelled", payload);
        }
      } catch (e) {
        console.error(
          "[/rides/match/cancel] socket emit error:",
          e?.message || e,
        );
      }

      return res.json({
        ok: true,
        ride_id,
        status: newStatus,
        cancelled_by,
        policy,
      });
    } catch (e) {
      if (conn) {
        try {
          await conn.rollback();
        } catch {}
      }
      console.error("[/rides/match/cancel] error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "server_error" });
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch {}
      }
    }
  });

  // ------------------------ POST /cancel-booking (pool seat) ------------------------
  // { rideId, bookingId, by: 'passenger'|'system', reason? }
  router.post("/cancel-booking", async (req, res) => {
    const { rideId, bookingId, by = "passenger", reason = "" } = req.body || {};
    if (!rideId || !bookingId)
      return res.status(400).json({ error: "rideId and bookingId required" });

    let conn;
    try {
      conn = await mysqlPool.getConnection();
      await conn.beginTransaction();

      const [[bk]] = await conn.query(
        `SELECT rb.*, r.status AS ride_status
           FROM ride_bookings rb
           JOIN rides r ON r.ride_id = rb.ride_id
          WHERE rb.booking_id = ? AND rb.ride_id = ?
          FOR UPDATE`,
        [bookingId, rideId],
      );
      if (!bk) {
        await conn.rollback();
        return res.status(404).json({ error: "Booking not found" });
      }

      if (
        [
          "cancelled_passenger",
          "cancelled_system",
          "cancelled_driver",
          "completed",
          "dropped",
        ].includes(bk.status)
      ) {
        await conn.rollback();
        return res.status(400).json({ error: "Booking already finished" });
      }

      const eligibleLateStage =
        bk.ride_status === "accepted" || bk.ride_status === "arrived_pickup";

      await conn.execute(
        `UPDATE ride_bookings
            SET status = ?, cancelled_at = NOW(), cancel_reason = ?
          WHERE booking_id = ?`,
        [
          by === "passenger" ? "cancelled_passenger" : "cancelled_system",
          reason,
          bookingId,
        ],
      );

      let policy = { applied: false };
      if (by === "passenger" && eligibleLateStage) {
        policy = await applyCancellationPolicy({ conn, rideId, bookingId });
      }

      // Optional: if this was the last active booking you may cancel/close the container ride.

      await conn.commit();

      const payload = {
        ok: true,
        rideId: String(rideId),
        bookingId: String(bookingId),
        cancelled_by: by,
        reason,
        policy,
      };

      io.to(`ride:${rideId}`).emit("bookingCancelled", payload);

      // 🔁 Redis: clear this passenger's current ride for pool booking too
      try {
        if (bk?.passenger_id) {
          const pKey = currentPassengerRideKey(bk.passenger_id);
          await redis.del(pKey);
          console.log(
            "[/rides/match/cancel-booking] cleared passenger current ride key:",
            pKey,
          );
        }
      } catch (e) {
        console.warn(
          "[/rides/match/cancel-booking] redis sync warn:",
          e?.message,
        );
      }

      return res.json(payload);
    } catch (e) {
      try {
        await conn?.rollback();
      } catch {}
      console.error("[/rides/match/cancel-booking] error:", e);
      return res.status(500).json({ error: "Server error" });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  // ------------------------ GET /nearbyDrivers (legacy helper) ------------------------
  router.get("/nearbyDrivers", async (req, res) => {
    const { serviceType = "bike", lat, lng, radiusM, count } = req.query;
    if ([lat, lng].some((v) => typeof v === "undefined" || isNaN(Number(v)))) {
      return res
        .status(400)
        .json({ error: "lat and lng are required and must be numbers" });
    }

    try {
      const drivers = await matcher.discoverCandidates({
        cityId: "thimphu",
        serviceType,
        pickup: [Number(lat), Number(lng)],
        steps: radiusM ? [Number(radiusM)] : undefined,
        count: count ? Number(count) : undefined,
      });

      const driverDetails = await Promise.all(
        drivers.map(async (driverId) => {
          const details = await redis.hgetall(driverHash(driverId));
          return { driverId, ...details };
        }),
      );

      return res.json({ drivers: driverDetails });
    } catch (e) {
      console.error("[/rides/match/nearbyDrivers] error:", e);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ------------------------ POST /broadcast-delivery ------------------------
  // Broadcast a delivery-style request to ALL nearby online drivers whose code starts with "D"
  //
  // Body supports two modes:
  //  1) Legacy single-drop:
  //     { passenger_id, merchant_id, pickup, dropoff, ... }
  //
  //  2) Batch delivery:
  //     {
  //       job_type: "BATCH",
  //       batch_id,
  //       drops: [
  //         { order_id, user_id, address, lat, lng, amount, delivery_fee, payment_method, cash_to_collect, ... }
  //       ],
  //       ...same fields...
  //     }
  router.post("/broadcast-delivery", async (req, res) => {
    try {
      console.log(
        "[/rides/match/broadcast-delivery] req.body:",
        JSON.stringify(req.body, null, 2),
      );
    } catch {}

    const {
      passenger_id,
      merchant_id, // merchant to notify when driver accepts
      cityId = "thimphu",
      serviceType,
      service_code = "D",

      pickup,
      dropoff: dropoffRaw,
      pickup_place,
      dropoff_place,

      distance_m,
      duration_s,
      base_fare,
      fare: fareRaw,
      fare_cents: fareCentsRaw,
      currency: currencyRaw = "BTN",
      payment_method = null,
      offer_code = null,

      // optional legacy waypoints
      waypoints: waypointsRaw = [],

      // 👇 NEW for batch/group delivery
      job_type: jobTypeRaw,
      batch_id: batchIdRaw,
      drops: dropsRaw = null,
    } = req.body || {};

    // ---- Basic validation for pickup
    if (!passenger_id)
      return res.status(400).json({ error: "passenger_id is required" });
    if (
      !Array.isArray(pickup) ||
      pickup.length !== 2 ||
      isNaN(pickup[0]) ||
      isNaN(pickup[1])
    ) {
      return res.status(400).json({ error: "pickup must be [lat, lng]" });
    }
    if (!service_code || String(service_code).trim().length === 0) {
      return res.status(400).json({ error: "service_code is required" });
    }

    // ---- Normalize job type
    const job_type =
      String(jobTypeRaw || "")
        .toUpperCase()
        .trim() === "BATCH"
        ? "BATCH"
        : "SINGLE";

    const batch_id =
      job_type === "BATCH" && Number.isFinite(Number(batchIdRaw))
        ? Number(batchIdRaw)
        : null;

    // ---- Normalize numbers
    const distInt = Number.isFinite(Number(distance_m))
      ? Math.max(0, Math.trunc(Number(distance_m)))
      : null;
    const durInt = Number.isFinite(Number(duration_s))
      ? Math.max(0, Math.trunc(Number(duration_s)))
      : null;
    const currency = (currencyRaw || "BTN")
      .toString()
      .slice(0, 8)
      .toUpperCase();

    // fare passthrough
    const fareUnits = Number.isFinite(Number(fareRaw))
      ? Number(fareRaw)
      : Number.isFinite(Number(base_fare))
        ? Number(base_fare)
        : null;

    const fareCents = Number.isFinite(Number(fareCentsRaw))
      ? Number(fareCentsRaw)
      : fareUnits != null
        ? Math.round(fareUnits * 100)
        : null;

    // ---- Normalize drops (for BATCH jobs)
    let drops = [];
    if (job_type === "BATCH") {
      if (!Array.isArray(dropsRaw) || !dropsRaw.length) {
        return res
          .status(400)
          .json({ error: "drops[] is required for BATCH job_type" });
      }

      drops = dropsRaw
        .map((d, idx) => {
          const lat = Number(d.lat ?? d.latitude);
          const lng = Number(d.lng ?? d.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

          return {
            stop_index: idx,
            order_id: d.order_id ?? null,
            user_id: d.user_id ?? null,
            address: (d.address ?? "").toString().trim() || null,
            lat,
            lng,
            customer_name: d.customer_name ?? null,
            customer_phone: d.customer_phone ?? null,
            amount: Number(d.amount ?? 0),
            delivery_fee: Number(d.delivery_fee ?? 0),
            platform_fee: Number(d.platform_fee ?? 0),
            merchant_delivery_fee: Number(d.merchant_delivery_fee ?? 0),
            payment_method: d.payment_method ?? null,
            cash_to_collect: Number(d.cash_to_collect ?? 0),
          };
        })
        .filter(Boolean);

      if (!drops.length) {
        return res
          .status(400)
          .json({ error: "At least one valid drop with lat/lng is required" });
      }
    }

    // ---- Determine primary dropoff + waypoints
    let dropoff = dropoffRaw;
    let waypoints = [];

    if (job_type === "BATCH" && drops.length) {
      const first = drops[0];
      dropoff = [first.lat, first.lng];

      // Remaining stops → waypoints, in order
      waypoints = drops.slice(1).map((d, i) => ({
        order_index: i,
        lat: d.lat,
        lng: d.lng,
        address: d.address,
      }));
    } else {
      // Legacy behaviour: use provided dropoff + waypointsRaw
      if (
        !Array.isArray(dropoffRaw) ||
        dropoffRaw.length !== 2 ||
        isNaN(dropoffRaw[0]) ||
        isNaN(dropoffRaw[1])
      ) {
        return res.status(400).json({ error: "dropoff must be [lat, lng]" });
      }

      const MAX_WPS = 5;
      try {
        if (waypointsRaw != null) {
          if (!Array.isArray(waypointsRaw)) {
            return res
              .status(400)
              .json({ error: "waypoints must be an array if provided" });
          }
          waypoints = waypointsRaw
            .slice(0, MAX_WPS)
            .map((w, i) => {
              const lat = Number(w?.lat ?? w?.latitude);
              const lng = Number(w?.lng ?? w?.longitude);
              const addr = (w?.address ?? "").toString().trim();
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
              return { order_index: i, lat, lng, address: addr || null };
            })
            .filter(Boolean);
        }
      } catch {
        waypoints = [];
      }
    }

    let conn;
    try {
      conn = await mysqlPool.getConnection();
      await conn.beginTransaction();

      // Insert a normal ride shell (instant trip, no pool)
      const [ins] = await conn.execute(
        `
        INSERT INTO rides (
          passenger_id, service_type, status, requested_at,
          pickup_place, dropoff_place,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
          distance_m, duration_s, currency,
          trip_type, pool_batch_id,
          fare_cents, base_fare_cents, payment_method
        ) VALUES (?, ?, 'requested', NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'instant', NULL, ?, ?, ?)
        `,
        [
          passenger_id,
          serviceType || service_code,
          pickup_place ?? null,
          // If BATCH and you want a friendly string, you can override dropoff_place as "Multiple stops"
          job_type === "BATCH"
            ? dropoff_place || "Multiple stops"
            : (dropoff_place ?? null),
          Number(pickup[0]),
          Number(pickup[1]),
          Number(dropoff[0]),
          Number(dropoff[1]),
          distInt,
          durInt,
          currency,
          fareCents,
          fareCents,
          payment_method
        ],
      );

      const rideId = String(ins.insertId);

      // persist waypoints (optional extra stops)
      if (waypoints.length) {
        const values = waypoints.map((w) => [
          rideId,
          w.order_index,
          w.lat,
          w.lng,
          w.address,
        ]);
        await conn.query(
          `INSERT INTO ride_waypoints (ride_id, order_index, lat, lng, address) VALUES ?`,
          [values],
        );
      }

      await conn.commit();

      // 🔊 Broadcast the request to all nearby online drivers whose "code" starts with "D"
      const result = await matcher.broadcastRide({
        io,
        cityId,
        service_code, // canonical for geo
        serviceType: serviceType || service_code,
        trip_type: "instant",
        pickup,
        dropoff,
        pickup_place,
        dropoff_place:
          job_type === "BATCH"
            ? dropoff_place || "Multiple stops"
            : dropoff_place,
        distance_m: distInt,
        duration_s: durInt,
        fare: fareUnits,
        fare_cents: fareCents,
        base_fare,
        rideId,
        passenger_id: String(passenger_id),
        payment_method,
        offer_code,
        waypoints: waypoints.map((w) => ({
          lat: w.lat,
          lng: w.lng,
          address: w.address,
        })),
        driverCodePrefix: "D",
        merchant_id: merchant_id != null ? String(merchant_id) : null,

        // 👇 NEW – delivery/batch metadata for driver app & matching layer
        job_type,
        batch_id,
        drops, // normalized drops with order_id, user_id, amounts, etc.
      });

      return res.json({
        ok: true,
        rideId,
        broadcasted_to_count: result.count,
        broadcasted_driver_ids: result.targets,
        state: result.state,
        job_type,
        batch_id,
      });
    } catch (e) {
      try {
        await conn?.rollback();
      } catch {}
      console.error("[/rides/match/broadcast-delivery] error:", e);
      return res.status(500).json({ error: "Server error" });
    } finally {
      try {
        conn?.release();
      } catch {}
    }
  });

  return router;
}

export default makeMatchingRouter;
