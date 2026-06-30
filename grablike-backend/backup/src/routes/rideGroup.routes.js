// routes/rideGroup.routes.js
import { Router } from "express";
import {
  createRideInvite,
  getInviteByCode,
  joinByInviteCode,
  listParticipants,
  leaveRide,
  removeGuest,
  revokeInvite,
  listAvailableSharedRides,
  joinRideDirectly,
} from "../controllers/rideGroup.controller.js";

const router = Router();

/* -------- invites -------- */
router.post("/rides/:ride_id/invites", createRideInvite);
router.post("/rides/:ride_id/invites/:code/revoke", revokeInvite);

// invite lookup + join
router.get("/ride-invites/:code", getInviteByCode);
router.post("/ride-invites/:code/join", joinByInviteCode);

/* -------- discovery & direct join (Grab-style) -------- */
router.get("/rides/available-shared", listAvailableSharedRides);
router.post("/rides/:ride_id/join-direct", joinRideDirectly);

/* -------- participants -------- */
router.get("/rides/:ride_id/participants", listParticipants);
router.post("/rides/:ride_id/participants/leave", leaveRide);
router.post("/rides/:ride_id/participants/:user_id/remove", removeGuest);

export default router;
