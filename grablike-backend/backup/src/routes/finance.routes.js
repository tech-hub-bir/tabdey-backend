import express from "express";
import { getFinanceSummary, getGstReport } from "../controllers/finance.controller.js";

const router = express.Router();

router.get("/transport/gst-report", getGstReport);
router.get("/transport/finance-summary", getFinanceSummary); // TEMPORARY ALIAS

export default router;
