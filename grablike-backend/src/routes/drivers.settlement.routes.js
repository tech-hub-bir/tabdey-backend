import express from "express";
import {
  getAllDueSettlements,
  getDueSettlementsGroupedByDriver,
  getAllSettledSettlements,
  getDriverSettlementBalance,
  getDriverSettlementLedger,
  postDriverSettlementPay,
  postDriverSettlementAdjust,
  postDriverSettlementReverse,
} from "../controllers/driverSettlement.controller.js";

const router = express.Router();

router.get("/due", getAllDueSettlements)
router.get("/due-by-driver", getDueSettlementsGroupedByDriver);
router.get("/settled", getAllSettledSettlements)

router.get("/drivers/:id/settlement/balance", getDriverSettlementBalance);
router.get("/drivers/:id/settlement/ledger", getDriverSettlementLedger);

router.post("/drivers/:id/settlement/pay", postDriverSettlementPay);
router.post("/drivers/:id/settlement/adjust", postDriverSettlementAdjust);
router.post("/drivers/:id/settlement/reverse", postDriverSettlementReverse);

export default router;
