// src/workers/scheduledRidesWorker.js
import matcher from "../matching/matcher.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REMINDER_WINDOW_MINUTES = 15; // notify driver this many minutes before pickup

/**
 * Scheduled rides worker (UTC-safe):
 * - Sends driver reminders for upcoming reserved rides
 * - Auto‑releases expired reservations
 * - Dispatches due rides
 */
export function startScheduledRidesWorker({
  io,
  mysqlPool,
  pollMs = 5000,
  batchSize = 25,
}) {
  let stopped = false;

  console.log("[scheduledWorker] started");

  const run = async () => {
    while (!stopped) {
      // ---------- STEP 1: Driver reminders (upcoming reserved rides) ----------
      let reminderConn;
      try {
        reminderConn = await mysqlPool.getConnection();
        await reminderConn.beginTransaction();

        const [reminderRows] = await reminderConn.query(
          `
          SELECT ride_id, driver_id, scheduled_at, dispatch_at, pickup_place
          FROM rides
          WHERE booking_type = 'SCHEDULED'
            AND status = 'scheduled'
            AND driver_id IS NOT NULL
            AND offer_expire_at > UTC_TIMESTAMP()          -- still valid reservation
            AND (
              (scheduled_at IS NOT NULL AND scheduled_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL ? MINUTE)
              OR (dispatch_at IS NOT NULL AND dispatch_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL ? MINUTE)
            )
            AND (driver_reminded_at IS NULL OR driver_reminded_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR))  -- not reminded in last 12h
          `,
          [REMINDER_WINDOW_MINUTES, REMINDER_WINDOW_MINUTES]
        );

        for (const ride of reminderRows) {
          const rideId = String(ride.ride_id);
          const driverId = String(ride.driver_id);
          const scheduledTime = ride.scheduled_at || ride.dispatch_at;
          const formattedTime = scheduledTime
            ? new Date(scheduledTime).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' })
            : 'soon';

          const notificationData = JSON.stringify({
            ride_id: rideId,
            scheduled_at: ride.scheduled_at,
            dispatch_at: ride.dispatch_at,
            pickup_place: ride.pickup_place,
          });

          // Insert in‑app notification for the driver
          await reminderConn.query(
            `INSERT INTO notifications
              (user_id, type, title, message, data)
             VALUES (?, ?, ?, ?, ?)`,
            [
              driverId,
              'scheduled_ride_reminder',
              'Upcoming Scheduled Ride',
              `Your scheduled ride #${rideId} starts in ${REMINDER_WINDOW_MINUTES} minutes. Please be ready at ${ride.pickup_place || 'the pickup location'}.`,
              notificationData,
            ]
          );

          // Mark reminder sent
          await reminderConn.query(
            `UPDATE rides SET driver_reminded_at = UTC_TIMESTAMP() WHERE ride_id = ?`,
            [ride.ride_id]
          );

          console.log(`[scheduledWorker] reminder sent to driver ${driverId} for ride ${rideId}`);
        }

        await reminderConn.commit();
      } catch (e) {
        try { await reminderConn?.rollback(); } catch {}
        console.error('[scheduledWorker] reminder error:', e);
      } finally {
        try { reminderConn?.release(); } catch {}
      }

      // ---------- STEP 2: Dispatch due rides (existing logic) ----------
      let dispatchConn;
      try {
        dispatchConn = await mysqlPool.getConnection();
        await dispatchConn.beginTransaction();

        // 2a) Auto‑release expired reservations
        await dispatchConn.query(
          `
          UPDATE rides
          SET driver_id = NULL,
              reserved_at = NULL,
              reserved_confirmed_at = NULL,
              offer_expire_at = NULL
          WHERE booking_type = 'SCHEDULED'
            AND status = 'scheduled'
            AND driver_id IS NOT NULL
            AND offer_expire_at IS NOT NULL
            AND offer_expire_at <= UTC_TIMESTAMP()
          `
        );

        // 2b) Find rides due for dispatch (only those without active reservations)
        const [dueRows] = await dispatchConn.query(
          `
          SELECT ride_id
          FROM rides
          WHERE booking_type = 'SCHEDULED'
            AND status = 'scheduled'
            AND scheduled_at IS NOT NULL
            AND (driver_id IS NULL OR offer_expire_at IS NULL OR offer_expire_at <= UTC_TIMESTAMP())  -- no active reservation
            AND (
              (dispatch_at IS NOT NULL AND dispatch_at <= UTC_TIMESTAMP())
              OR (dispatch_at IS NULL AND scheduled_at <= UTC_TIMESTAMP())
            )
          ORDER BY COALESCE(dispatch_at, scheduled_at) ASC
          LIMIT ?
          FOR UPDATE
          `,
          [batchSize]
        );

        if (!dueRows.length) {
          await dispatchConn.commit();
          await sleep(pollMs);
          continue;
        }

        const rideIds = dueRows.map((r) => Number(r.ride_id)).filter(Boolean);

        // 2c) Claim rides: scheduled -> requested
        await dispatchConn.query(
          `
          UPDATE rides
          SET status = 'requested',
              requested_at = UTC_TIMESTAMP()
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
            AND status = 'scheduled'
          `,
          rideIds
        );

        // 2d) Fetch full ride data (including timestamps for later use)
        const [rides] = await dispatchConn.query(
          `
          SELECT
            ride_id,
            passenger_id,
            driver_id,
            service_type,
            pickup_place,
            dropoff_place,
            pickup_lat, pickup_lng,
            dropoff_lat, dropoff_lng,
            distance_m,
            duration_s,
            fare_cents,
            currency,
            trip_type,
            pool_batch_id,
            scheduled_at,
            dispatch_at
          FROM rides
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          `,
          rideIds
        );

        // 2e) Fetch waypoints
        const [wps] = await dispatchConn.query(
          `
          SELECT ride_id, order_index, lat, lng, address
          FROM ride_waypoints
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          ORDER BY ride_id ASC, order_index ASC
          `,
          rideIds
        );

        await dispatchConn.commit();

        // Group waypoints
        const wpByRide = new Map();
        for (const w of wps) {
          const id = String(w.ride_id);
          if (!wpByRide.has(id)) wpByRide.set(id, []);
          wpByRide.get(id).push({
            lat: Number(w.lat),
            lng: Number(w.lng),
            address: w.address || null,
          });
        }

        // 2f) Dispatch to matcher
        for (const r of rides) {
          const rideId = String(r.ride_id);

          const pickup = [Number(r.pickup_lat), Number(r.pickup_lng)];
          const dropoff = [Number(r.dropoff_lat), Number(r.dropoff_lng)];

          const fare_cents =
            r.fare_cents != null && r.fare_cents !== ""
              ? Number(r.fare_cents)
              : null;

          let payment_method = null;
          try {
            if (r.payment_method) {
              payment_method =
                typeof r.payment_method === "string"
                  ? JSON.parse(r.payment_method)
                  : r.payment_method;
            }
          } catch {
            payment_method = null;
          }

          const preferred_driver_id =
            r.driver_id != null && String(r.driver_id).trim() !== ""
              ? String(r.driver_id)
              : null;

          try {
            await matcher.requestRide({
              io,
              cityId: "thimphu",
              service_code: r.service_type,
              serviceType: r.service_type,
              pickup,
              dropoff,
              pickup_place: r.pickup_place || "",
              dropoff_place: r.dropoff_place || "",
              distance_m: r.distance_m ?? 0,
              duration_s: r.duration_s ?? 0,
              fare: fare_cents != null ? fare_cents / 100 : null,
              fare_cents,
              base_fare: null,
              rideId,
              passenger_id: String(r.passenger_id),
              trip_type: r.trip_type || "instant",
              pool_batch_id: r.pool_batch_id || null,
              payment_method,
              offer_code: r.offer_code || null,
              waypoints: wpByRide.get(rideId) || [],
              seats: null,
              booking_id: null,
              job_type: "SINGLE",
              batch_id: null,
              preferred_driver_id,
            });

            console.log(
              "[scheduledWorker] dispatched:",
              rideId,
              preferred_driver_id ? `(preferred ${preferred_driver_id})` : ""
            );
          } catch (e) {
            console.error("[scheduledWorker] matcher failed:", rideId, e);
          }
        }
      } catch (e) {
        try {
          await dispatchConn?.rollback();
        } catch {}
        console.error("[scheduledWorker] dispatch error:", e);
        await sleep(pollMs);
      } finally {
        try {
          dispatchConn?.release();
        } catch {}
      }
    }
  };

  run();

  return {
    stop() {
      stopped = true;
    },
  };
}