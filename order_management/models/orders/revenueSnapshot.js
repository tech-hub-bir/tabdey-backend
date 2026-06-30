// orders/revenueSnapshot.js
const db = require("../../config/db");

async function insertMerchantEarningWithConn(
  conn,
  { business_id, order_id, total_amount, dateObj },
) {
  const [t] = await conn.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'merchant_earnings'
     LIMIT 1
    `,
  );
  if (!t.length) return;

  const [[exists]] = await conn.query(
    `SELECT 1 FROM merchant_earnings WHERE order_id = ? AND business_id = ? LIMIT 1`,
    [order_id, business_id],
  );
  if (exists) return;

  const amt = Number(total_amount || 0);
  const d = dateObj || new Date();

  await conn.query(
    `INSERT INTO merchant_earnings (business_id, \`date\`, total_amount, order_id)
     VALUES (?, ?, ?, ?)`,
    [business_id, d, amt, order_id],
  );
}

async function insertFoodMartRevenueWithConn(conn, row) {
  const [t] = await conn.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'food_mart_revenue'
     LIMIT 1
    `,
  );
  if (!t.length) return;

  const ownerType = String(row.owner_type || "FOOD")
    .trim()
    .toUpperCase();
  const source = String(row.source || "delivered")
    .trim()
    .toLowerCase();

  const sql = `
    INSERT INTO food_mart_revenue
    (
      order_id, user_id, business_id, owner_type, source,
      status, placed_at, payment_method,
      total_amount, platform_fee, revenue_earned, tax,
      customer_name, customer_phone, business_name,
      items_summary, total_quantity, details_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      user_id        = VALUES(user_id),
      business_id    = VALUES(business_id),
      owner_type     = VALUES(owner_type),
      source         = VALUES(source),
      status         = VALUES(status),
      placed_at      = VALUES(placed_at),
      payment_method = VALUES(payment_method),
      total_amount   = VALUES(total_amount),
      platform_fee   = VALUES(platform_fee),
      revenue_earned = VALUES(revenue_earned),
      tax            = VALUES(tax),
      customer_name  = VALUES(customer_name),
      customer_phone = VALUES(customer_phone),
      business_name  = VALUES(business_name),
      items_summary  = VALUES(items_summary),
      total_quantity = VALUES(total_quantity),
      details_json   = VALUES(details_json)
  `;

  await conn.query(sql, [
    String(row.order_id).trim(),
    Number(row.user_id),
    Number(row.business_id),
    ownerType,
    source,
    row.status || null,
    row.placed_at || null,
    row.payment_method || null,
    Number(row.total_amount || 0),
    Number(row.platform_fee || 0),
    Number(row.revenue_earned || 0),
    Number(row.tax || 0),
    row.customer_name || null,
    row.customer_phone || null,
    row.business_name || null,
    row.items_summary || null,
    Number(row.total_quantity || 0),
    row.details_json || null,
  ]);
}

function buildItemsSummary(items = []) {
  const byName = new Map();
  let totalQty = 0;

  for (const it of items || []) {
    const name = String(it.item_name || "").trim() || "Item";
    const q = Number(it.quantity || 0) || 0;
    totalQty += q;
    byName.set(name, (byName.get(name) || 0) + q);
  }

  const summary = Array.from(byName.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, qty]) => `${name} x${qty}`)
    .join(", ");

  return { summary, totalQty };
}

module.exports = {
  insertMerchantEarningWithConn,
  insertFoodMartRevenueWithConn,
  buildItemsSummary,
};
