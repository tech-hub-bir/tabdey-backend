// src/routes/platformFeeRules.routes.js
import { Router } from "express";
import {
  listPlatformFeeRules,
  getPlatformFeeRule,
  createPlatformFeeRule,
  updatePlatformFeeRule,
  deletePlatformFeeRule,
} from "../controllers/platformFeeRules.controller.js";

const router = Router();

router.get("/", listPlatformFeeRules);
router.get("/:id", getPlatformFeeRule);
router.post("/", createPlatformFeeRule);
router.put("/:id", updatePlatformFeeRule);
router.delete("/:id", deletePlatformFeeRule);

export default router;
