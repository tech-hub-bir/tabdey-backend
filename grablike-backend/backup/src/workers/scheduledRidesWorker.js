// src/workers/scheduledRidesWorker.js
import matcher from "../matching/matcher.js";
import { sendBothNotifications } from "./notificationWorker.js"; // ✅ import stays

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REMINDER_WINDOW_MINUTES = 15; // notify driver this many minutes before pickup

/**
 * Scheduled rides worker (UTC-safe):
 * - Sends driver reminders for upcoming reserved rides
 * - Auto‑releases expired reservations (both 'scheduled' and 'offered_to_driver')
 * - Dispatches due rides with no active reservation
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
      // ---------- STEP 1: Driver reminders (15 min before) ----------
      let reminderConn;
      try {
        reminderConn = await mysqlPool.getConnection();
        await reminderConn.beginTransaction();

        const [reminderRows] = await reminderConn.query(
          `
          SELECT
            r.ride_id,
            r.driver_id,
            d.user_id,                     -- ✅ users.id for notification
            r.scheduled_at,
            r.dispatch_at,
            r.pickup_place
          FROM rides r
          JOIN drivers d ON d.driver_id = r.driver_id
          WHERE r.booking_type = 'SCHEDULED'
            AND r.status = 'scheduled'
            AND r.driver_id IS NOT NULL
            AND r.offer_expire_at > UTC_TIMESTAMP()    -- reservation still valid
            AND (
              (r.scheduled_at IS NOT NULL AND r.scheduled_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL ? MINUTE)
              OR (r.dispatch_at IS NOT NULL AND r.dispatch_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL ? MINUTE)
            )
            AND (r.driver_reminded_at IS NULL OR r.driver_reminded_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 HOUR))
          `,
          [REMINDER_WINDOW_MINUTES, REMINDER_WINDOW_MINUTES],
        );

        for (const ride of reminderRows) {
          const rideId = String(ride.ride_id);
          const userId = String(ride.user_id); // ✅ CORRECT user account ID
          const driverId = String(ride.driver_id); // for logging only
          const scheduledTime = ride.scheduled_at || ride.dispatch_at;

          // 🔁 REPLACED: manual INSERT → reusable notifier (in-app + push)
          await sendBothNotifications(reminderConn, {
            user_id: userId,
            type: "scheduled_ride_reminder",
            title: "Upcoming Scheduled Ride",
            message: `Your scheduled ride #${rideId} starts in ${REMINDER_WINDOW_MINUTES} minutes. Please be ready at ${ride.pickup_place || "the pickup location"}.`,
            data: {
              ride_id: rideId,
              scheduled_at: ride.scheduled_at,
              dispatch_at: ride.dispatch_at,
              pickup_place: ride.pickup_place,
            },
          });

          // ✅ Mark reminder sent (unchanged)
          await reminderConn.query(
            `UPDATE rides SET driver_reminded_at = UTC_TIMESTAMP() WHERE ride_id = ?`,
            [ride.ride_id],
          );

          console.log(
            `[scheduledWorker] reminder sent to driver profile ${driverId} (user ${userId}) for ride ${rideId}`,
          );
        }

        await reminderConn.commit();
      } catch (e) {
        try {
          await reminderConn?.rollback();
        } catch {}
        console.error("[scheduledWorker] reminder error:", e);
      } finally {
        try {
          reminderConn?.release();
        } catch {}
      }

      // ---------- STEP 2: Auto‑release expired reservations (both scheduled & offered) ----------
      let dispatchConn;
      try {
        dispatchConn = await mysqlPool.getConnection();
        await dispatchConn.beginTransaction();

        // 2a) Release expired offers for 'scheduled' rides
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
          `,
        );

        // 2b) Release expired offers for 'offered_to_driver' rides and reset status to 'scheduled'
        await dispatchConn.query(
          `
          UPDATE rides
          SET status = 'scheduled',        -- ✅ back to scheduled for re‑dispatch
              driver_id = NULL,
              reserved_at = NULL,
              reserved_confirmed_at = NULL,
              offer_expire_at = NULL
          WHERE booking_type = 'SCHEDULED'
            AND status = 'offered_to_driver'
            AND driver_id IS NOT NULL
            AND offer_expire_at IS NOT NULL
            AND offer_expire_at <= UTC_TIMESTAMP()
          `,
        );

        // ---------- STEP 3: Dispatch due rides (no active reservation) ----------
        const [dueRows] = await dispatchConn.query(
          `
          SELECT ride_id
          FROM rides
          WHERE booking_type = 'SCHEDULED'
            AND status = 'scheduled'
            AND scheduled_at IS NOT NULL
            AND (driver_id IS NULL OR offer_expire_at IS NULL OR offer_expire_at <= UTC_TIMESTAMP())
            AND (
              (dispatch_at IS NOT NULL AND dispatch_at <= UTC_TIMESTAMP())
              OR (dispatch_at IS NULL AND scheduled_at <= UTC_TIMESTAMP())
            )
          ORDER BY COALESCE(dispatch_at, scheduled_at) ASC
          LIMIT ?
          FOR UPDATE
          `,
          [batchSize],
        );

        if (!dueRows.length) {
          await dispatchConn.commit();
          await sleep(pollMs);
          continue;
        }

        const rideIds = dueRows.map((r) => Number(r.ride_id)).filter(Boolean);

        // 3a) Claim rides: scheduled -> requested
        await dispatchConn.query(
          `
          UPDATE rides
          SET status = 'requested',
              requested_at = UTC_TIMESTAMP()
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
            AND status = 'scheduled'
          `,
          rideIds,
        );

        // 3b) Fetch full ride data (including timestamps for notifications if needed)
        const [rides] = await dispatchConn.query(
          `
          SELECT
            r.ride_id,
            r.passenger_id,
            r.driver_id,
            r.service_type,
            s.code AS service_code,
            r.pickup_place,
            r.dropoff_place,
            r.pickup_lat, pickup_lng,
            r.dropoff_lat, dropoff_lng,
            r.distance_m,
            r.duration_s,
            r.fare_cents,
            r.currency,
            r.trip_type,
            r.pool_batch_id,
            r.scheduled_at,
            r.dispatch_at,
            r.flight_number,
            r.airport_code,
            r.airport_name
          FROM rides r
          JOIN ride_types s ON s.name = r.service_type
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          `,
          rideIds,
        );

        // 3c) Fetch waypoints
        const [wps] = await dispatchConn.query(
          `
          SELECT ride_id, order_index, lat, lng, address
          FROM ride_waypoints
          WHERE ride_id IN (${rideIds.map(() => "?").join(",")})
          ORDER BY ride_id ASC, order_index ASC
          `,
          rideIds,
        );

        await dispatchConn.commit();

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

        // 3d) Dispatch each ride to the matcher
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
              service_code: r.service_code,
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
              preferred_driver_id ? `(preferred ${preferred_driver_id})` : "",
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
