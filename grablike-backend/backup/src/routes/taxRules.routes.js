// src/routes/taxRules.routes.js
import { Router } from "express";
import {
  listTaxRules,
  getTaxRule,
  createTaxRule,
  updateTaxRule,
  deleteTaxRule,
} from "../controllers/taxRules.controller.js";

const router = Router();

router.get("/", listTaxRules);
router.get("/:id", getTaxRule);
router.post("/", createTaxRule);
router.put("/:id", updateTaxRule);
router.delete("/:id", deleteTaxRule);

export default router;
