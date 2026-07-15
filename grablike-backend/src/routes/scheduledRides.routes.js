// src/routes/scheduledRides.routes.js
import express from "express";
import {
  listScheduledRidesForDriver,
  reserveScheduledRide,
  releaseScheduledRide,
  reconfirmScheduledRide,
  listScheduledRidesForPassenger,
  listMyScheduledRidesForDriver,
  getPassengerRidesGroupedByStatus,
  getDriverRidesGroupedByStatus,
} from "../controllers/scheduledRides.controller.js";
import requireAuth from "../middleware/requireAuth.js";

const router = express.Router();

// All scheduled-ride endpoints resolve the acting driver/passenger from the
// authenticated token (see controller) — never trust it must be authenticated.
router.use(requireAuth);

/* ================= DRIVER ================= */
router.get("/driver/list", listScheduledRidesForDriver);
router.get("/driver/my", listMyScheduledRidesForDriver);

// ✅ NEW: grouped rows by status (driver_id/user_id)
router.get("/driver/grouped", getDriverRidesGroupedByStatus);

/* ================= PASSENGER ================= */
router.get("/passenger/list", listScheduledRidesForPassenger);

// ✅ NEW: grouped rows by status (passenger_id/user_id)
router.get("/passenger/grouped", getPassengerRidesGroupedByStatus);

/* ================= ACTIONS ================= */
router.post("/:rideId/reserve", reserveScheduledRide);
router.post("/:rideId/release", releaseScheduledRide);
router.post("/:rideId/reconfirm", reconfirmScheduledRide);

export default router;
