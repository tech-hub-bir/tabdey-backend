// src/routes/guestWaypoints.js
import express from "express";
import { guestWaypointsController } from "../controllers/guestWaypoints.controller.js";

export default function guestWaypointsRouter(mysqlPool) {
  const router = express.Router();
  const c = guestWaypointsController(mysqlPool);

  // Guest sets/updates their pickup point
  router.post("/rides/:rideId/guest-waypoint", c.upsertGuestWaypoint);

  // Host/anyone can fetch all guest waypoints for this ride
  router.get("/rides/:rideId/guest-waypoints", c.listGuestWaypoints);

  // Guest removes their waypoint (or host can remove by user_id)
  router.delete("/rides/:rideId/guest-waypoint", c.deleteGuestWaypoint);

  return router;
}
