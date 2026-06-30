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
  steps = [5000, 10000, 20000, 30000, 50000],
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
          "WITHCOORD"
        );
      } catch (e) {
        // Legacy Redis fallback
        console.warn(
          "[discoverCandidates] geosearch failed, fallback to georadius",
          e.message
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
          count
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

// ----- offerNext (sequential offer flow) -----
async function offerNext(io, rideId, ttlSec = 15) {
  const state = await redis.hget(rideHash(rideId), "state");
  if (state !== "searching") return;

  const cur = await redis.get(rideCurrent(rideId));
  if (cur) return;

  const nextDriver = await redis.lpop(rideCand(rideId));
  if (!nextDriver) {
    await redis.hset(rideHash(rideId), { state: "no_drivers" });
    io.to(`ride:${rideId}`).emit("ride:status", { state: "no_drivers" });
    await offerAdapter.markNoDrivers({ rideId });
    return;
  }

  await redis.set(rideCurrent(rideId), nextDriver, "EX", ttlSec);

  const expireAt = new Date(Date.now() + ttlSec * 1000);
  try {
    await offerAdapter.setOffer({ rideId, driverId: nextDriver, expireAt });
  } catch (e) {
    console.warn("[matcher.setOffer] DB write failed:", e.message);
  }

  const ride = await redis.hgetall(rideHash(rideId));

  // Normalize fare to units for emission
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
  }

  // Convert stored strings back to proper shapes
  const pickupArr = ride.pickup ? JSON.parse(ride.pickup) : undefined;
  const dropoffArr = ride.dropoff ? JSON.parse(ride.dropoff) : undefined;

  let waypoints = [];
  try {
    waypoints = ride.waypoints_json ? JSON.parse(ride.waypoints_json) : [];
  } catch {
    waypoints = [];
  }

  const stops_count = Number(ride.stops_count || 0);

  const job_type = ride.job_type || "SINGLE";
  const batch_id =
    ride.batch_id != null && ride.batch_id !== ""
      ? Number(ride.batch_id)
      : null;

  io.to(`driver:${nextDriver}`).emit("jobRequest", {
    request_id: rideId,
    passenger_id: ride.passenger_id,

    pickup: pickupArr,
    dropoff: dropoffArr,
    pickup_place: ride.pickup_place || "",
    dropoff_place: ride.dropoff_place || "",

    // NEW: stops
    waypoints, // [{lat,lng,address}]
    stops_count, // integer

    // driver-facing summary
    distance_m: Number(ride.distance_m || 0),
    distance_km: Math.round((Number(ride.distance_m || 0) / 1000) * 10) / 10,
    eta_min: Math.round(Number(ride.duration_s || 0) / 60),

    // ✅ emit the real fare now
    fare: fareOut ?? 0,

    // meta
    cityId: ride.cityId,
    serviceType: ride.serviceType,
    service_code: ride.service_code,
    trip_type: ride.trip_type || "instant",
    offer_code: ride.offer_code || null,
    payment_method: ride.payment_method
      ? JSON.parse(ride.payment_method)
      : null,

    // NEW: pool/meta passthroughs
    booking_id: ride.booking_id || null,
    seats: ride.seats ? Number(ride.seats) : undefined,

    // NEW: delivery meta (normal rides will just be SINGLE / null)
    job_type,
    batch_id,
  });

  setTimeout(async () => {
    const still = await redis.get(rideCurrent(rideId));
    const st = await redis.hget(rideHash(rideId), "state");

    if (st === "searching" && still === nextDriver) {
      await redis.sadd(rideRejected(rideId), nextDriver);
      await redis.del(rideCurrent(rideId));
      await offerAdapter.reopenRequested({ rideId });

      io.to(`driver:${nextDriver}`).emit("jobRequestCancelled", {
        request_id: rideId,
        reason: "timeout",
      });

      offerNext(io, rideId, ttlSec);
    }
  }, ttlSec * 1000);
}

// ----- matcher object -----
export const matcher = {
  // ✅ Accept fare / fare_cents + waypoints + seats + booking_id from caller and store as-is
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

    // NEW:
    waypoints, // array of {lat,lng,address} or {latitude,longitude,address}
    seats, // for pool
    booking_id, // for pool

    // optional: for merchant-notify flows (normal rides can ignore)
    merchant_id,

    // optional meta, mostly used in delivery but harmless here
    job_type = "SINGLE",
    batch_id = null,
    preferred_driver_id = null,
  }) {
    const wps = normalizeWaypoints(waypoints);

    await redis.hset(rideHash(rideId), {
      state: "searching",

      cityId: cityId || "thimphu",

      // keep both: label + canonical code
      serviceType: serviceType || service_code,
      service_code: service_code || serviceType,

      // store points as JSON strings
      pickup: JSON.stringify(pickup),
      dropoff: JSON.stringify(dropoff),
      pickup_place: pickup_place || "",
      dropoff_place: dropoff_place || "",

      distance_m: Number.isFinite(Number(distance_m)) ? Number(distance_m) : 0,
      duration_s: Number.isFinite(Number(duration_s)) ? Number(duration_s) : 0,

      // ✅ store exactly what we received
      fare: fare != null ? String(fare) : "",
      fare_cents: fare_cents != null ? String(fare_cents) : "",
      base_fare: base_fare != null ? String(base_fare) : "",

      passenger_id: passenger_id || "",
      trip_type: trip_type || "instant",
      pool_batch_id: pool_batch_id || "",

      payment_method: payment_method ? JSON.stringify(payment_method) : "",
      offer_code: offer_code ?? "",

      // merchant (optional, used for notifications)
      merchant_id: merchant_id != null ? String(merchant_id) : "",

      // NEW: stops
      waypoints_json: wps.length ? JSON.stringify(wps) : "[]",
      stops_count: wps.length,

      // NEW: pool additions
      seats:
        seats != null ? String(Math.max(1, Math.trunc(Number(seats)))) : "",
      booking_id: booking_id != null ? String(booking_id) : "",

      // NEW: delivery meta (will usually be SINGLE / empty for normal rides)
      job_type: job_type || "SINGLE",
      batch_id: batch_id != null ? String(batch_id) : "",
    });

    // For discovery we use the canonical service_code as the geo key "serviceType"
    const candidates = await discoverCandidates({
      cityId,
      serviceType: service_code || serviceType,
      pickup,
    });

    // priority driver first (reserved driver)
    let finalCandidates = candidates;
    if (
      preferred_driver_id != null &&
      String(preferred_driver_id).trim() !== ""
    ) {
      const pref = String(preferred_driver_id);
      // put preferred first even if not in nearby list
      const rest = candidates.filter((id) => String(id) !== pref);
      finalCandidates = [pref, ...rest];
    }

    if (!finalCandidates.length) {
      await redis.hset(rideHash(rideId), { state: "no_drivers" });
      await offerAdapter.markNoDrivers({ rideId });
      console.log(
        `[matcher.requestRide] rideId=${rideId} no drivers found, cancelling`
      );
      return { rideId, state: "no_drivers" };
    }

    const pipe = redis.multi();
    finalCandidates.forEach((id) => pipe.rpush(rideCand(rideId), id));
    await pipe.exec();

    await offerNext(io, rideId);

    return {
      rideId,
      state: "searching",
      candidates: candidates.length,
      pickup,
      dropoff,
      pickup_place,
      dropoff_place,
      distance_m,
      duration_s,
      fare,
      // echo stops so caller can debug
      stops_count: wps.length,
    };
  },

  /**
   * Broadcast a delivery job (single or batch) to all nearby drivers.
   * Supports:
   *   job_type = "SINGLE" | "BATCH"
   *   batch_id = BIGINT or null
   *   drops[] = multiple customer orders for batch jobs
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
    // Send to each driver
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
      });
    }

    return { count: targets.length, targets, state: "broadcasted" };
  },

  async acceptOffer({ io, rideId, driverId }) {
    const rideKey = rideHash(rideId);
    const ride = await redis.hgetall(rideKey);
    const state = ride?.state || null;

    // Two modes:
    //  - normal (sequential)   → check rideCurrent
    //  - broadcasted deliveries → first driver wins via Redis lock
    if (state === "broadcasted") {
      const lockKey = `ride:${rideId}:lock`;
      const lockRes = await redis.set(lockKey, driverId, "NX", "EX", 30);
      if (!lockRes) {
        // someone else already accepted
        return { ok: false, reason: "already_taken" };
      }
      await redis.hset(rideKey, { state: "assigned", driver: driverId });
    } else {
      const cur = await redis.get(rideCurrent(rideId));
      if (cur !== driverId) return { ok: false, reason: "not_current" };
      await redis.hset(rideKey, { state: "assigned", driver: driverId });
      await redis.del(rideCurrent(rideId));
    }

    await offerAdapter.finalizeOnAccept({ rideId });

    // Notify passenger + driver (existing behaviour)
    io.to(`ride:${rideId}`).emit("match:found", { driverId });
    io.to(`driver:${driverId}`).emit("offer:confirmed", { request_id: rideId });

    // NEW: notify merchant if present (for delivery-style flows)
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

      io.to(`merchant:${merchantId}`).emit("deliveryAccepted", payload);
      console.log(
        "[matcher.acceptOffer] notified merchant room:",
        `merchant:${merchantId}`,
        "payload:",
        payload
      );
    }

    return { ok: true };
  },

  async rejectOffer({ io, rideId, driverId }) {
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
