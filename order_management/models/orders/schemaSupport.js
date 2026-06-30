// orders/schemaSupport.js
const db = require("../../config/db");

/* ======================= SCHEMA SUPPORT FLAGS ======================= */
let _hasStatusReason = null;
async function ensureStatusReasonSupport() {
  if (_hasStatusReason !== null) return _hasStatusReason;
  const [rows] = await db.query(`
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
async function ensureServiceTypeSupport() {
  if (_hasServiceType !== null) return _hasServiceType;
  const [rows] = await db.query(`
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

module.exports = {
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,
};
