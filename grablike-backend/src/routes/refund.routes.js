import express from "express";
import { refundRide } from "../controllers/refund.controller.js";

const router = express.Router();

router.post("/refund-ride", refundRide);

export default router;
