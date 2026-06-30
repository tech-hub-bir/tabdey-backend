// models/orders/helpers.js
const db = require("../../config/db");

/* ======================= UTILS ======================= */
function generateOrderId() {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return `ORD-${n}`;
}

const fmtNu = (n) => Number(n || 0).toFixed(2);

/* ======================= SCHEMA SUPPORT FLAGS ======================= */
let _hasStatusReason = null;
async function ensureStatusReasonSupport(connOrDb = null) {
  if (_hasStatusReason !== null) return _hasStatusReason;

  const dbh = connOrDb || db;

  const [rows] = await dbh.query(`
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'status_reason'
     LIMIT 1
  `);

  _hasStatusReason = rows.length > 0;
  return _hasStatusReason;
}

let _hasServiceType = null;
async function ensureServiceTypeSupport(connOrDb = null) {
  if (_hasServiceType !== null) return _hasServiceType;

  const dbh = connOrDb || db;

  const [rows] = await dbh.query(`
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'service_type'
     LIMIT 1
  `);

  _hasServiceType = rows.length > 0;
  return _hasServiceType;
}

async function ensureDeliveryExtrasSupport(conn = null) {
  const dbh = conn || db;

  const [rows] = await dbh.query(
    `
    SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME IN (
        'delivery_lat','delivery_lng',
        'delivery_floor_unit','delivery_instruction_note',
        'delivery_special_mode','delivery_photo_url',
        'delivery_photo_urls',
        'delivery_status',
        'delivered_at',
        'delivery_batch_id','delivery_driver_id','delivery_ride_id'
       )
    `,
  );

  const set = new Set(rows.map((r) => r.COLUMN_NAME));
  return {
    hasLat: set.has("delivery_lat"),
    hasLng: set.has("delivery_lng"),
    hasFloor: set.has("delivery_floor_unit"),
    hasInstr: set.has("delivery_instruction_note"),
    hasMode: set.has("delivery_special_mode"),
    hasPhoto: set.has("delivery_photo_url"),
    hasPhotoList: set.has("delivery_photo_urls"),
    hasDeliveryStatus: set.has("delivery_status"),
    hasDeliveredAt: set.has("delivered_at"),
    hasBatchId: set.has("delivery_batch_id"),
    hasDriverId: set.has("delivery_driver_id"),
    hasRideId: set.has("delivery_ride_id"),
  };
}

/* ================= HTTP & ID SERVICE HELPERS ================= */
async function postJson(url, body = {}, timeout = 8000) {
  if (!url) throw new Error("Wallet ID service URL is missing in env.");
  try {
    const { data } = await require("axios").post(url, body, {
      timeout,
      headers: { "Content-Type": "application/json" },
    });
    return data;
  } catch (e) {
    const status = e?.response?.status;
    const resp = e?.response?.data;
    const respText =
      resp == null
        ? ""
        : typeof resp === "string"
          ? resp.slice(0, 300)
          : JSON.stringify(resp).slice(0, 300);

    throw new Error(
      `Wallet ID service POST failed: ${url} ${status ? `(HTTP ${status})` : ""} ${e?.message || ""} ${respText}`,
    );
  }
}

function extractIdsShape(payload) {
  const p = payload?.data ? payload.data : payload;

  let txn_ids = null;
  if (Array.isArray(p?.transaction_ids) && p.transaction_ids.length >= 2) {
    txn_ids = [String(p.transaction_ids[0]), String(p.transaction_ids[1])];
  } else if (Array.isArray(p?.txn_ids) && p.txn_ids.length >= 2) {
    txn_ids = [String(p.txn_ids[0]), String(p.txn_ids[1])];
  }

  const journal =
    p?.journal_id || p?.journal || p?.journal_code || p?.journalCode || null;

  return { txn_ids, journal_id: journal || null };
}

async function fetchTxnAndJournalIds({ IDS_BOTH_URL }, timeout = 8000) {
  const data = await postJson(IDS_BOTH_URL, {}, timeout);
  const { txn_ids, journal_id } = extractIdsShape(data);

  if (txn_ids && txn_ids.length >= 2) {
    return { dr_id: txn_ids[0], cr_id: txn_ids[1], journal_id };
  }

  throw new Error(
    `Wallet ID service returned unexpected payload: ${JSON.stringify(data).slice(0, 500)}`,
  );
}

// Prefetch transaction IDs OUTSIDE DB tx to avoid holding locks while doing HTTP
async function prefetchTxnIdsBatch(n, { IDS_BOTH_URL }, timeout = 8000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await fetchTxnAndJournalIds({ IDS_BOTH_URL }, timeout));
  }
  return out;
}

/* ================= SERVICE TYPE RESOLUTION ================= */
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
    const hasService = await ensureServiceTypeSupport(dbh);
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

/* ================= OTHER HELPERS ================= */
function parseDeliveryAddress(val) {
  if (val == null) return null;
  if (typeof val === "object") return val;

  const str = String(val || "").trim();
  if (!str) return null;

  try {
    const obj = JSON.parse(str);
    return {
      address: obj.address ?? obj.addr ?? "",
      lat: typeof obj.lat === "number" ? obj.lat : Number(obj.lat ?? NaN),
      lng: typeof obj.lng === "number" ? obj.lng : Number(obj.lng ?? NaN),
    };
  } catch {
    return { address: str, lat: null, lng: null };
  }
}

module.exports = {
  db,

  // utils
  generateOrderId,
  fmtNu,

  // schema helpers
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,

  // service type helpers
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,

  // misc
  parseDeliveryAddress,

  // wallet id helpers (optional)
  postJson,
  extractIdsShape,
  fetchTxnAndJournalIds,
  prefetchTxnIdsBatch,
};
