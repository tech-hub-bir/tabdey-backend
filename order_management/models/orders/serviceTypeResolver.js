// orders/serviceTypeResolver.js
const db = require("../../config/db");
const { ensureServiceTypeSupport } = require("./schemaSupport");

// Uses merchant_business_details.owner_type to derive FOOD/MART when orders.service_type is missing/null.
async function getOwnerTypeByBusinessId(business_id, conn = null) {
  const dbh = conn || db;
  const bid = Number(business_id);
  if (!Number.isFinite(bid) || bid <= 0) return null;

  const [rows] = await dbh.query(
    `SELECT owner_type
       FROM merchant_business_details
      WHERE business_id = ?
      LIMIT 1`,
    [bid],
  );

  const ot = rows[0]?.owner_type;
  if (!ot) return null;

  const norm = String(ot).trim().toUpperCase();
  if (norm === "FOOD" || norm === "MART") return norm;

  if (String(ot).toLowerCase().includes("mart")) return "MART";
  if (String(ot).toLowerCase().includes("food")) return "FOOD";
  return null;
}

async function resolveOrderServiceType(order_id, conn = null) {
  const dbh = conn || db;

  // If orders.service_type exists and filled, use it
  try {
    const hasService = await ensureServiceTypeSupport();
    if (hasService) {
      const [[row]] = await dbh.query(
        `SELECT service_type FROM orders WHERE order_id = ? LIMIT 1`,
        [order_id],
      );
      const st = row?.service_type
        ? String(row.service_type).trim().toUpperCase()
        : "";
      if (st === "FOOD" || st === "MART") return st;
    }
  } catch {}

  // Otherwise derive from primary business_id in order_items
  const [[primary]] = await dbh.query(
    `SELECT business_id
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC
      LIMIT 1`,
    [order_id],
  );

  const derived = primary?.business_id
    ? await getOwnerTypeByBusinessId(primary.business_id, dbh)
    : null;

  return derived || "FOOD";
}

module.exports = {
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,
};
