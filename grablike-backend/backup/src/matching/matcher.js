// src/matching/matcher.js
import * as redisMod from "./redis.js";
import {
  geoKey,
  rideHash,
  rideCand,
  rideCurrent,
  rideRejected,
  driverHash,
} from "./redisKeys.js";
import { presence } from "./presence.js";
import { getPushTokensByDriverIds, getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

const getRedis =
  redisMod.getRedis ?? (redisMod.default && redisMod.default.getRedis);
if (!getRedis) throw new Error("matching/redis.js must export getRedis");

const redis = getRedis();

// ----- small helpers -----
const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeWaypoints = (waypointsRaw) => {
  if (!Array.isArray(waypointsRaw) || !waypointsRaw.length) return [];
  const out = [];
  for (const w of waypointsRaw) {
    const lat = numOrNull(w?.lat ?? w?.latitude);
    const lng = numOrNull(w?.lng ?? w?.longitude);
    const address = (w?.address ?? "").toString().trim() || null;
    if (lat != null && lng != null) out.push({ lat, lng, address });
  }
  return out;
};

// ----- pluggable offer adapter -----
let offerAdapter = {
  setOffer: async () => {},
  clearOffer: async () => {},
  reopenRequested: async () => {},
  markNoDrivers: async () => {},
  finalizeOnAccept: async () => {},
};

export function configureMatcher(adapter) {
  offerAdapter = { ...offerAdapter, ...adapter };
}

// ----- discover candidates -----
async function discoverCandidates({
  cityId,
  serviceType, // can be service_code
  pickup,
  steps = [1000, 2000, 3000, 4000, 5000], // 1km → 5km
  count = 25,
}) {
  const [lat, lng] = pickup;

  for (const r of steps) {
    try {
      let res = [];
      try {
        // Newer Redis versions
        res = await redis.geosearch(
          geoKey(cityId, serviceType),
          "FROMLONLAT",
          Number(lng),
          Number(lat),
          "BYRADIUS",
          r,
          "m",
          "ASC",
          "COUNT",
          count,
          "WITHCOORD",
        );
      } catch (e) {
        // Legacy Redis fallback
        console.warn(
          "[discoverCandidates] geosearch failed, fallback to georadius",
          e.message,
        );

        const legacy = await redis.georadius(
          geoKey(cityId, serviceType),
          Number(lng),
          Number(lat),
          r,
          "m",
          "WITHCOORD",
          "ASC",
          "COUNT",
          count,
        );

        res = legacy;
      }

      if (res.length > 0) {
        console.log(`[discoverCandidates] radius=${r}m found=${res.length}`);
        return res.map(([id]) => id);
      }
    } catch (e) {
      console.error("[discoverCandidates] error:", e);
    }
  }

  console.log("[discoverCandidates] No drivers found for pickup=", pickup);
  return [];
}

// ----- offerNext is kept as a stub for backward compatibility -----
async function offerNext(io, rideId, ttlSec = 15) {
  console.warn("[matcher] offerNext is deprecated; broadcast mode active");
  // No operation – sequential offers are no longer used
}

// ----- matcher object -----
export const matcher = {
  /**
   * Request a ride – now broadcasts to all nearby drivers at once.
   * Stores ride details and emits jobRequest to every driver found within expanding radius.
   * Also sends push notifications to all those drivers.
   */
  async requestRide({
    io,
    cityId,
    service_code, // canonical code for geo
    serviceType, // label for UI
    pickup,
    dropoff,
    pickup_place,
    dropoff_place,
    distance_m,
    duration_s,
    fare, // units
    fare_cents, // integer cents (preferred)
    base_fare, // legacy
    rideId,
    passenger_id,
    trip_type,
    pool_batch_id,
    payment_method,
    offer_code,
    waypoints, // array of {lat,lng,address} or {latitude,longitude,address}
    seats, // for pool
    booking_id, // for pool
    merchant_id, // optional for merchant-notify flows
    job_type = "SINGLE",
    batch_id = null,
    preferred_driver_id = null,
  }) {
    const wps = normalizeWaypoints(waypoints);

    const prefDriverId =
      preferred_driver_id != null && String(preferred_driver_id).trim() !== ""
        ? String(preferred_driver_id).trim()
        : null;

    // Store ride details with state "broadcasted"
    await redis.hset(rideHash(rideId), {
      state: "broadcasted",
      cityId: cityId || "thimphu",
      serviceType: serviceType || service_code,
      service_code: service_code || serviceType,
      pickup: JSON.stringify(pickup),
      dropoff: JSON.stringify(dropoff),
      pickup_place: pickup_place || "",
      dropoff_place: dropoff_place || "",
      distance_m: Number.isFinite(Number(distance_m)) ? Number(distance_m) : 0,
      duration_s: Number.isFinite(Number(duration_s)) ? Number(duration_s) : 0,
      fare: fare != null ? String(fare) : "",
      fare_cents: fare_cents != null ? String(fare_cents) : "",
      base_fare: base_fare != null ? String(base_fare) : "",
      passenger_id: passenger_id || "",
      trip_type: trip_type || "instant",
      pool_batch_id: pool_batch_id || "",
      payment_method: payment_method ? JSON.stringify(payment_method) : "",
      offer_code: offer_code ?? "",
      merchant_id: merchant_id != null ? String(merchant_id) : "",
      waypoints_json: wps.length ? JSON.stringify(wps) : "[]",
      stops_count: wps.length,
      seats:
        seats != null ? String(Math.max(1, Math.trunc(Number(seats)))) : "",
      booking_id: booking_id != null ? String(booking_id) : "",
      job_type: job_type || "SINGLE",
      batch_id: batch_id != null ? String(batch_id) : "",
      preferred_driver_id: prefDriverId ?? "",
    });

    // Discover nearby drivers
    const candidates = await discoverCandidates({
      cityId,
      serviceType: service_code || serviceType,
      pickup,
    });

    // If preferred driver not already in geo results, inject them so we always
    // attempt the socket emit even if they're slightly outside the geo key.
    let allCandidates = candidates;
    if (prefDriverId && !candidates.map(String).includes(prefDriverId)) {
      allCandidates = [prefDriverId, ...candidates];
    }

    if (!allCandidates.length) {
      await redis.hset(rideHash(rideId), { state: "no_drivers" });
      await offerAdapter.markNoDrivers({ rideId });
      console.log(`[matcher.requestRide] rideId=${rideId} no drivers found`);
      return { rideId, state: "no_drivers" };
    }

    // Fetch ride from Redis for building the job payload
    const ride = await redis.hgetall(rideHash(rideId));

    // Normalize fare for emission
    let fareOut;
    if (ride.fare != null && ride.fare !== "") {
      const n = Number(ride.fare);
      if (Number.isFinite(n)) fareOut = n;
    } else if (ride.fare_cents != null && ride.fare_cents !== "") {
      const c = Number(ride.fare_cents);
      if (Number.isFinite(c)) fareOut = c / 100;
    } else if (ride.base_fare != null && ride.base_fare !== "") {
      const b = Number(ride.base_fare);
      if (Number.isFinite(b)) fareOut = b;
    } else {
      fareOut = 0;
    }

    // Parse stored fields
    const pickupArr = ride.pickup ? JSON.parse(ride.pickup) : undefined;
    const dropoffArr = ride.dropoff ? JSON.parse(ride.dropoff) : undefined;
    let waypointsStored = [];
    try {
      waypointsStored = ride.waypoints_json ? JSON.parse(ride.waypoints_json) : [];
    } catch {
      waypointsStored = [];
    }
    const stops_count = Number(ride.stops_count || 0);
    const jobType = ride.job_type || "SINGLE";
    const batchId =
      ride.batch_id != null && ride.batch_id !== "" ? Number(ride.batch_id) : null;

    // Helper: build and emit jobRequest payload to a single driver
    const emitJobRequest = (driverId, { preferred = false } = {}) => {
      io.to(`driver:${driverId}`).emit("jobRequest", {
        request_id: rideId,
        passenger_id: ride.passenger_id,
        pickup: pickupArr,
        dropoff: dropoffArr,
        pickup_place: ride.pickup_place || "",
        dropoff_place: ride.dropoff_place || "",
        waypoints: waypointsStored,
        stops_count,
        distance_m: Number(ride.distance_m || 0),
        distance_km: Math.round((Number(ride.distance_m || 0) / 1000) * 10) / 10,
        eta_min: Math.round(Number(ride.duration_s || 0) / 60),
        fare: fareOut ?? 0,
        cityId: ride.cityId,
        serviceType: ride.serviceType,
        service_code: ride.service_code,
        trip_type: ride.trip_type || "instant",
        offer_code: ride.offer_code || null,
        payment_method: ride.payment_method ? JSON.parse(ride.payment_method) : null,
        booking_id: ride.booking_id || null,
        seats: ride.seats ? Number(ride.seats) : undefined,
        job_type: jobType,
        batch_id: batchId,
        preferred,  // tells driver app "you were specifically requested"
        flight_number: ride.flight_number || null,
        airport_code: ride.airport_code || null,
        airport_name: ride.airport_name || null,
      });
    };

    const PREFERRED_FALLBACK_MS = 30_000; // 30 s

    if (prefDriverId) {
      // ── Preferred driver mode ──
      // 1. Notify only the preferred driver immediately
      console.log(`[matcher] preferred_driver_id=${prefDriverId} for rideId=${rideId} — sending exclusive offer`);
      emitJobRequest(prefDriverId, { preferred: true });

      // Push notification to preferred driver only
      const prefPushTokens = await getPushTokensByDriverIds([prefDriverId]);
      if (prefPushTokens.length) {
        sendPushToTokens(prefPushTokens, {
          title: "You were requested!",
          body: `A passenger specifically requested you. Pickup: ${ride.pickup_place || "nearby"}`,
          data: { type: "ride_request", rideId, preferred: true },
        }).catch((err) => console.error("[matcher] preferred push error:", err));
      }

      // 2. After 30s, if the ride is still unaccepted, fall back to all other candidates
      setTimeout(async () => {
        try {
          const current = await redis.hget(rideHash(rideId), "state");
          if (current !== "broadcasted") return; // already accepted or cancelled

          const fallbackCandidates = allCandidates.filter((id) => String(id) !== prefDriverId);
          if (!fallbackCandidates.length) return;

          console.log(`[matcher] preferred driver ${prefDriverId} did not respond for rideId=${rideId} — broadcasting to ${fallbackCandidates.length} others`);

          fallbackCandidates.forEach((driverId) => emitJobRequest(driverId));

          const distanceKm = Math.round((Number(ride.distance_m || 0) / 1000) * 10) / 10;
          const tokens = await getPushTokensByDriverIds(fallbackCandidates);
          if (tokens.length) {
            sendPushToTokens(tokens, {
              title: "New Ride Request",
              body: `Pickup: ${ride.pickup_place || "Your location"} – ${distanceKm} km`,
              data: { type: "ride_request", rideId },
            }).catch((err) => console.error("[matcher] fallback push error:", err));
          }
        } catch (err) {
          console.error("[matcher] preferred fallback error:", err);
        }
      }, PREFERRED_FALLBACK_MS);

    } else {
      // ── Normal broadcast to all nearby drivers ──
      allCandidates.forEach((driverId) => emitJobRequest(driverId));

      const distanceKm = Math.round((Number(ride.distance_m || 0) / 1000) * 10) / 10;
      const pushTokens = await getPushTokensByDriverIds(allCandidates);
      if (pushTokens.length) {
        sendPushToTokens(pushTokens, {
          title: "New Ride Request",
          body: `Pickup: ${ride.pickup_place || "Your location"} – ${distanceKm} km`,
          data: { type: "ride_request", rideId, pickup: ride.pickup, dropoff: ride.dropoff, fare: fareOut },
        }).catch((err) => console.error("[matcher.requestRide] Push notification error:", err));
      }
    }

    return {
      rideId,
      state: "broadcasted",
      candidates: allCandidates.length,
      preferred_driver_id: prefDriverId,
      pickup,
      dropoff,
      pickup_place,
      dropoff_place,
      distance_m,
      duration_s,
      fare,
      payment_method,
      stops_count: wps.length,
    };
  },

  /**
   * Broadcast a delivery job (single or batch) to all nearby drivers.
   * Supports:
   *   job_type = "SINGLE" | "BATCH"
   *   batch_id = BIGINT or null
   *   drops[] = multiple customer orders for batch jobs
   *
   * Also sends push notifications to drivers.
   */
  async broadcastRide({
    io,
    cityId,
    service_code, // canonical for geo key
    serviceType,
    trip_type,
    pickup,
    dropoff,
    pickup_place,
    dropoff_place,
    distance_m,
    duration_s,
    fare,
    fare_cents,
    base_fare,
    rideId,
    passenger_id,
    payment_method,
    offer_code,
    waypoints,

    // merchant for notifications
    merchant_id,

    // NEW FOR GROUP DELIVERY
    job_type = "SINGLE", // "BATCH" or "SINGLE"
    batch_id = null,
    drops = [], // array of stops (for BATCH jobs)

    driverCodePrefix = "D",
    radiusM = 5000,
    count = 50,

    // airport transfer fields (optional)
    flight_number = null,
    airport_code = null,
    airport_name = null,
  }) {
    const wps = normalizeWaypoints(waypoints);

    // store initial ride state
    await redis.hset(rideHash(rideId), {
      state: "broadcasted",

      cityId: cityId || "thimphu",
      serviceType: serviceType || service_code,
      service_code: service_code || serviceType,
      trip_type: trip_type || "instant",

      pickup: JSON.stringify(pickup),
      dropoff: JSON.stringify(dropoff),

      pickup_place: pickup_place || "",
      dropoff_place: dropoff_place || "",

      distance_m: Number(distance_m || 0),
      duration_s: Number(duration_s || 0),

      fare: fare != null ? String(fare) : "",
      fare_cents: fare_cents != null ? String(fare_cents) : "",
      base_fare: base_fare != null ? String(base_fare) : "",

      passenger_id: passenger_id || "",
      trip_type: "instant",

      payment_method: payment_method ? JSON.stringify(payment_method) : "",
      offer_code: offer_code ?? "",

      merchant_id: merchant_id != null ? String(merchant_id) : "",

      // NEW BATCH FIELDS
      job_type: job_type,
      batch_id: batch_id != null ? String(batch_id) : "",
      drops_json: drops.length ? JSON.stringify(drops) : "[]",

      waypoints_json: wps.length ? JSON.stringify(wps) : "[]",
      stops_count: wps.length,
    });

    // -------------------------------
    // Discover nearby drivers
    // -------------------------------
    const [lat, lng] = pickup;
    let nearby = [];
    try {
      nearby = await presence.getNearbyByCodePrefix({
        cityId,
        lat,
        lng,
        radiusM,
        count,
        driverCodePrefix, // only D* for delivery
      });
    } catch (e) {
      console.error("[matcher.broadcastRide] geo error:", e);
    }

    if (!nearby.length) {
      await redis.hset(rideHash(rideId), { state: "no_drivers" });
      await offerAdapter.markNoDrivers({ rideId });
      return { count: 0, targets: [], state: "no_drivers" };
    }

    // -------------------------------
    // Build driver payload
    // -------------------------------
    const fareOut =
      fare != null && Number(fare) >= 0
        ? Number(fare)
        : fare_cents != null
          ? Number(fare_cents) / 100
          : Number(base_fare || 0);

    // stops structure for the frontend driver app
    const stops = [
      {
        type: "pickup",
        lat: pickup[0],
        lng: pickup[1],
        address: pickup_place || "",
        index: 0,
      },
    ];

    if (job_type === "BATCH") {
      drops.forEach((d, i) => {
        stops.push({
          type: "dropoff",
          index: i,
          order_id: d.order_id,
          user_id: d.user_id,
          lat: d.lat,
          lng: d.lng,
          address: d.address,
          customer_name: d.customer_name,
          customer_phone: d.customer_phone,
          amount: d.amount,
          delivery_fee: d.delivery_fee,
          cash_to_collect: d.cash_to_collect,
        });
      });
    } else {
      // single delivery
      stops.push({
        type: "dropoff",
        index: 0,
        lat: dropoff[0],
        lng: dropoff[1],
        address: dropoff_place || "",
      });
    }

    // ------------------------------------
    // Send to each driver (Socket.IO)
    // ------------------------------------
    const targets = [];

    for (const d of nearby) {
      const driverId = String(d.id ?? d.driverId ?? d);
      if (!driverId) continue;

      targets.push(driverId);

      io.to(`driver:${driverId}`).emit("jobRequest", {
        request_id: rideId,
        passenger_id,

        pickup,
        dropoff,

        pickup_place: pickup_place || "",
        dropoff_place:
          job_type === "BATCH" ? "Multiple stops" : dropoff_place || "",

        waypoints: wps,
        stops_count: stops.length,
        stops, // <-- IMPORTANT FOR DRIVER UI

        job_type,
        batch_id,
        drops,

        distance_m: Number(distance_m || 0),
        distance_km: Math.round((Number(distance_m || 0) / 1000) * 10) / 10,
        eta_min: Math.round(Number(duration_s || 0) / 60),

        fare: fareOut,

        cityId: cityId || "thimphu",
        serviceType: serviceType || service_code,
        service_code: service_code || serviceType,
        trip_type: trip_type || "instant",

        offer_code: offer_code ?? null,
        payment_method,
        flight_number: flight_number || null,
        airport_code: airport_code || null,
        airport_name: airport_name || null,
      });
    }

    // ----- PUSH NOTIFICATIONS FOR DRIVERS -----
    if (targets.length) {
      // Fetch push tokens for all driver IDs
      const pushTokens = await getPushTokensByDriverIds(targets);
      console.log("[matcher.broadcastRide] Push tokens for drivers:", pushTokens);

      if (pushTokens.length) {
        const notificationMessage = {
          title: "New Ride Request",
          body: `Pickup: ${pickup_place || "Your location"} – ${
            Math.round((distance_m || 0) / 1000)
          } km`,
          data: {
            type: "ride_request",
            rideId,
            pickup: JSON.stringify(pickup),
            dropoff: JSON.stringify(dropoff),
            fare: fareOut,
            // Include any other data needed to open the ride screen
          },
        };
        sendPushToTokens(pushTokens, notificationMessage).catch((err) => {
          console.error("[matcher.broadcastRide] Push notification error:", err);
        });
      }
    }

    return { count: targets.length, targets, state: "broadcasted" };
  },

  /**
   * Accept an offer – works for both broadcast and legacy sequential modes.
   * Sends push notification to passenger when ride is accepted.
   */
  async acceptOffer({ io, rideId, driverId }) {
    const rideKey = rideHash(rideId);
    const ride = await redis.hgetall(rideKey);
    const state = ride?.state || null;

    if (state === "broadcasted") {
      const lockKey = `ride:${rideId}:lock`;
      const lockRes = await redis.set(lockKey, driverId, "NX", "EX", 30);
      if (!lockRes) {
        return { ok: false, reason: "already_taken" };
      }
      await redis.hset(rideKey, { state: "assigned", driver: driverId });
    } else {
      // Fallback for any remaining sequential rides (should not happen now)
      const cur = await redis.get(rideCurrent(rideId));
      if (cur !== driverId) return { ok: false, reason: "not_current" };
      await redis.hset(rideKey, { state: "assigned", driver: driverId });
      await redis.del(rideCurrent(rideId));
    }

    await offerAdapter.finalizeOnAccept({ rideId });

    io.to(`ride:${rideId}`).emit("match:found", { driverId });
    io.to(`driver:${driverId}`).emit("offer:confirmed", { request_id: rideId });

    const merchantId = ride?.merchant_id || ride?.merchantId;
    if (merchantId) {
      const payload = {
        ride_id: rideId,
        request_id: rideId,
        driver_id: driverId,
        passenger_id: ride?.passenger_id || null,
        status: "assigned",
        service_code: ride?.service_code || null,
        serviceType: ride?.serviceType || null,
      };

      // call deliveryAccepted for merchant notification flows
      io.to(`merchant:${merchantId}`).emit("deliveryAccepted", payload);
      console.log(
        "[matcher.acceptOffer] notified merchant room:",
        `merchant:${merchantId}`,
        "payload:",
        payload,
      );
    }

    // ----- PUSH NOTIFICATION FOR PASSENGER -----
    const passengerId = ride?.passenger_id;
    if (passengerId) {
      const passengerTokens = await getPushTokensByUserIds([passengerId]);
      if (passengerTokens.length) {
        const notificationMessage = {
          title: "Ride Accepted",
          body: `Driver ${driverId} is on the way to pick you up.`,
          data: {
            type: "ride_accepted",
            rideId,
            driverId,
          },
        };
        sendPushToTokens(passengerTokens, notificationMessage).catch((err) => {
          console.error("[matcher.acceptOffer] Passenger push error:", err);
        });
      }
    }

    return { ok: true };
  },

  /**
   * Reject an offer – for broadcasted rides, we simply ignore (no further action).
   */
  async rejectOffer({ io, rideId, driverId }) {
    const rideKey = rideHash(rideId);
    const ride = await redis.hgetall(rideKey);
    const state = ride?.state;

    // Broadcasted rides: rejection does not affect others
    if (state === "broadcasted") {
      // Optionally track rejection, but no need to call offerNext
      return { ok: true };
    }

    // Legacy sequential mode (unused now, but kept for safety)
    await redis.sadd(rideRejected(rideId), driverId);
    const cur = await redis.get(rideCurrent(rideId));
    if (cur === driverId) await redis.del(rideCurrent(rideId));
    await offerAdapter.reopenRequested({ rideId });
    io.to(`driver:${driverId}`).emit("jobRequestCancelled", {
      request_id: rideId,
      reason: "reject",
    });
    await offerNext(io, rideId);
    return { ok: true };
  },

  discoverCandidates,
};

export default matcher;