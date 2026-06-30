// src/services/cancellations.js

/**
 * Grab-style cancellation policy engine driven by DB rules.
 *
 * Tables it expects:
 * - rides (status, fare_cents, currency, accepted_at, arrived_pickup_at, started_at, ...)
 * - ride_bookings (optional, for pool seats: fare_cents, currency)
 * - cancellation_rules
 * - cancellation_levies
 *
 * You can adjust names/columns as per your schema, but logic stays same.
 */

const TERMINAL_STATUSES = new Set([
  "completed",
  "cancelled_driver",
  "cancelled_rider",
  "cancelled_system",
]);

// Grace window (in seconds) after driver accepts, where passenger can cancel for free
const GRACE_SEC_AFTER_ACCEPT = 60;

/**
 * Internal: derive stage for late-cancel fee.
 *
 * Returns one of:
 *   - null (no late fee)
 *   - 'accepted'
 *   - 'arrived_pickup'
 *   - 'started'
 */
function deriveStageWithGrace(ride) {
  if (!ride) return null;

  const status = String(ride.status || "").toLowerCase();

  // No fee if already in a terminal state
  if (TERMINAL_STATUSES.has(status)) return null;

  // After driver has arrived at pickup
  if (status === "arrived_pickup") return "arrived_pickup";

  // After trip has started (if you want a separate rule for this)
  if (status === "started") return "started";

  // Accepted: check grace period
  if (status === "accepted") {
    if (!ride.accepted_at) {
      // If we don't have timestamp, treat as late-accepted (chargeable)
      return "accepted";
    }

    const acceptedTs = new Date(ride.accepted_at).getTime();
    const nowTs = Date.now();
    const secSinceAccept = Math.floor((nowTs - acceptedTs) / 1000);

    if (secSinceAccept <= GRACE_SEC_AFTER_ACCEPT) {
      // Within grace → no fee
      return null;
    }
    return "accepted";
  }

  // Everything else (requested, offered_to_driver, etc) -> no late cancel fee
  return null;
}

/**
 * Applies cancellation policy either for a whole ride OR a single booking (pool seat).
 * Expect an open SQL transaction via `conn`.
 *
 * Params:
 *   conn      - mysql2 pooled connection (transaction already started)
 *   rideId    - BIGINT ride_id
 *   bookingId - optional BIGINT for pool booking
 *   by        - 'passenger'|'driver'|'system' (default 'passenger')
 *
 * Returns:
 * {
 *   applied: boolean,
 *   stage: 'accepted'|'arrived_pickup'|'started'|null,
 *   rule_id: number|null,
 *   fee_cents: number,
 *   driver_share_cents: number,
 *   platform_share_cents: number,
 *
 *   // extra meta (non-breaking)
 *   by: 'passenger'|'driver'|'system',
 *   ride_id: number,
 *   booking_id: number|null,
 *   currency: string|null
 * }
 */
export async function applyCancellationPolicy({
  conn,
  rideId,
  bookingId = null,
  by = "passenger",
}) {
  if (!conn) throw new Error("applyCancellationPolicy: conn is required");
  if (!rideId) {
    throw new Error("applyCancellationPolicy: rideId is required");
  }

  // 1) Fetch ride row (we also need accepted_at for grace)
  const [[ride]] = await conn.query(
    `SELECT 
       ride_id,
       status,
       fare_cents,
       currency,
       accepted_at,
       arrived_pickup_at,
       started_at
     FROM rides
     WHERE ride_id = ?
     LIMIT 1`,
    [rideId]
  );

  if (!ride) {
    return {
      applied: false,
      stage: null,
      rule_id: null,
      fee_cents: 0,
      driver_share_cents: 0,
      platform_share_cents: 0,
      by,
      ride_id: rideId,
      booking_id: bookingId,
      currency: null,
    };
  }

  const currency = ride.currency || null;

  // 2) If driver/system cancels, we usually DO NOT charge passenger (Grab-style).
  if (by === "driver" || by === "system") {
    return {
      applied: false,
      stage: null,
      rule_id: null,
      fee_cents: 0,
      driver_share_cents: 0,
      platform_share_cents: 0,
      by,
      ride_id: rideId,
      booking_id: bookingId,
      currency,
    };
  }

  // 3) Passenger cancelling: derive late-cancellation stage
  const stage = deriveStageWithGrace(ride);

  if (!stage) {
    // no late-cancel fee (e.g. before assign, within grace, or already finished)
    return {
      applied: false,
      stage,
      rule_id: null,
      fee_cents: 0,
      driver_share_cents: 0,
      platform_share_cents: 0,
      by,
      ride_id: rideId,
      booking_id: bookingId,
      currency,
    };
  }

  // 4) Base amount: booking fare if bookingId given; otherwise ride fare
  let baseFareCents = Number(ride.fare_cents) || 0;

  if (bookingId) {
    const [[bk]] = await conn.query(
      `SELECT fare_cents, currency 
         FROM ride_bookings 
        WHERE booking_id = ? AND ride_id = ? 
        LIMIT 1`,
      [bookingId, rideId]
    );
    if (bk) {
      baseFareCents = Number(bk.fare_cents) || baseFareCents;
      // If you want: you could override currency from booking here.
      // currency = bk.currency || currency;
    }
  }

  // 5) Pick best active rule for this stage
  const [[rule]] = await conn.query(
    `SELECT rule_id,
            passenger_fee_cents,
            passenger_fee_percent_bp,
            payout_percent_to_driver_bp
       FROM cancellation_rules
      WHERE is_active = 1
        AND stage_from = ?
        AND starts_at <= NOW()
        AND (ends_at IS NULL OR ends_at >= NOW())
      ORDER BY priority ASC, rule_id ASC
      LIMIT 1`,
    [stage]
  );

  if (!rule) {
    // No matching rule -> no fee
    return {
      applied: false,
      stage,
      rule_id: null,
      fee_cents: 0,
      driver_share_cents: 0,
      platform_share_cents: 0,
      by,
      ride_id: rideId,
      booking_id: bookingId,
      currency,
    };
  }

  const fixedCents = Number(rule.passenger_fee_cents) || 0;        // flat fee
  const percentBp = Number(rule.passenger_fee_percent_bp) || 0;    // basis points on fare (10000 = 100%)

  let fee_cents = fixedCents;

  if (percentBp > 0 && baseFareCents > 0) {
    // 10000 bp = 100%
    fee_cents += Math.floor((baseFareCents * percentBp) / 10000);
  }

  if (fee_cents < 0) fee_cents = 0;

  const toDriverBp = Number(rule.payout_percent_to_driver_bp) || 0;
  let driver_share_cents = Math.floor((fee_cents * toDriverBp) / 10000);
  if (driver_share_cents < 0) driver_share_cents = 0;
  const platform_share_cents = Math.max(0, fee_cents - driver_share_cents);

  // 6) Persist this to a dedicated cancellation ledger table
  // NOTE: this only records the levy; actual wallet debits/credits
  // should be done later by your wallet service.
  await conn.execute(
    `INSERT INTO cancellation_levies
       (ride_id, booking_id, fee_cents, driver_share_cents, platform_share_cents, stage, rule_id, created_at)
     VALUES (?,?,?,?,?,?,?, NOW())`,
    [
      rideId,
      bookingId,
      fee_cents,
      driver_share_cents,
      platform_share_cents,
      stage,
      rule?.rule_id || null,
    ]
  );

  return {
    applied: fee_cents > 0,
    stage,
    rule_id: rule?.rule_id || null,
    fee_cents,
    driver_share_cents,
    platform_share_cents,
    by,
    ride_id: rideId,
    booking_id: bookingId,
    currency,
  };
}
