// src/constants/rideTypes.js
// Single source of truth for all ride-related enums/codes used across routes, controllers, and workers.
// Keep in sync with the rides.status and rides.trip_type ENUM columns in schema.sql.

/**
 * All valid values for rides.status (matches DB ENUM exactly).
 */
export const RIDE_STATUS = Object.freeze({
  SCHEDULED: "scheduled",
  REQUESTED: "requested",
  OFFERED_TO_DRIVER: "offered_to_driver",
  ACCEPTED: "accepted",
  ARRIVED_PICKUP: "arrived_pickup",
  STARTED: "started",
  COMPLETED: "completed",
  CANCELLED_DRIVER: "cancelled_driver",
  CANCELLED_RIDER: "cancelled_rider",
  CANCELLED_SYSTEM: "cancelled_system",
});

/** Ordered list — used for grouping/display. Must match DB ENUM values. */
export const RIDE_STATUS_LIST = Object.values(RIDE_STATUS);

/**
 * Statuses that mean a ride is still active (not yet terminal).
 * Used to filter Redis cache and DB queries.
 */
export const ACTIVE_RIDE_STATUSES = Object.freeze([
  RIDE_STATUS.SCHEDULED,
  RIDE_STATUS.REQUESTED,
  RIDE_STATUS.OFFERED_TO_DRIVER,
  RIDE_STATUS.ACCEPTED,
  RIDE_STATUS.ARRIVED_PICKUP,
  RIDE_STATUS.STARTED,
]);

/** Terminal statuses — no further state transitions possible. */
export const TERMINAL_RIDE_STATUSES = Object.freeze([
  RIDE_STATUS.COMPLETED,
  RIDE_STATUS.CANCELLED_DRIVER,
  RIDE_STATUS.CANCELLED_RIDER,
  RIDE_STATUS.CANCELLED_SYSTEM,
]);

/**
 * All valid values for rides.booking_type (matches DB ENUM exactly).
 * Always stored/compared in UPPERCASE.
 */
export const BOOKING_TYPE = Object.freeze({
  INSTANT: "INSTANT",
  SCHEDULED: "SCHEDULED",
  GROUP: "GROUP",
});

/**
 * All valid values for rides.trip_type (matches DB ENUM exactly).
 * Always stored/compared in lowercase.
 */
export const TRIP_TYPE = Object.freeze({
  INSTANT: "instant",
  POOL: "pool",
  SCHEDULED: "scheduled",
  GROUP: "group",
});

export const VALID_TRIP_TYPES = Object.values(TRIP_TYPE);
export const VALID_BOOKING_TYPES = Object.values(BOOKING_TYPE);
