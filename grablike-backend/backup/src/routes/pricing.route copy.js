// src/routes/pricing.routes.js
import { Router } from "express";
import { computePlatformFeeAndGST } from "../services/pricing/rulesEngine.js";
import { getVehicleTypeByServiceName } from "../utils/getVehicleTypeUsingServiceTypeName.js";

const router = Router();

/* ---------------- helpers ---------------- */
const asStr = (v) => (v == null ? "" : String(v).trim());
const asInt = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
};
const asUpper = (v) => asStr(v).toUpperCase();
const asLower = (v) => asStr(v).toLowerCase();

function bad(res, message, extra = {}) {
  return res.status(400).json({ success: false, message, ...extra });
}

/**
 * POST /pricing/quote
 * body:
 * {
 *  "country_code":"BT",
 *  "city_id":"THIMPHU",         // can be string or number, your engine decides
 *  "service_type":"Taxi Reserved",
 *  "trip_type":"scheduled",     // instant | pool | scheduled
 *  "channel":"app",             // app | web | ...
 *  "subtotal_cents": 30000,
 *  "fare_after_discounts_cents": 28000,   // optional
 *  "driver_take_home_base_cents": 0,      // optional
 *  "at": "2026-01-07T10:30:00.000Z"       // optional datetime
 * }
 */
router.post("/quote", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Pricing quote request body:", body);

    const country_code = asUpper(body.country_code) || "BT";
    const city_id = asStr(body.city_id) || null; // keep as string to support THIMPHU or 1 etc.
    const service_type = asStr(body.service_type);
    const trip_type = asLower(body.trip_type) || "instant";
    const channel = asLower(body.channel) || "app";

    const subtotal_cents = asInt(body.subtotal_cents);
  
    const offer_code = asStr(body.offer_code) || null;

    const user_id = asStr(body.user_id) || null;

    const fare_after_discounts_cents =
      body.fare_after_discounts_cents === undefined
        ? undefined
        : asInt(body.fare_after_discounts_cents);

    const driver_take_home_base_cents =
      body.driver_take_home_base_cents === undefined
        ? undefined
        : asInt(body.driver_take_home_base_cents);

    const at = body.at ? asStr(body.at) : undefined;

    // ---- validations ----
    if (!service_type) return bad(res, "service_type is required");
    if (!subtotal_cents || subtotal_cents < 0)
      return bad(res, "subtotal_cents must be a positive integer (in cents)");

    if (!["instant", "pool", "scheduled"].includes(trip_type))
      return bad(res, "trip_type must be one of: instant, pool, scheduled");

    const vehicleType = await getVehicleTypeByServiceName(service_type);
    console.log("Service Type:", service_type, "Vehicle Type:", vehicleType);

    // engine call
    const out = await computePlatformFeeAndGST({
      country_code,
      city_id,
      service_type: vehicleType,
      trip_type,
      channel,
      subtotal_cents,
      offer_code,
      user_id,
      fare_after_discounts_cents,
      driver_take_home_base_cents,
      at, // optional datetime string
    });
    console.log("Pricing engine output:", out);

    // recommended: ensure the response ALWAYS contains these (engine should do it)
    return res.json({
      success: true,
      data: {
        country_code,
        city_id,
        service_type,
        trip_type,
        channel,
        ...out,
      },
    });
  } catch (e) {
    console.error("[pricing/quote]", e);

    // If your rules engine throws structured errors, map them here:
    // e.g. e.statusCode, e.code, e.message
    const msg = e?.message || "Pricing engine error";
    const status = e?.statusCode && Number.isFinite(e.statusCode) ? e.statusCode : 500;

    return res.status(status).json({
      success: false,
      message: msg,
    });
  }
});

export default router;
