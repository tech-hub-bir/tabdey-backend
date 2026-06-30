// // models/orderModels.js
// const db = require("../config/db");
// const axios = require("axios");

// /* ======================= CONFIG ======================= */
// const ADMIN_WALLET_ID = "TD00000001";
// const PLATFORM_USER_SHARE = 0.5;
// const PLATFORM_MERCHANT_SHARE = 0.5;

// const IDS_BOTH_URL = process.env.WALLET_IDS_BOTH_URL;

// /* ======================= UTILS ======================= */
// function generateOrderId() {
//   const n = Math.floor(10000000 + Math.random() * 90000000);
//   return `ORD-${n}`;
// }

// const fmtNu = (n) => Number(n || 0).toFixed(2);

// /* ======================= SCHEMA SUPPORT FLAGS ======================= */
// let _hasStatusReason = null;
// async function ensureStatusReasonSupport() {
//   if (_hasStatusReason !== null) return _hasStatusReason;
//   const [rows] = await db.query(`
//     SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = 'orders'
//        AND COLUMN_NAME = 'status_reason'
//      LIMIT 1
//   `);
//   _hasStatusReason = rows.length > 0;
//   return _hasStatusReason;
// }

// let _hasServiceType = null;
// async function ensureServiceTypeSupport() {
//   if (_hasServiceType !== null) return _hasServiceType;
//   const [rows] = await db.query(`
//     SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = 'orders'
//        AND COLUMN_NAME = 'service_type'
//      LIMIT 1
//   `);
//   _hasServiceType = rows.length > 0;
//   return _hasServiceType;
// }

// async function ensureDeliveryExtrasSupport(conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT COLUMN_NAME
//       FROM INFORMATION_SCHEMA.COLUMNS
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = 'orders'
//        AND COLUMN_NAME IN (
//         'delivery_lat','delivery_lng',
//         'delivery_floor_unit','delivery_instruction_note',
//         'delivery_special_mode','delivery_photo_url',
//         'delivery_photo_urls',
//         'delivery_status',
//         'delivered_at',
//         'delivery_batch_id','delivery_driver_id','delivery_ride_id'
//        )
//     `,
//   );

//   const set = new Set(rows.map((r) => r.COLUMN_NAME));
//   return {
//     hasLat: set.has("delivery_lat"),
//     hasLng: set.has("delivery_lng"),
//     hasFloor: set.has("delivery_floor_unit"),
//     hasInstr: set.has("delivery_instruction_note"),
//     hasMode: set.has("delivery_special_mode"),
//     hasPhoto: set.has("delivery_photo_url"),
//     hasPhotoList: set.has("delivery_photo_urls"),
//     hasDeliveryStatus: set.has("delivery_status"),
//     hasDeliveredAt: set.has("delivered_at"),
//     hasBatchId: set.has("delivery_batch_id"),
//     hasDriverId: set.has("delivery_driver_id"),
//     hasRideId: set.has("delivery_ride_id"),
//   };
// }

// /* ================= HTTP & ID SERVICE HELPERS ================= */
// async function postJson(url, body = {}, timeout = 8000) {
//   if (!url) throw new Error("Wallet ID service URL is missing in env.");
//   try {
//     const { data } = await axios.post(url, body, {
//       timeout,
//       headers: { "Content-Type": "application/json" },
//     });
//     return data;
//   } catch (e) {
//     const status = e?.response?.status;
//     const resp = e?.response?.data;
//     const respText =
//       resp == null
//         ? ""
//         : typeof resp === "string"
//           ? resp.slice(0, 300)
//           : JSON.stringify(resp).slice(0, 300);

//     throw new Error(
//       `Wallet ID service POST failed: ${url} ${status ? `(HTTP ${status})` : ""} ${e?.message || ""} ${respText}`,
//     );
//   }
// }

// function extractIdsShape(payload) {
//   const p = payload?.data ? payload.data : payload;

//   let txn_ids = null;
//   if (Array.isArray(p?.transaction_ids) && p.transaction_ids.length >= 2) {
//     txn_ids = [String(p.transaction_ids[0]), String(p.transaction_ids[1])];
//   } else if (Array.isArray(p?.txn_ids) && p.txn_ids.length >= 2) {
//     txn_ids = [String(p.txn_ids[0]), String(p.txn_ids[1])];
//   }

//   const journal =
//     p?.journal_id || p?.journal || p?.journal_code || p?.journalCode || null;

//   return { txn_ids, journal_id: journal || null };
// }

// async function fetchTxnAndJournalIds() {
//   const data = await postJson(IDS_BOTH_URL, {});
//   const { txn_ids, journal_id } = extractIdsShape(data);

//   if (txn_ids && txn_ids.length >= 2) {
//     return { dr_id: txn_ids[0], cr_id: txn_ids[1], journal_id };
//   }

//   throw new Error(
//     `Wallet ID service returned unexpected payload: ${JSON.stringify(data).slice(0, 500)}`,
//   );
// }

// // Prefetch transaction IDs OUTSIDE DB tx to avoid holding locks while doing HTTP
// async function prefetchTxnIdsBatch(n) {
//   const out = [];
//   for (let i = 0; i < n; i++) out.push(await fetchTxnAndJournalIds());
//   return out;
// }

// /* ================= WALLET LOOKUPS ================= */
// async function getBuyerWalletByUserId(user_id, conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `SELECT id, wallet_id, user_id, amount, status
//        FROM wallets
//       WHERE user_id = ?
//       LIMIT 1`,
//     [user_id],
//   );
//   return rows[0] || null;
// }

// async function getAdminWallet(conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `SELECT id, wallet_id, user_id, amount, status
//        FROM wallets
//       WHERE wallet_id = ?
//       LIMIT 1`,
//     [ADMIN_WALLET_ID],
//   );
//   return rows[0] || null;
// }

// async function getMerchantWalletByBusinessId(business_id, conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT w.id, w.wallet_id, w.user_id, w.amount, w.status
//       FROM merchant_business_details m
//       JOIN wallets w ON w.user_id = m.user_id
//      WHERE m.business_id = ?
//      LIMIT 1
//     `,
//     [business_id],
//   );
//   return rows[0] || null;
// }

// /* ================= SERVICE TYPE RESOLUTION ================= */
// // Uses merchant_business_details.owner_type to derive FOOD/MART when orders.service_type is missing/null.
// async function getOwnerTypeByBusinessId(business_id, conn = null) {
//   const dbh = conn || db;
//   const bid = Number(business_id);
//   if (!Number.isFinite(bid) || bid <= 0) return null;

//   const [rows] = await dbh.query(
//     `SELECT owner_type
//        FROM merchant_business_details
//       WHERE business_id = ?
//       LIMIT 1`,
//     [bid],
//   );

//   const ot = rows[0]?.owner_type;
//   if (!ot) return null;

//   const norm = String(ot).trim().toUpperCase();
//   if (norm === "FOOD" || norm === "MART") return norm;

//   if (String(ot).toLowerCase().includes("mart")) return "MART";
//   if (String(ot).toLowerCase().includes("food")) return "FOOD";
//   return null;
// }

// async function resolveOrderServiceType(order_id, conn = null) {
//   const dbh = conn || db;

//   // If orders.service_type exists and filled, use it
//   try {
//     const hasService = await ensureServiceTypeSupport();
//     if (hasService) {
//       const [[row]] = await dbh.query(
//         `SELECT service_type FROM orders WHERE order_id = ? LIMIT 1`,
//         [order_id],
//       );
//       const st = row?.service_type
//         ? String(row.service_type).trim().toUpperCase()
//         : "";
//       if (st === "FOOD" || st === "MART") return st;
//     }
//   } catch {}

//   // Otherwise derive from primary business_id in order_items
//   const [[primary]] = await dbh.query(
//     `SELECT business_id
//        FROM order_items
//       WHERE order_id = ?
//       ORDER BY menu_id ASC
//       LIMIT 1`,
//     [order_id],
//   );

//   const derived = primary?.business_id
//     ? await getOwnerTypeByBusinessId(primary.business_id, dbh)
//     : null;

//   return derived || "FOOD";
// }

// /* ================= USER NOTIFICATIONS ================= */
// async function insertUserNotification(
//   conn,
//   { user_id, title, message, type = "wallet", data = null, status = "unread" },
// ) {
//   await conn.query(
//     `INSERT INTO notifications (user_id, type, title, message, data, status, created_at)
//      VALUES (?, ?, ?, ?, ?, ?, NOW())`,
//     [
//       user_id,
//       type,
//       title,
//       message,
//       data ? JSON.stringify(data) : null,
//       status === "read" ? "read" : "unread",
//     ],
//   );
// }

// function humanOrderStatus(status) {
//   const s = String(status || "").toUpperCase();
//   switch (s) {
//     case "PENDING":
//       return "pending";
//     case "CONFIRMED":
//       return "accepted by the store";
//     case "PREPARING":
//       return "being prepared";
//     case "READY":
//       return "ready for pickup";
//     case "OUT_FOR_DELIVERY":
//       return "out for delivery";
//     case "DELIVERED":
//     case "COMPLETED":
//       return "delivered";
//     case "CANCELLED":
//       return "cancelled";
//     case "DECLINED":
//       return "declined by the store";
//     default:
//       return s.toLowerCase();
//   }
// }

// async function addUserOrderStatusNotificationInternal(
//   user_id,
//   order_id,
//   status,
//   reason = "",
//   conn = null,
// ) {
//   const dbh = conn || db;
//   let normalized = String(status || "").toUpperCase();
//   if (normalized === "COMPLETED") normalized = "DELIVERED";

//   const trimmedReason = String(reason || "").trim();

//   let message;
//   if (normalized === "CONFIRMED") {
//     message = `Your order ${order_id} is accepted successfully.`;
//   } else {
//     const nice = humanOrderStatus(normalized);
//     message = `Your order ${order_id} is now ${nice}.`;
//   }

//   if (trimmedReason) message += ` Reason: ${trimmedReason}`;

//   await insertUserNotification(dbh, {
//     user_id,
//     type: "order_status",
//     title: "Order update",
//     message,
//     data: { order_id, status: normalized, reason: trimmedReason || null },
//     status: "unread",
//   });
// }

// async function addUserUnavailableItemNotificationInternal(
//   user_id,
//   order_id,
//   changes,
//   final_total_amount = null,
//   conn = null,
// ) {
//   const dbh = conn || db;
//   const removed = Array.isArray(changes?.removed) ? changes.removed : [];
//   const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];

//   const lines = [];

//   if (removed.length) {
//     const names = removed
//       .map((x) => x.item_name || x.menu_id)
//       .filter(Boolean)
//       .join(", ");
//     lines.push(
//       names
//         ? `Removed items: ${names}.`
//         : `Some unavailable items were removed from your order.`,
//     );
//   }

//   if (replaced.length) {
//     const names = replaced
//       .map((x) => x.new?.item_name || x.old?.item_name || x.old?.menu_id)
//       .filter(Boolean)
//       .join(", ");
//     lines.push(
//       names
//         ? `Replaced items: ${names}.`
//         : `Some unavailable items were replaced with alternatives.`,
//     );
//   }

//   if (!lines.length) return;

//   if (final_total_amount != null) {
//     lines.push(
//       `Your final payable amount for this order is Nu. ${fmtNu(final_total_amount)}.`,
//     );
//   }

//   await insertUserNotification(dbh, {
//     user_id,
//     type: "order_unavailable_items",
//     title: `Items updated in order ${order_id}`,
//     message: lines.join(" "),
//     data: {
//       order_id,
//       changes: { removed, replaced },
//       final_total_amount:
//         final_total_amount != null ? Number(final_total_amount) : null,
//     },
//     status: "unread",
//   });
// }

// async function addUserWalletDebitNotificationInternal(
//   user_id,
//   order_id,
//   order_amount,
//   platform_fee,
//   method,
//   conn = null,
// ) {
//   const dbh = conn || db;
//   const payMethod = String(method || "").toUpperCase();
//   const orderAmt = Number(order_amount || 0);
//   const feeAmt = Number(platform_fee || 0);

//   if (!(orderAmt > 0 || feeAmt > 0)) return;

//   let message;
//   if (payMethod === "WALLET") {
//     message =
//       `Your order ${order_id} is accepted successfully. ` +
//       `Nu. ${fmtNu(orderAmt)} has been deducted from your wallet for the order and ` +
//       `Nu. ${fmtNu(feeAmt)} as platform fee (your share).`;
//   } else {
//     message = `Order ${order_id}: Nu. ${fmtNu(feeAmt)} was deducted from your wallet as platform fee (your share).`;
//   }

//   await insertUserNotification(dbh, {
//     user_id,
//     type: "wallet_debit",
//     title: "Wallet deduction",
//     message,
//     data: {
//       order_id,
//       order_amount: orderAmt,
//       platform_fee: feeAmt,
//       method: payMethod,
//     },
//     status: "unread",
//   });
// }

// /* ================= POINT SYSTEM HELPERS ================= */
// async function getActivePointRule(conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT point_id, min_amount_per_point, point_to_award, is_active
//       FROM point_system
//      WHERE is_active = 1
//      ORDER BY created_at DESC
//      LIMIT 1
//     `,
//   );
//   return rows[0] || null;
// }

// async function hasPointsAwardNotification(order_id, conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT id
//       FROM notifications
//      WHERE type = 'points_awarded'
//        AND JSON_EXTRACT(data, '$.order_id') = ?
//      LIMIT 1
//     `,
//     [order_id],
//   );
//   return rows.length > 0;
// }

// async function awardPointsForCompletedOrder(order_id) {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     const [[order]] = await conn.query(
//       `SELECT user_id, total_amount, status
//          FROM orders
//         WHERE order_id = ?
//         LIMIT 1`,
//       [order_id],
//     );

//     if (!order) {
//       await conn.rollback();
//       return { awarded: false, reason: "order_not_found" };
//     }

//     let status = String(order.status || "").toUpperCase();
//     if (status === "COMPLETED") status = "DELIVERED";
//     if (status !== "DELIVERED") {
//       await conn.rollback();
//       return { awarded: false, reason: "not_delivered" };
//     }

//     if (await hasPointsAwardNotification(order_id, conn)) {
//       await conn.rollback();
//       return { awarded: false, reason: "already_awarded" };
//     }

//     const rule = await getActivePointRule(conn);
//     if (!rule) {
//       await conn.rollback();
//       return { awarded: false, reason: "no_active_rule" };
//     }

//     const totalAmount = Number(order.total_amount || 0);
//     const minAmount = Number(rule.min_amount_per_point || 0);
//     const perPoint = Number(rule.point_to_award || 0);

//     if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
//       await conn.rollback();
//       return { awarded: false, reason: "invalid_rule_or_amount" };
//     }

//     const units = Math.floor(totalAmount / minAmount);
//     const points = units * perPoint;
//     if (points <= 0) {
//       await conn.rollback();
//       return { awarded: false, reason: "computed_zero" };
//     }

//     await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
//       points,
//       order.user_id,
//     ]);

//     const msg = `You earned ${points} points for order ${order_id} (Nu. ${fmtNu(totalAmount)} spent).`;

//     await insertUserNotification(conn, {
//       user_id: order.user_id,
//       type: "points_awarded",
//       title: "Points earned",
//       message: msg,
//       data: {
//         order_id,
//         points_awarded: points,
//         total_amount: totalAmount,
//         min_amount_per_point: Number(minAmount),
//         point_to_award: Number(perPoint),
//         rule_id: rule.point_id,
//       },
//       status: "unread",
//     });

//     await conn.commit();
//     return {
//       awarded: true,
//       points_awarded: points,
//       total_amount: totalAmount,
//       rule_id: rule.point_id,
//     };
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// async function awardPointsForCompletedOrderWithConn(conn, order_id) {
//   const [[order]] = await conn.query(
//     `SELECT user_id, total_amount, status
//        FROM orders
//       WHERE order_id = ?
//       LIMIT 1`,
//     [order_id],
//   );
//   if (!order) return { awarded: false, reason: "order_not_found" };

//   let status = String(order.status || "").toUpperCase();
//   if (status === "COMPLETED") status = "DELIVERED";
//   if (status !== "DELIVERED")
//     return { awarded: false, reason: "not_delivered" };

//   if (await hasPointsAwardNotification(order_id, conn))
//     return { awarded: false, reason: "already_awarded" };

//   const rule = await getActivePointRule(conn);
//   if (!rule) return { awarded: false, reason: "no_active_rule" };

//   const totalAmount = Number(order.total_amount || 0);
//   const minAmount = Number(rule.min_amount_per_point || 0);
//   const perPoint = Number(rule.point_to_award || 0);

//   if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
//     return { awarded: false, reason: "invalid_rule_or_amount" };
//   }

//   const units = Math.floor(totalAmount / minAmount);
//   const points = units * perPoint;
//   if (points <= 0) return { awarded: false, reason: "computed_zero" };

//   await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
//     points,
//     order.user_id,
//   ]);

//   const msg = `You earned ${points} points for order ${order_id} (Nu. ${fmtNu(totalAmount)} spent).`;

//   await insertUserNotification(conn, {
//     user_id: order.user_id,
//     type: "points_awarded",
//     title: "Points earned",
//     message: msg,
//     data: {
//       order_id,
//       points_awarded: points,
//       total_amount: totalAmount,
//       min_amount_per_point: Number(minAmount),
//       point_to_award: Number(perPoint),
//       rule_id: rule.point_id,
//     },
//     status: "unread",
//   });

//   return {
//     awarded: true,
//     points_awarded: points,
//     total_amount: totalAmount,
//     rule_id: rule.point_id,
//   };
// }

// /* ================= OTHER HELPERS ================= */
// function parseDeliveryAddress(val) {
//   if (val == null) return null;
//   if (typeof val === "object") return val;
//   const str = String(val || "").trim();
//   if (!str) return null;
//   try {
//     const obj = JSON.parse(str);
//     return {
//       address: obj.address ?? obj.addr ?? "",
//       lat: typeof obj.lat === "number" ? obj.lat : Number(obj.lat ?? NaN),
//       lng: typeof obj.lng === "number" ? obj.lng : Number(obj.lng ?? NaN),
//     };
//   } catch {
//     return { address: str, lat: null, lng: null };
//   }
// }

// /* ================= CAPTURE HELPERS ================= */
// async function captureExists(order_id, capture_type, conn = null) {
//   const dbh = conn || db;
//   const [[row]] = await dbh.query(
//     `SELECT order_id
//        FROM order_wallet_captures
//       WHERE order_id = ? AND capture_type = ?
//       LIMIT 1`,
//     [order_id, capture_type],
//   );
//   return !!row;
// }

// async function computeBusinessSplit(order_id, conn = null) {
//   const dbh = conn || db;

//   const [[order]] = await dbh.query(
//     `SELECT order_id, total_amount, platform_fee, delivery_fee, merchant_delivery_fee
//        FROM orders
//       WHERE order_id = ?
//       LIMIT 1`,
//     [order_id],
//   );
//   if (!order) throw new Error("Order not found while computing split");

//   const [items] = await dbh.query(
//     `SELECT business_id, subtotal
//        FROM order_items
//       WHERE order_id = ?
//       ORDER BY menu_id ASC`,
//     [order_id],
//   );
//   if (!items.length) throw new Error("Order has no items");

//   const byBiz = new Map();
//   for (const it of items) {
//     const part = Number(it.subtotal || 0);
//     byBiz.set(it.business_id, (byBiz.get(it.business_id) || 0) + part);
//   }

//   const subtotalTotal = Array.from(byBiz.values()).reduce((s, v) => s + v, 0);
//   const deliveryTotal = Number(order.delivery_fee || 0);
//   const feeTotal = Number(order.platform_fee || 0);
//   const primaryBizId = items[0].business_id;

//   const primarySub = byBiz.get(primaryBizId) || 0;
//   const primaryDelivery =
//     subtotalTotal > 0
//       ? deliveryTotal * (primarySub / subtotalTotal)
//       : deliveryTotal;

//   const baseTotal = subtotalTotal + deliveryTotal;
//   const primaryBase = primarySub + primaryDelivery;

//   if (byBiz.size === 1) {
//     return {
//       business_id: primaryBizId,
//       total_amount: Number(primaryBase.toFixed(2)),
//       platform_fee: feeTotal,
//       net_to_merchant: Number((primaryBase - feeTotal).toFixed(2)),
//     };
//   }

//   const primaryFeeShare =
//     baseTotal > 0 ? feeTotal * (primaryBase / baseTotal) : 0;

//   return {
//     business_id: primaryBizId,
//     total_amount: Number(primaryBase.toFixed(2)),
//     platform_fee: Number(primaryFeeShare.toFixed(2)),
//     net_to_merchant: Number((primaryBase - primaryFeeShare).toFixed(2)),
//   };
// }

// async function recordWalletTransfer(
//   conn,
//   { fromId, toId, amount, order_id, note = null },
// ) {
//   const amt = Number(amount || 0);
//   if (!(amt > 0)) return null;

//   const [dr] = await conn.query(
//     `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
//     [amt, fromId, amt],
//   );
//   if (!dr.affectedRows)
//     throw new Error(`Insufficient funds or missing wallet: ${fromId}`);

//   await conn.query(
//     `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
//     [amt, toId],
//   );

//   const { dr_id, cr_id, journal_id } = await fetchTxnAndJournalIds();

//   await conn.query(
//     `INSERT INTO wallet_transactions
//        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
//      VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
//     [dr_id, journal_id || null, fromId, toId, amt, note],
//   );

//   await conn.query(
//     `INSERT INTO wallet_transactions
//        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
//      VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
//     [cr_id, journal_id || null, fromId, toId, amt, note],
//   );

//   return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id: journal_id || null };
// }

// // Same as recordWalletTransfer but uses prefetched ids (NO HTTP inside DB tx)
// async function recordWalletTransferWithIds(
//   conn,
//   { fromId, toId, amount, order_id, note = null, ids },
// ) {
//   const amt = Number(amount || 0);
//   if (!(amt > 0)) return null;

//   const [dr] = await conn.query(
//     `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
//     [amt, fromId, amt],
//   );
//   if (!dr.affectedRows)
//     throw new Error(`Insufficient funds or missing wallet: ${fromId}`);

//   await conn.query(
//     `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
//     [amt, toId],
//   );

//   const { dr_id, cr_id, journal_id } = ids || {};
//   if (!dr_id || !cr_id)
//     throw new Error("Prefetched transaction ids missing (dr_id/cr_id).");

//   await conn.query(
//     `INSERT INTO wallet_transactions
//        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
//      VALUES (?, ?, ?, ?, ?, 'DR', ?, NOW(), NOW())`,
//     [dr_id, journal_id || null, fromId, toId, amt, note],
//   );

//   await conn.query(
//     `INSERT INTO wallet_transactions
//        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
//      VALUES (?, ?, ?, ?, ?, 'CR', ?, NOW(), NOW())`,
//     [cr_id, journal_id || null, fromId, toId, amt, note],
//   );

//   return { dr_txn_id: dr_id, cr_txn_id: cr_id, journal_id: journal_id || null };
// }

// /* ================= PUBLIC CAPTURE APIS (standalone) ================= */
// async function captureOrderFunds(order_id) {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     if (await captureExists(order_id, "WALLET_FULL", conn)) {
//       await conn.commit();
//       return { captured: false, alreadyCaptured: true };
//     }

//     const [[order]] = await conn.query(
//       `SELECT user_id, total_amount, platform_fee, payment_method
//          FROM orders
//         WHERE order_id = ?
//         LIMIT 1`,
//       [order_id],
//     );
//     if (!order) throw new Error("Order not found for capture");

//     const pm = String(order.payment_method || "WALLET").toUpperCase();
//     if (pm !== "WALLET") {
//       await conn.commit();
//       return {
//         captured: false,
//         skipped: true,
//         reason: "payment_method != WALLET",
//       };
//     }

//     const split = await computeBusinessSplit(order_id, conn);

//     const buyer = await getBuyerWalletByUserId(order.user_id, conn);
//     const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
//     const admin = await getAdminWallet(conn);

//     if (!buyer) throw new Error("Buyer wallet missing");
//     if (!merch) throw new Error("Merchant wallet missing");
//     if (!admin) throw new Error("Admin wallet missing");

//     const baseToMerchant = Number(split.total_amount || 0);
//     const feeForPrimary = Number(split.platform_fee || 0);

//     const userFee =
//       feeForPrimary > 0
//         ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
//         : 0;
//     const merchFee = Number((feeForPrimary - userFee).toFixed(2));

//     const needFromBuyer = baseToMerchant + userFee;

//     const [[freshBuyer]] = await conn.query(
//       `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//       [buyer.id],
//     );
//     if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
//       throw new Error("Insufficient wallet balance during capture");
//     }

//     if (merchFee > 0) {
//       const [[freshMerch]] = await conn.query(
//         `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//         [merch.id],
//       );
//       if (!freshMerch || Number(freshMerch.amount) < merchFee) {
//         throw new Error(
//           "Insufficient merchant wallet balance for platform fee share.",
//         );
//       }
//     }

//     const tOrder = await recordWalletTransfer(conn, {
//       fromId: buyer.wallet_id,
//       toId: merch.wallet_id,
//       amount: baseToMerchant,
//       order_id,
//       note: `Order base (items+delivery) for ${order_id}`,
//     });

//     let tUserFee = null;
//     if (userFee > 0) {
//       tUserFee = await recordWalletTransfer(conn, {
//         fromId: buyer.wallet_id,
//         toId: admin.wallet_id,
//         amount: userFee,
//         order_id,
//         note: `Platform fee (user 50%) for return ${order_id}`,
//       });
//     }

//     let tMerchFee = null;
//     if (merchFee > 0) {
//       tMerchFee = await recordWalletTransfer(conn, {
//         fromId: merch.wallet_id,
//         toId: admin.wallet_id,
//         amount: merchFee,
//         order_id,
//         note: `Platform fee (merchant 50%) for ${order_id}`,
//       });
//     }

//     await conn.query(
//       `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
//        VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
//       [
//         order_id,
//         tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null, // buyer fee pair
//         tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null, // merchant fee pair
//         tOrder ? `${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null, // buyer->merchant pair
//       ],
//     );

//     // ✅ balances AFTER capture (for notifications)
//     const [[b2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//       buyer.id,
//     ]);
//     const [[m2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//       merch.id,
//     ]);
//     const [[a2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//       admin.id,
//     ]);

//     await conn.commit();

//     return {
//       captured: true,
//       payment_method: "WALLET",
//       order_id,
//       user_id: Number(order.user_id),
//       business_id: Number(split.business_id),

//       order_amount: baseToMerchant,
//       platform_fee_user: userFee,
//       platform_fee_merchant: merchFee,
//       merchant_net_amount: Number((baseToMerchant - merchFee).toFixed(2)),

//       buyer_wallet_id: buyer.wallet_id,
//       merchant_wallet_id: merch.wallet_id,
//       admin_wallet_id: admin.wallet_id,

//       buyer_balance_after: b2 ? Number(b2.amount) : null,
//       merchant_balance_after: m2 ? Number(m2.amount) : null,
//       admin_balance_after: a2 ? Number(a2.amount) : null,

//       transfers: {
//         order: tOrder || null, // {dr_txn_id, cr_txn_id, journal_id}
//         user_fee: tUserFee || null, // {dr_txn_id, cr_txn_id, journal_id}
//         merchant_fee: tMerchFee || null, // {dr_txn_id, cr_txn_id, journal_id}
//       },
//     };
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// async function captureOrderCODFee(order_id) {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     if (await captureExists(order_id, "COD_FEE", conn)) {
//       await conn.commit();
//       return { captured: false, alreadyCaptured: true };
//     }

//     const [[order]] = await conn.query(
//       `SELECT user_id, platform_fee, payment_method
//          FROM orders
//         WHERE order_id = ?
//         LIMIT 1`,
//       [order_id],
//     );
//     if (!order) throw new Error("Order not found for COD fee capture");

//     if (String(order.payment_method || "").toUpperCase() !== "COD") {
//       await conn.commit();
//       return {
//         captured: false,
//         skipped: true,
//         reason: "payment_method != COD",
//       };
//     }

//     const split = await computeBusinessSplit(order_id, conn);
//     const feeForPrimary = Number(split.platform_fee || 0);

//     const userFee =
//       feeForPrimary > 0
//         ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
//         : 0;
//     const merchantFee = Number((feeForPrimary - userFee).toFixed(2));

//     const buyer = await getBuyerWalletByUserId(order.user_id, conn);
//     const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
//     const admin = await getAdminWallet(conn);

//     if (!buyer) throw new Error("Buyer wallet missing");
//     if (!merch) throw new Error("Merchant wallet missing");
//     if (!admin) throw new Error("Admin wallet missing");

//     if (feeForPrimary > 0) {
//       if (userFee > 0) {
//         const [[freshBuyer]] = await conn.query(
//           `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//           [buyer.id],
//         );
//         if (!freshBuyer || Number(freshBuyer.amount) < userFee) {
//           throw new Error(
//             "Insufficient user wallet balance for COD platform fee share.",
//           );
//         }
//       }

//       if (merchantFee > 0) {
//         const [[freshMerchant]] = await conn.query(
//           `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//           [merch.id],
//         );
//         if (!freshMerchant || Number(freshMerchant.amount) < merchantFee) {
//           throw new Error(
//             "Insufficient merchant wallet balance for COD platform fee share.",
//           );
//         }
//       }

//       let tUserFee = null;
//       let tMerchFee = null;

//       if (userFee > 0) {
//         tUserFee = await recordWalletTransfer(conn, {
//           fromId: buyer.wallet_id,
//           toId: admin.wallet_id,
//           amount: userFee,
//           order_id,
//           note: `COD platform fee (user 50%) for ${order_id}`,
//         });
//       }

//       if (merchantFee > 0) {
//         tMerchFee = await recordWalletTransfer(conn, {
//           fromId: merch.wallet_id,
//           toId: admin.wallet_id,
//           amount: merchantFee,
//           order_id,
//           note: `COD platform fee (merchant 50%) for ${order_id}`,
//         });
//       }

//       const buyerPair = tUserFee
//         ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
//         : null;
//       const merchPair = tMerchFee
//         ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
//         : null;

//       const adminRef =
//         (tUserFee?.journal_id ? String(tUserFee.journal_id) : null) ||
//         (tMerchFee?.journal_id ? String(tMerchFee.journal_id) : null) ||
//         null;

//       await conn.query(
//         `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
//          VALUES (?, 'COD_FEE', ?, ?, ?)`,
//         [order_id, buyerPair, merchPair, adminRef],
//       );
//     } else {
//       await conn.query(
//         `INSERT INTO order_wallet_captures (order_id, capture_type, admin_txn_id)
//          VALUES (?, 'COD_FEE', NULL)`,
//         [order_id],
//       );
//     }

//     await conn.commit();
//     return {
//       captured: true,
//       user_id: order.user_id,
//       order_amount: 0,
//       platform_fee_user: userFee,
//     };
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// /* ================= Atomic CAPTURE inside existing transaction ================= */
// async function captureOrderFundsWithConn(conn, order_id, prefetchedIds = []) {
//   if (await captureExists(order_id, "WALLET_FULL", conn)) {
//     return { captured: false, alreadyCaptured: true, payment_method: "WALLET" };
//   }

//   const [[order]] = await conn.query(
//     `SELECT user_id, payment_method
//        FROM orders
//       WHERE order_id = ?
//       LIMIT 1`,
//     [order_id],
//   );
//   if (!order) throw new Error("Order not found for capture");

//   const pm = String(order.payment_method || "").toUpperCase();
//   if (pm !== "WALLET") {
//     return { captured: false, skipped: true, payment_method: pm || "WALLET" };
//   }

//   const split = await computeBusinessSplit(order_id, conn);
//   const baseToMerchant = Number(split.total_amount || 0);
//   const feeForPrimary = Number(split.platform_fee || 0);

//   const userFee =
//     feeForPrimary > 0
//       ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
//       : 0;
//   const merchFee = Number((feeForPrimary - userFee).toFixed(2));
//   const needFromBuyer = baseToMerchant + userFee;

//   const buyer = await getBuyerWalletByUserId(order.user_id, conn);
//   const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
//   const admin = await getAdminWallet(conn);

//   if (!buyer) throw new Error("Buyer wallet missing");
//   if (!merch) throw new Error("Merchant wallet missing");
//   if (!admin) throw new Error("Admin wallet missing");

//   const [[freshBuyer]] = await conn.query(
//     `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//     [buyer.id],
//   );
//   if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
//     throw new Error("Insufficient wallet balance during capture");
//   }

//   if (merchFee > 0) {
//     const [[freshMerch]] = await conn.query(
//       `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//       [merch.id],
//     );
//     if (!freshMerch || Number(freshMerch.amount) < merchFee) {
//       throw new Error(
//         "Insufficient merchant wallet balance for platform fee share.",
//       );
//     }
//   }

//   // ✅ ids expected: 0=order, 1=user fee (optional), 2=merchant fee (optional)
//   const ids0 = prefetchedIds?.[0];
//   const ids1 = prefetchedIds?.[1];
//   const ids2 = prefetchedIds?.[2];
//   if (!ids0 || (userFee > 0 && !ids1) || (merchFee > 0 && !ids2)) {
//     throw new Error(
//       "Prefetched transaction ids are missing for WALLET capture",
//     );
//   }

//   const tOrder = await recordWalletTransferWithIds(conn, {
//     fromId: buyer.wallet_id,
//     toId: merch.wallet_id,
//     amount: baseToMerchant,
//     order_id,
//     note: `Order base (items+delivery) for ${order_id}`,
//     ids: ids0,
//   });

//   let tUserFee = null;
//   if (userFee > 0) {
//     tUserFee = await recordWalletTransferWithIds(conn, {
//       fromId: buyer.wallet_id,
//       toId: admin.wallet_id,
//       amount: userFee,
//       order_id,
//       note: `Platform fee (user 50%) for ${order_id}`,
//       ids: ids1,
//     });
//   }

//   let tMerchFee = null;
//   if (merchFee > 0) {
//     tMerchFee = await recordWalletTransferWithIds(conn, {
//       fromId: merch.wallet_id,
//       toId: admin.wallet_id,
//       amount: merchFee,
//       order_id,
//       note: `Platform fee (merchant 50%) for ${order_id}`,
//       ids: ids2,
//     });
//   }

//   await conn.query(
//     `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
//      VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
//     [
//       order_id,
//       tUserFee ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}` : null,
//       tMerchFee ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}` : null,
//       tOrder ? `${tOrder.dr_txn_id}/${tOrder.cr_txn_id}` : null,
//     ],
//   );

//   // ✅ balances AFTER capture (still inside same transaction)
//   const [[b2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//     buyer.id,
//   ]);
//   const [[m2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//     merch.id,
//   ]);
//   const [[a2]] = await conn.query(`SELECT amount FROM wallets WHERE id = ?`, [
//     admin.id,
//   ]);

//   return {
//     captured: true,
//     payment_method: "WALLET",
//     order_id,
//     user_id: Number(order.user_id),
//     business_id: Number(split.business_id),

//     order_amount: baseToMerchant,
//     platform_fee_user: userFee,
//     platform_fee_merchant: merchFee,
//     merchant_net_amount: Number((baseToMerchant - merchFee).toFixed(2)),

//     buyer_wallet_id: buyer.wallet_id,
//     merchant_wallet_id: merch.wallet_id,
//     admin_wallet_id: admin.wallet_id,

//     buyer_balance_after: b2 ? Number(b2.amount) : null,
//     merchant_balance_after: m2 ? Number(m2.amount) : null,
//     admin_balance_after: a2 ? Number(a2.amount) : null,

//     transfers: {
//       order: tOrder || null,
//       user_fee: tUserFee || null,
//       merchant_fee: tMerchFee || null,
//     },
//   };
// }

// async function captureOrderCODFeeWithConn(conn, order_id, prefetchedIds = []) {
//   if (await captureExists(order_id, "COD_FEE", conn)) {
//     return { captured: false, alreadyCaptured: true, payment_method: "COD" };
//   }

//   const [[order]] = await conn.query(
//     `SELECT user_id, payment_method
//        FROM orders
//       WHERE order_id = ?
//       LIMIT 1`,
//     [order_id],
//   );
//   if (!order) throw new Error("Order not found for COD fee capture");

//   if (String(order.payment_method || "").toUpperCase() !== "COD") {
//     return { captured: false, skipped: true, payment_method: "COD" };
//   }

//   const split = await computeBusinessSplit(order_id, conn);
//   const baseToMerchant = Number(split.total_amount || 0);
//   const feeForPrimary = Number(split.platform_fee || 0);

//   const userFee =
//     feeForPrimary > 0
//       ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
//       : 0;
//   const merchFee = Number((feeForPrimary - userFee).toFixed(2));

//   const buyer = await getBuyerWalletByUserId(order.user_id, conn);
//   const merch = await getMerchantWalletByBusinessId(split.business_id, conn);
//   const admin = await getAdminWallet(conn);

//   if (!buyer) throw new Error("Buyer wallet missing");
//   if (!merch) throw new Error("Merchant wallet missing");
//   if (!admin) throw new Error("Admin wallet missing");

//   if (userFee > 0) {
//     const [[freshBuyer]] = await conn.query(
//       `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//       [buyer.id],
//     );
//     if (!freshBuyer || Number(freshBuyer.amount) < userFee) {
//       throw new Error(
//         "Insufficient user wallet balance for COD platform fee share.",
//       );
//     }
//   }

//   if (merchFee > 0) {
//     const [[freshMerch]] = await conn.query(
//       `SELECT amount FROM wallets WHERE id = ? FOR UPDATE`,
//       [merch.id],
//     );
//     if (!freshMerch || Number(freshMerch.amount) < merchFee) {
//       throw new Error(
//         "Insufficient merchant wallet balance for COD platform fee share.",
//       );
//     }
//   }

//   const ids0 = prefetchedIds?.[0];
//   const ids1 = prefetchedIds?.[1];
//   if ((userFee > 0 && !ids0) || (merchFee > 0 && !ids1)) {
//     throw new Error("Prefetched transaction ids are missing for COD capture");
//   }

//   let tUserFee = null;
//   if (userFee > 0) {
//     tUserFee = await recordWalletTransferWithIds(conn, {
//       fromId: buyer.wallet_id,
//       toId: admin.wallet_id,
//       amount: userFee,
//       order_id,
//       note: `COD platform fee (user 50%) for ${order_id}`,
//       ids: ids0,
//     });
//   }

//   let tMerchFee = null;
//   if (merchFee > 0) {
//     tMerchFee = await recordWalletTransferWithIds(conn, {
//       fromId: merch.wallet_id,
//       toId: admin.wallet_id,
//       amount: merchFee,
//       order_id,
//       note: `COD platform fee (merchant 50%) for ${order_id}`,
//       ids: ids1,
//     });
//   }

//   const buyerPair = tUserFee
//     ? `${tUserFee.dr_txn_id}/${tUserFee.cr_txn_id}`
//     : null;
//   const merchPair = tMerchFee
//     ? `${tMerchFee.dr_txn_id}/${tMerchFee.cr_txn_id}`
//     : null;

//   const adminRef =
//     (tUserFee?.journal_id ? String(tUserFee.journal_id) : null) ||
//     (tMerchFee?.journal_id ? String(tMerchFee.journal_id) : null) ||
//     null;

//   await conn.query(
//     `INSERT INTO order_wallet_captures (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
//      VALUES (?, 'COD_FEE', ?, ?, ?)`,
//     [order_id, buyerPair, merchPair, adminRef],
//   );

//   return {
//     captured: true,
//     payment_method: "COD",
//     user_id: order.user_id,
//     business_id: split.business_id,
//     order_amount: 0,
//     platform_fee_user: userFee,
//     platform_fee_merchant: merchFee,
//     merchant_net_amount: Number((baseToMerchant - merchFee).toFixed(2)),
//   };
// }

// /* ================= APPLY UNAVAILABLE ITEM CHANGES ================= */
// async function applyUnavailableItemChanges(order_id, changes) {
//   const removed = Array.isArray(changes?.removed) ? changes.removed : [];
//   const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];
//   if (!removed.length && !replaced.length) return;

//   const pickFirst = (...vals) => {
//     for (const v of vals) {
//       if (v === undefined || v === null) continue;
//       const s = typeof v === "string" ? v.trim() : v;
//       if (s === "") continue;
//       return v;
//     }
//     return undefined;
//   };

//   const numOr = (v, fallback) => {
//     if (v === undefined || v === null || v === "") return fallback;
//     const n = Number(v);
//     return Number.isFinite(n) ? n : fallback;
//   };

//   const toId = (v) => {
//     const n = Number(v);
//     return Number.isFinite(n) && n > 0 ? n : null;
//   };

//   const normalizeBizId = (o) =>
//     toId(o?.business_id ?? o?.businessId ?? o?.businessID ?? o?.business?.id);

//   const normalizeMenuId = (o) =>
//     toId(o?.menu_id ?? o?.menuId ?? o?.product_id ?? o?.productId ?? o?.id);

//   const normalizeBizName = (o, fallback) =>
//     pickFirst(o?.business_name, o?.businessName, o?.business?.name, fallback);

//   const normalizeItemName = (o, fallback) =>
//     pickFirst(o?.item_name, o?.itemName, o?.name, o?.product?.name, fallback);

//   const normalizeItemImage = (o, fallback) =>
//     pickFirst(
//       o?.item_image,
//       o?.itemImage,
//       o?.image,
//       o?.image_url,
//       o?.imageUrl,
//       o?.item_image_url,
//       o?.itemImageUrl,
//       o?.product?.image,
//       o?.product?.image_url,
//       o?.product?.imageUrl,
//       fallback,
//     );

//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     for (const r of removed) {
//       const bid = normalizeBizId(r);
//       const mid = normalizeMenuId(r);
//       if (!bid || !mid) continue;

//       await conn.query(
//         `DELETE FROM order_items
//           WHERE order_id = ? AND business_id = ? AND menu_id = ?
//           LIMIT 1`,
//         [order_id, bid, mid],
//       );
//     }

//     for (const ch of replaced) {
//       const old = ch?.old || {};
//       const neu = ch?.new || {};

//       const bidOld = normalizeBizId(old);
//       const midOld = normalizeMenuId(old);
//       if (!bidOld || !midOld) continue;

//       const [rows] = await conn.query(
//         `SELECT * FROM order_items
//           WHERE order_id = ? AND business_id = ? AND menu_id = ?
//           LIMIT 1`,
//         [order_id, bidOld, midOld],
//       );
//       if (!rows.length) continue;

//       const row = rows[0];

//       const bidNew = normalizeBizId(neu) ?? row.business_id;
//       const menuNew = normalizeMenuId(neu) ?? row.menu_id;

//       const bnameNew = normalizeBizName(neu, row.business_name);
//       const itemName = normalizeItemName(neu, row.item_name);
//       const image = normalizeItemImage(neu, row.item_image);

//       const qty = numOr(neu?.quantity ?? neu?.qty ?? neu?.count, row.quantity);
//       const price = numOr(
//         neu?.price ?? neu?.unit_price ?? neu?.unitPrice,
//         row.price,
//       );

//       const subtotalRaw =
//         neu?.subtotal ?? neu?.line_subtotal ?? neu?.lineSubtotal;
//       const subtotal =
//         subtotalRaw !== undefined && subtotalRaw !== null && subtotalRaw !== ""
//           ? numOr(subtotalRaw, row.subtotal)
//           : Number((Number(qty) * Number(price)).toFixed(2));

//       await conn.query(
//         `UPDATE order_items
//             SET business_id = ?,
//                 business_name = ?,
//                 menu_id = ?,
//                 item_name = ?,
//                 item_image = ?,
//                 quantity = ?,
//                 price = ?,
//                 subtotal = ?
//           WHERE item_id = ?`,
//         [
//           bidNew,
//           bnameNew,
//           menuNew,
//           itemName,
//           image,
//           qty,
//           price,
//           subtotal,
//           row.item_id,
//         ],
//       );
//     }

//     await conn.commit();
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// /* ================= ARCHIVE HELPERS ================= */
// async function tableExists(table, conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT 1
//       FROM INFORMATION_SCHEMA.TABLES
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = ?
//      LIMIT 1
//     `,
//     [table],
//   );
//   return rows.length > 0;
// }

// async function getTableColumns(table, conn = null) {
//   const dbh = conn || db;
//   const [rows] = await dbh.query(
//     `
//     SELECT COLUMN_NAME
//       FROM INFORMATION_SCHEMA.COLUMNS
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = ?
//     `,
//     [table],
//   );
//   return new Set(rows.map((r) => String(r.COLUMN_NAME)));
// }

// function pick(obj, key) {
//   return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
// }

// async function archiveCancelledOrderInternal(
//   conn,
//   order_id,
//   { cancelled_by = "SYSTEM", reason = "" } = {},
// ) {
//   const hasCancelledOrders = await tableExists("cancelled_orders", conn);
//   const hasCancelledItems = await tableExists("cancelled_order_items", conn);
//   if (!hasCancelledOrders && !hasCancelledItems) return { archived: false };

//   const [[order]] = await conn.query(
//     `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
//     [order_id],
//   );
//   if (!order) return { archived: false };

//   const [items] = await conn.query(
//     `SELECT * FROM order_items WHERE order_id = ?`,
//     [order_id],
//   );

//   let resolvedServiceType = null;
//   try {
//     resolvedServiceType = await resolveOrderServiceType(order_id, conn);
//   } catch {
//     resolvedServiceType =
//       (order.service_type ? String(order.service_type).toUpperCase() : null) ||
//       "FOOD";
//   }

//   if (hasCancelledOrders) {
//     const cols = await getTableColumns("cancelled_orders", conn);
//     const row = {};

//     if (cols.has("order_id")) row.order_id = order.order_id;
//     if (cols.has("user_id")) row.user_id = order.user_id;
//     if (cols.has("service_type"))
//       row.service_type = resolvedServiceType || null;

//     if (cols.has("payment_method")) row.payment_method = order.payment_method;
//     if (cols.has("total_amount")) row.total_amount = order.total_amount;
//     if (cols.has("discount_amount"))
//       row.discount_amount = order.discount_amount;
//     if (cols.has("delivery_fee")) row.delivery_fee = order.delivery_fee;
//     if (cols.has("merchant_delivery_fee"))
//       row.merchant_delivery_fee = order.merchant_delivery_fee;
//     if (cols.has("platform_fee")) row.platform_fee = order.platform_fee;
//     if (cols.has("delivery_address"))
//       row.delivery_address = order.delivery_address;
//     if (cols.has("note_for_restaurant"))
//       row.note_for_restaurant = order.note_for_restaurant;
//     if (cols.has("if_unavailable")) row.if_unavailable = order.if_unavailable;
//     if (cols.has("status")) row.status = "CANCELLED";

//     const r =
//       String(reason || "").trim() ||
//       String(order.status_reason || "").trim() ||
//       "";
//     if (cols.has("status_reason")) row.status_reason = r;
//     if (cols.has("cancel_reason")) row.cancel_reason = r;
//     if (cols.has("cancelled_reason")) row.cancelled_reason = r;
//     if (cols.has("reason")) row.reason = r;

//     if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
//     if (cols.has("cancelled_at")) row.cancelled_at = new Date();

//     if (cols.has("created_at") && pick(row, "created_at") === undefined)
//       row.created_at = new Date();
//     if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
//       row.updated_at = new Date();

//     if (Object.keys(row).length) {
//       const fields = Object.keys(row);
//       const placeholders = fields.map(() => "?").join(", ");
//       const values = fields.map((k) => row[k]);

//       await conn.query(
//         `INSERT IGNORE INTO cancelled_orders (${fields.join(", ")}) VALUES (${placeholders})`,
//         values,
//       );
//     }
//   }

//   if (hasCancelledItems && items.length) {
//     const cols = await getTableColumns("cancelled_order_items", conn);

//     for (const it of items) {
//       const row = {};
//       if (cols.has("order_id")) row.order_id = it.order_id;
//       if (cols.has("business_id")) row.business_id = it.business_id;
//       if (cols.has("business_name")) row.business_name = it.business_name;
//       if (cols.has("menu_id")) row.menu_id = it.menu_id;
//       if (cols.has("item_name")) row.item_name = it.item_name;
//       if (cols.has("item_image")) row.item_image = it.item_image;
//       if (cols.has("quantity")) row.quantity = it.quantity;
//       if (cols.has("price")) row.price = it.price;
//       if (cols.has("subtotal")) row.subtotal = it.subtotal;

//       if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
//       if (cols.has("reason")) row.reason = String(reason || "").trim() || null;
//       if (cols.has("cancelled_at")) row.cancelled_at = new Date();

//       if (cols.has("created_at") && pick(row, "created_at") === undefined)
//         row.created_at = new Date();
//       if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
//         row.updated_at = new Date();

//       const fields = Object.keys(row);
//       if (!fields.length) continue;

//       const placeholders = fields.map(() => "?").join(", ");
//       const values = fields.map((k) => row[k]);

//       await conn.query(
//         `INSERT IGNORE INTO cancelled_order_items (${fields.join(", ")}) VALUES (${placeholders})`,
//         values,
//       );
//     }
//   }

//   return { archived: true };
// }

// async function archiveDeliveredOrderInternal(
//   conn,
//   order_id,
//   { delivered_by = "SYSTEM", reason = "" } = {},
// ) {
//   const hasDeliveredOrders = await tableExists("delivered_orders", conn);
//   const hasDeliveredItems = await tableExists("delivered_order_items", conn);
//   if (!hasDeliveredOrders && !hasDeliveredItems) return { archived: false };

//   const [[order]] = await conn.query(
//     `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
//     [order_id],
//   );
//   if (!order) return { archived: false };

//   const [items] = await conn.query(
//     `SELECT * FROM order_items WHERE order_id = ?`,
//     [order_id],
//   );

//   const finalReason = String(reason || "").trim();

//   let resolvedServiceType = null;
//   try {
//     resolvedServiceType = await resolveOrderServiceType(order_id, conn);
//   } catch {
//     resolvedServiceType = order.service_type
//       ? String(order.service_type).trim().toUpperCase()
//       : null;
//   }
//   if (resolvedServiceType !== "FOOD" && resolvedServiceType !== "MART")
//     resolvedServiceType = "FOOD";

//   const deliveredBy =
//     String(delivered_by || "SYSTEM")
//       .trim()
//       .toUpperCase() || "SYSTEM";

//   const firstPhotoFromList = (v) => {
//     if (v == null) return null;
//     if (Array.isArray(v)) return v.map(String).filter(Boolean)[0] || null;
//     const s = String(v).trim();
//     if (!s) return null;
//     try {
//       const arr = JSON.parse(s);
//       if (Array.isArray(arr)) return arr.map(String).filter(Boolean)[0] || null;
//       return s;
//     } catch {
//       return s;
//     }
//   };

//   if (hasDeliveredOrders) {
//     const cols = await getTableColumns("delivered_orders", conn);
//     const row = {};

//     if (cols.has("order_id")) row.order_id = order.order_id;
//     if (cols.has("user_id")) row.user_id = order.user_id;
//     if (cols.has("service_type")) row.service_type = resolvedServiceType;

//     if (cols.has("status")) row.status = "DELIVERED";
//     if (cols.has("status_reason"))
//       row.status_reason =
//         finalReason || String(order.status_reason || "").trim() || null;

//     const delivery_fee = Number(order.delivery_fee || 0);
//     const discount_amount = Number(order.discount_amount || 0);
//     const platform_fee = Number(order.platform_fee || 0);
//     const total_amount = Number(order.total_amount || 0);

//     if (cols.has("delivery_fee")) row.delivery_fee = delivery_fee;
//     if (cols.has("discount_amount")) row.discount_amount = discount_amount;
//     if (cols.has("platform_fee")) row.platform_fee = platform_fee;
//     if (cols.has("merchant_delivery_fee"))
//       row.merchant_delivery_fee =
//         order.merchant_delivery_fee != null
//           ? Number(order.merchant_delivery_fee)
//           : null;

//     if (cols.has("total_amount")) row.total_amount = total_amount;

//     // fallback compute if total_amount is 0
//     if (cols.has("total_amount") && Number(row.total_amount || 0) === 0) {
//       const items_total = (items || []).reduce(
//         (s, it) => s + Number(it.subtotal || 0),
//         0,
//       );
//       if (items_total > 0) {
//         row.total_amount = Number(
//           (items_total + delivery_fee - discount_amount + platform_fee).toFixed(
//             2,
//           ),
//         );
//       }
//     }

//     if (cols.has("payment_method"))
//       row.payment_method = String(order.payment_method || "")
//         .trim()
//         .toUpperCase();

//     if (cols.has("delivery_address"))
//       row.delivery_address =
//         order.delivery_address != null ? String(order.delivery_address) : "";

//     if (cols.has("note_for_restaurant"))
//       row.note_for_restaurant = order.note_for_restaurant ?? null;
//     if (cols.has("if_unavailable"))
//       row.if_unavailable = order.if_unavailable ?? null;
//     if (cols.has("fulfillment_type"))
//       row.fulfillment_type = order.fulfillment_type || "Delivery";
//     if (cols.has("priority")) row.priority = !!order.priority;
//     if (cols.has("estimated_arrivial_time"))
//       row.estimated_arrivial_time = order.estimated_arrivial_time ?? null;

//     if (cols.has("delivery_special_mode")) {
//       row.delivery_special_mode = order.delivery_special_mode
//         ? String(order.delivery_special_mode).trim().toUpperCase()
//         : null;
//     }

//     if (cols.has("delivery_floor_unit"))
//       row.delivery_floor_unit = order.delivery_floor_unit ?? null;
//     if (cols.has("delivery_instruction_note"))
//       row.delivery_instruction_note = order.delivery_instruction_note ?? null;

//     if (cols.has("delivery_photo_url")) {
//       const photo =
//         order.delivery_photo_url && String(order.delivery_photo_url).trim()
//           ? String(order.delivery_photo_url).trim()
//           : firstPhotoFromList(order.delivery_photo_urls);
//       row.delivery_photo_url = photo || null;
//     }

//     if (cols.has("delivered_by")) row.delivered_by = deliveredBy;
//     if (cols.has("delivered_at")) row.delivered_at = new Date();

//     if (cols.has("delivery_batch_id"))
//       row.delivery_batch_id = order.delivery_batch_id ?? null;
//     if (cols.has("delivery_driver_id"))
//       row.delivery_driver_id = order.delivery_driver_id ?? null;
//     if (cols.has("delivery_ride_id"))
//       row.delivery_ride_id = order.delivery_ride_id ?? null;

//     if (cols.has("delivery_status")) row.delivery_status = "DELIVERED";

//     if (cols.has("original_created_at"))
//       row.original_created_at = order.created_at ?? null;
//     if (cols.has("original_updated_at"))
//       row.original_updated_at = order.updated_at ?? null;

//     const fields = Object.keys(row);
//     if (fields.length) {
//       const colSql = fields.map((f) => `\`${f}\``).join(", ");
//       const placeholders = fields.map(() => "?").join(", ");
//       const values = fields.map((k) => row[k]);

//       const updateFields = fields.filter((f) => f !== "order_id");
//       const updateSql = updateFields.length
//         ? updateFields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(", ")
//         : "`order_id`=`order_id`";

//       await conn.query(
//         `INSERT INTO delivered_orders (${colSql})
//          VALUES (${placeholders})
//          ON DUPLICATE KEY UPDATE ${updateSql}`,
//         values,
//       );
//     }
//   }

//   if (hasDeliveredItems) {
//     const cols = await getTableColumns("delivered_order_items", conn);

//     await conn.query(`DELETE FROM delivered_order_items WHERE order_id = ?`, [
//       order_id,
//     ]);

//     for (const it of items || []) {
//       const row = {};
//       if (cols.has("order_id")) row.order_id = it.order_id;
//       if (cols.has("business_id")) row.business_id = it.business_id;
//       if (cols.has("business_name"))
//         row.business_name = it.business_name ?? null;

//       if (cols.has("menu_id")) row.menu_id = it.menu_id;
//       if (cols.has("item_name")) row.item_name = it.item_name ?? null;
//       if (cols.has("item_image")) row.item_image = it.item_image ?? null;

//       if (cols.has("quantity")) row.quantity = Number(it.quantity ?? 1);
//       if (cols.has("price")) row.price = Number(it.price ?? 0);
//       if (cols.has("subtotal")) row.subtotal = Number(it.subtotal ?? 0);

//       if (cols.has("platform_fee"))
//         row.platform_fee = Number(it.platform_fee ?? 0);
//       if (cols.has("delivery_fee"))
//         row.delivery_fee = Number(it.delivery_fee ?? 0);

//       const fields = Object.keys(row);
//       if (!fields.length) continue;

//       const colSql = fields.map((f) => `\`${f}\``).join(", ");
//       const placeholders = fields.map(() => "?").join(", ");
//       const values = fields.map((k) => row[k]);

//       await conn.query(
//         `INSERT INTO delivered_order_items (${colSql}) VALUES (${placeholders})`,
//         values,
//       );
//     }
//   }

//   return { archived: true };
// }

// async function deleteOrderFromMainTablesInternal(conn, order_id) {
//   await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
//   await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);
// }

// async function trimDeliveredOrdersForUser(conn, userId, keep = 10) {
//   const hasDeliveredOrders = await tableExists("delivered_orders", conn);
//   if (!hasDeliveredOrders) return { trimmed: 0 };

//   const cols = await getTableColumns("delivered_orders", conn);
//   const hasDeliveredId = cols.has("delivered_id");
//   const hasDeliveredAt = cols.has("delivered_at");

//   const orderBy = hasDeliveredAt
//     ? `ORDER BY delivered_at DESC${hasDeliveredId ? ", delivered_id DESC" : ""}`
//     : hasDeliveredId
//       ? `ORDER BY delivered_id DESC`
//       : `ORDER BY order_id DESC`;

//   const [oldRows] = await conn.query(
//     `
//     SELECT order_id
//       FROM delivered_orders
//      WHERE user_id = ?
//      ${orderBy}
//      LIMIT ?, 100000
//      FOR UPDATE
//     `,
//     [userId, keep],
//   );

//   if (!oldRows.length) return { trimmed: 0 };

//   const oldIds = oldRows.map((r) => r.order_id);
//   const [del] = await conn.query(
//     `DELETE FROM delivered_orders WHERE user_id = ? AND order_id IN (?)`,
//     [userId, oldIds],
//   );

//   return { trimmed: del.affectedRows || 0 };
// }

// /* ================= MERCHANT EARNINGS + REVENUE SNAPSHOT (optional but safe) ================= */
// async function insertMerchantEarningWithConn(
//   conn,
//   { business_id, order_id, total_amount, dateObj },
// ) {
//   const [t] = await conn.query(
//     `
//     SELECT 1
//       FROM INFORMATION_SCHEMA.TABLES
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = 'merchant_earnings'
//      LIMIT 1
//     `,
//   );
//   if (!t.length) return;

//   const [[exists]] = await conn.query(
//     `SELECT 1 FROM merchant_earnings WHERE order_id = ? AND business_id = ? LIMIT 1`,
//     [order_id, business_id],
//   );
//   if (exists) return;

//   const amt = Number(total_amount || 0);
//   const d = dateObj || new Date();

//   await conn.query(
//     `INSERT INTO merchant_earnings (business_id, \`date\`, total_amount, order_id)
//      VALUES (?, ?, ?, ?)`,
//     [business_id, d, amt, order_id],
//   );
// }

// async function insertFoodMartRevenueWithConn(conn, row) {
//   const [t] = await conn.query(
//     `
//     SELECT 1
//       FROM INFORMATION_SCHEMA.TABLES
//      WHERE TABLE_SCHEMA = DATABASE()
//        AND TABLE_NAME = 'food_mart_revenue'
//      LIMIT 1
//     `,
//   );
//   if (!t.length) return;

//   const ownerType = String(row.owner_type || "FOOD")
//     .trim()
//     .toUpperCase();
//   const source = String(row.source || "delivered")
//     .trim()
//     .toLowerCase();

//   const sql = `
//     INSERT INTO food_mart_revenue
//     (
//       order_id, user_id, business_id, owner_type, source,
//       status, placed_at, payment_method,
//       total_amount, platform_fee, revenue_earned, tax,
//       customer_name, customer_phone, business_name,
//       items_summary, total_quantity, details_json, created_at
//     )
//     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
//     ON DUPLICATE KEY UPDATE
//       user_id        = VALUES(user_id),
//       business_id    = VALUES(business_id),
//       owner_type     = VALUES(owner_type),
//       source         = VALUES(source),
//       status         = VALUES(status),
//       placed_at      = VALUES(placed_at),
//       payment_method = VALUES(payment_method),
//       total_amount   = VALUES(total_amount),
//       platform_fee   = VALUES(platform_fee),
//       revenue_earned = VALUES(revenue_earned),
//       tax            = VALUES(tax),
//       customer_name  = VALUES(customer_name),
//       customer_phone = VALUES(customer_phone),
//       business_name  = VALUES(business_name),
//       items_summary  = VALUES(items_summary),
//       total_quantity = VALUES(total_quantity),
//       details_json   = VALUES(details_json)
//   `;

//   await conn.query(sql, [
//     String(row.order_id).trim(),
//     Number(row.user_id),
//     Number(row.business_id),
//     ownerType,
//     source,

//     row.status || null,
//     row.placed_at || null,
//     row.payment_method || null,

//     Number(row.total_amount || 0),
//     Number(row.platform_fee || 0),
//     Number(row.revenue_earned || 0),
//     Number(row.tax || 0),

//     row.customer_name || null,
//     row.customer_phone || null,
//     row.business_name || null,

//     row.items_summary || null,
//     Number(row.total_quantity || 0),
//     row.details_json || null,
//   ]);
// }

// function buildItemsSummary(items = []) {
//   const byName = new Map();
//   let totalQty = 0;

//   for (const it of items || []) {
//     const name = String(it.item_name || "").trim() || "Item";
//     const q = Number(it.quantity || 0) || 0;
//     totalQty += q;
//     byName.set(name, (byName.get(name) || 0) + q);
//   }

//   const summary = Array.from(byName.entries())
//     .sort((a, b) => a[0].localeCompare(b[0]))
//     .map(([name, qty]) => `${name} x${qty}`)
//     .join(", ");

//   return { summary, totalQty };
// }

// /* ================= CANCEL + ARCHIVE + DELETE ================= */
// async function cancelAndArchiveOrder(
//   order_id,
//   {
//     cancelled_by = "SYSTEM",
//     reason = "",
//     cancel_reason = "",
//     onlyIfStatus = null,
//     expectedUserId = null,
//   } = {},
// ) {
//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     const [[row]] = await conn.query(
//       `SELECT order_id, user_id, status FROM orders WHERE order_id = ? FOR UPDATE`,
//       [order_id],
//     );
//     if (!row) {
//       await conn.rollback();
//       return { ok: false, code: "NOT_FOUND" };
//     }

//     const user_id = Number(row.user_id);
//     const current = String(row.status || "").toUpperCase();

//     if (expectedUserId != null && Number(expectedUserId) !== user_id) {
//       await conn.rollback();
//       return { ok: false, code: "FORBIDDEN" };
//     }

//     if (onlyIfStatus && current !== String(onlyIfStatus).toUpperCase()) {
//       await conn.rollback();
//       return { ok: false, code: "SKIPPED", current_status: current };
//     }

//     const [bizRows] = await conn.query(
//       `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
//       [order_id],
//     );
//     const business_ids = bizRows.map((x) => x.business_id);

//     const finalReason = String(reason || cancel_reason || "").trim();
//     const hasReason = await ensureStatusReasonSupport();

//     if (hasReason) {
//       await conn.query(
//         `UPDATE orders SET status='CANCELLED', status_reason=?, updated_at=NOW() WHERE order_id=?`,
//         [finalReason, order_id],
//       );
//     } else {
//       await conn.query(
//         `UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE order_id=?`,
//         [order_id],
//       );
//     }

//     await archiveCancelledOrderInternal(conn, order_id, {
//       cancelled_by,
//       reason: finalReason,
//     });
//     await deleteOrderFromMainTablesInternal(conn, order_id);

//     await conn.commit();
//     return { ok: true, user_id, business_ids, status: "CANCELLED" };
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// async function cancelIfStillPending(order_id, reason) {
//   const out = await cancelAndArchiveOrder(order_id, {
//     cancelled_by: "SYSTEM",
//     reason,
//     onlyIfStatus: "PENDING",
//   });
//   return !!out?.ok;
// }

// /* ================= DELIVERED: COMPLETE + CAPTURE(optional) + ARCHIVE + DELETE ================= */
// async function completeAndArchiveDeliveredOrder(
//   order_id,
//   { delivered_by = "SYSTEM", reason = "", capture_at = "DELIVERED" } = {},
// ) {
//   const CAPTURE_AT = String(capture_at ?? process.env.CAPTURE_AT ?? "DELIVERED")
//     .trim()
//     .toUpperCase();
//   const CAPTURE_DISABLED = new Set(["SKIP", "NONE", "OFF", "DISABLED"]);

//   // Prefetch ids only if capture enabled
//   let prefetchedIds = [];
//   if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
//     try {
//       const [[pre]] = await db.query(
//         `SELECT payment_method FROM orders WHERE order_id = ? LIMIT 1`,
//         [order_id],
//       );
//       const pm = pre?.payment_method
//         ? String(pre.payment_method).trim().toUpperCase()
//         : null;

//       if (pm === "WALLET") prefetchedIds = await prefetchTxnIdsBatch(3);
//       else if (pm === "COD") prefetchedIds = await prefetchTxnIdsBatch(2);
//     } catch (e) {
//       return {
//         ok: false,
//         code: "CAPTURE_FAILED",
//         error: e?.message || "ID prefetch failed",
//       };
//     }
//   }

//   const conn = await db.getConnection();
//   try {
//     await conn.beginTransaction();

//     const [[row]] = await conn.query(
//       `SELECT order_id, user_id, status, payment_method FROM orders WHERE order_id = ? FOR UPDATE`,
//       [order_id],
//     );
//     if (!row) {
//       await conn.rollback();
//       return { ok: false, code: "NOT_FOUND" };
//     }

//     const user_id = Number(row.user_id);
//     const current = String(row.status || "").toUpperCase();
//     const payMethod = String(row.payment_method || "").toUpperCase();

//     if (current === "CANCELLED") {
//       await conn.rollback();
//       return { ok: false, code: "SKIPPED", current_status: current };
//     }

//     const [bizRows] = await conn.query(
//       `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
//       [order_id],
//     );
//     const business_ids = bizRows.map((x) => x.business_id);

//     const finalReason = String(reason || "").trim();

//     const [[order]] = await conn.query(
//       `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
//       [order_id],
//     );
//     const [items] = await conn.query(
//       `SELECT * FROM order_items WHERE order_id = ?`,
//       [order_id],
//     );

//     const split = await computeBusinessSplit(order_id, conn);
//     const baseToMerchant = Number(split.total_amount || 0);
//     const feeForPrimary = Number(split.platform_fee || 0);

//     const userFeeShare =
//       feeForPrimary > 0
//         ? Number((feeForPrimary * PLATFORM_USER_SHARE).toFixed(2))
//         : 0;
//     const merchFeeShare = Number((feeForPrimary - userFeeShare).toFixed(2));
//     const merchantNet = Number((baseToMerchant - merchFeeShare).toFixed(2));

//     // Capture (optional)
//     let capture = { captured: false, skipped: true, payment_method: payMethod };
//     if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
//       try {
//         if (payMethod === "WALLET") {
//           capture = await captureOrderFundsWithConn(
//             conn,
//             order_id,
//             prefetchedIds,
//           );
//         } else if (payMethod === "COD") {
//           capture = await captureOrderCODFeeWithConn(
//             conn,
//             order_id,
//             prefetchedIds,
//           );
//         }
//       } catch (e) {
//         await conn.rollback();
//         return {
//           ok: false,
//           code: "CAPTURE_FAILED",
//           error: e?.message || "Capture error",
//         };
//       }
//     }

//     // Ensure orders.status is DELIVERED
//     const hasReason = await ensureStatusReasonSupport();
//     if (hasReason) {
//       await conn.query(
//         `UPDATE orders SET status='DELIVERED', status_reason=?, updated_at=NOW() WHERE order_id=?`,
//         [finalReason, order_id],
//       );
//     } else {
//       await conn.query(
//         `UPDATE orders SET status='DELIVERED', updated_at=NOW() WHERE order_id=?`,
//         [order_id],
//       );
//     }

//     // Ensure delivered_at and delivery_status if columns exist
//     const extras = await ensureDeliveryExtrasSupport(conn);
//     if (extras.hasDeliveredAt) {
//       await conn.query(
//         `UPDATE orders SET delivered_at = COALESCE(delivered_at, NOW()) WHERE order_id = ? LIMIT 1`,
//         [order_id],
//       );
//     }
//     if (extras.hasDeliveryStatus) {
//       await conn.query(
//         `UPDATE orders SET delivery_status = 'DELIVERED' WHERE order_id = ? LIMIT 1`,
//         [order_id],
//       );
//     }

//     // Award points (non-fatal)
//     let pointsInfo = null;
//     try {
//       pointsInfo = await awardPointsForCompletedOrderWithConn(conn, order_id);
//     } catch (e) {
//       pointsInfo = {
//         awarded: false,
//         reason: "points_error",
//         error: e?.message,
//       };
//     }

//     // merchant_earnings (safe + idempotent)
//     try {
//       const deliveredAt = order?.delivered_at
//         ? new Date(order.delivered_at)
//         : new Date();
//       await insertMerchantEarningWithConn(conn, {
//         business_id: split.business_id,
//         order_id,
//         total_amount: merchantNet,
//         dateObj: deliveredAt,
//       });
//     } catch {}

//     // food_mart_revenue snapshot (safe + idempotent)
//     try {
//       let ownerType = null;
//       try {
//         ownerType = await resolveOrderServiceType(order_id, conn);
//       } catch {}
//       ownerType = String(ownerType || "FOOD").toUpperCase();
//       if (ownerType !== "FOOD" && ownerType !== "MART") ownerType = "FOOD";

//       const deliveredAt = order?.delivered_at
//         ? new Date(order.delivered_at)
//         : new Date();

//       const [[u]] = await conn.query(
//         `SELECT user_name, phone FROM users WHERE user_id = ? LIMIT 1`,
//         [user_id],
//       );
//       const customerName =
//         (u?.user_name && String(u.user_name).trim()) || `User ${user_id}`;
//       const customerPhone = u?.phone ? String(u.phone).trim() : null;

//       const [[mbd]] = await conn.query(
//         `SELECT business_name FROM merchant_business_details WHERE business_id = ? LIMIT 1`,
//         [split.business_id],
//       );
//       const businessName =
//         (mbd?.business_name && String(mbd.business_name).trim()) ||
//         (items?.[0]?.business_name
//           ? String(items[0].business_name).trim()
//           : null) ||
//         `Business ${split.business_id}`;

//       const { summary, totalQty } = buildItemsSummary(items);

//       const totalAmount = Number(order?.total_amount || 0);
//       const platformFee = Number(order?.platform_fee || 0);

//       const detailsObj = {
//         order: {
//           id: order_id,
//           status: "DELIVERED",
//           placed_at: deliveredAt,
//           owner_type: ownerType,
//           source: "delivered",
//         },
//         customer: { id: user_id, name: customerName, phone: customerPhone },
//         business: {
//           id: split.business_id,
//           name: businessName,
//           owner_type: ownerType,
//         },
//         items: {
//           summary: summary || "",
//           total_quantity: Number(totalQty || 0),
//         },
//         amounts: {
//           total_amount: totalAmount,
//           platform_fee: platformFee,
//           revenue_earned: platformFee,
//           tax: 0,
//         },
//         payment: { method: payMethod },
//       };

//       await insertFoodMartRevenueWithConn(conn, {
//         order_id,
//         user_id,
//         business_id: Number(split.business_id),
//         owner_type: ownerType,
//         source: "delivered",
//         status: "DELIVERED",
//         placed_at: deliveredAt,
//         payment_method: payMethod,
//         total_amount: totalAmount,
//         platform_fee: platformFee,
//         revenue_earned: platformFee,
//         tax: 0,
//         customer_name: customerName,
//         customer_phone: customerPhone,
//         business_name: businessName,
//         items_summary: summary || "",
//         total_quantity: Number(totalQty || 0),
//         details_json: JSON.stringify(detailsObj),
//       });
//     } catch (e) {
//       // do not break delivery pipeline
//       console.error("[food_mart_revenue insert failed]", e?.message);
//     }

//     // Archive + delete + trim
//     await archiveDeliveredOrderInternal(conn, order_id, {
//       delivered_by,
//       reason: finalReason,
//     });
//     await deleteOrderFromMainTablesInternal(conn, order_id);
//     await trimDeliveredOrdersForUser(conn, user_id, 10);

//     await conn.commit();

//     return {
//       ok: true,
//       user_id,
//       business_ids,
//       status: "DELIVERED",
//       points: pointsInfo,
//       capture: { ...(capture || {}), user_id, payment_method: payMethod },
//       earnings: {
//         business_id: split.business_id,
//         order_id,
//         total_amount: merchantNet,
//         date: order?.delivered_at ? new Date(order.delivered_at) : new Date(),
//       },
//     };
//   } catch (e) {
//     try {
//       await conn.rollback();
//     } catch {}
//     throw e;
//   } finally {
//     conn.release();
//   }
// }

// /* ================= OPTIONAL: CAPTURE ON ACCEPT (helper) ================= */
// async function captureOnAccept(order_id, conn = null) {
//   const dbh = conn || db;

//   const [[order]] = await dbh.query(
//     `SELECT user_id, payment_method
//        FROM orders
//       WHERE order_id = ?
//       LIMIT 1`,
//     [order_id],
//   );
//   if (!order) return { ok: false, code: "NOT_FOUND" };

//   const pm = String(order.payment_method || "WALLET").toUpperCase();

//   if (pm === "WALLET")
//     return {
//       ok: true,
//       payment_method: "WALLET",
//       capture: await captureOrderFunds(order_id),
//     };
//   if (pm === "COD")
//     return {
//       ok: true,
//       payment_method: "COD",
//       capture: await captureOrderCODFee(order_id),
//     };

//   return { ok: true, payment_method: pm, skipped: true };
// }

// /* ================= MODEL API ================= */
// const Order = {
//   // wallet lookup
//   getBuyerWalletByUserId,
//   getAdminWallet,
//   getMerchantWalletByBusinessId,

//   // capture (public)
//   captureOrderFunds,
//   captureOrderCODFee,

//   // service type helpers
//   getOwnerTypeByBusinessId,
//   resolveOrderServiceType,

//   // notifications
//   addUserOrderStatusNotification: async ({
//     user_id,
//     order_id,
//     status,
//     reason = "",
//     conn = null,
//   }) => {
//     await addUserOrderStatusNotificationInternal(
//       user_id,
//       order_id,
//       status,
//       reason,
//       conn,
//     );
//   },
//   addUserUnavailableItemNotification: async ({
//     user_id,
//     order_id,
//     changes,
//     final_total_amount = null,
//     conn = null,
//   }) => {
//     await addUserUnavailableItemNotificationInternal(
//       user_id,
//       order_id,
//       changes,
//       final_total_amount,
//       conn,
//     );
//   },
//   addUserWalletDebitNotification: async ({
//     user_id,
//     order_id,
//     order_amount,
//     platform_fee,
//     method,
//     conn = null,
//   }) => {
//     await addUserWalletDebitNotificationInternal(
//       user_id,
//       order_id,
//       order_amount,
//       platform_fee,
//       method,
//       conn,
//     );
//   },

//   // points
//   awardPointsForCompletedOrder,

//   // changes
//   applyUnavailableItemChanges,

//   // cancel + delivered archive pipeline
//   cancelAndArchiveOrder,
//   cancelIfStillPending,
//   completeAndArchiveDeliveredOrder,

//   // capture helper
//   captureOnAccept,

//   // id
//   peekNewOrderId: () => generateOrderId(),
// };

// /* ================= ORDER CRUD ================= */
// Order.create = async (orderData) => {
//   const order_id = String(orderData.order_id || generateOrderId())
//     .trim()
//     .toUpperCase();

//   const [colsRows] = await db.query(
//     `SELECT COLUMN_NAME
//        FROM INFORMATION_SCHEMA.COLUMNS
//       WHERE TABLE_SCHEMA = DATABASE()
//         AND TABLE_NAME = 'orders'`,
//   );
//   const cols = new Set(colsRows.map((r) => r.COLUMN_NAME));

//   const hasService = await ensureServiceTypeSupport();

//   let serviceType = null;
//   if (hasService) {
//     serviceType = String(orderData.service_type || "").toUpperCase();
//     if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
//       throw new Error("Invalid service_type (must be FOOD or MART)");
//     }
//   }

//   const payload = {
//     order_id,
//     user_id: orderData.user_id,

//     total_amount:
//       orderData.total_amount != null ? Number(orderData.total_amount) : 0,
//     discount_amount:
//       orderData.discount_amount != null ? Number(orderData.discount_amount) : 0,
//     delivery_fee:
//       orderData.delivery_fee != null ? Number(orderData.delivery_fee) : 0,
//     platform_fee:
//       orderData.platform_fee != null ? Number(orderData.platform_fee) : 0,
//     merchant_delivery_fee:
//       orderData.merchant_delivery_fee != null
//         ? Number(orderData.merchant_delivery_fee)
//         : null,

//     payment_method: String(orderData.payment_method || "").trim(),
//     delivery_address:
//       orderData.delivery_address &&
//       typeof orderData.delivery_address === "object"
//         ? JSON.stringify(orderData.delivery_address)
//         : orderData.delivery_address,

//     note_for_restaurant: orderData.note_for_restaurant || null,
//     if_unavailable:
//       orderData.if_unavailable !== undefined &&
//       orderData.if_unavailable !== null
//         ? String(orderData.if_unavailable)
//         : null,

//     status: (orderData.status || "PENDING").toUpperCase(),
//     fulfillment_type: orderData.fulfillment_type || "Delivery",
//     priority: !!orderData.priority,
//   };

//   if (hasService) payload.service_type = serviceType;

//   if (cols.has("delivery_floor_unit"))
//     payload.delivery_floor_unit = orderData.delivery_floor_unit || null;
//   if (cols.has("delivery_instruction_note"))
//     payload.delivery_instruction_note =
//       orderData.delivery_instruction_note || null;
//   if (cols.has("delivery_photo_url"))
//     payload.delivery_photo_url = orderData.delivery_photo_url || null;

//   if (cols.has("delivery_photo_urls")) {
//     const arr = Array.isArray(orderData.delivery_photo_urls)
//       ? orderData.delivery_photo_urls
//           .map((x) => (x == null ? "" : String(x).trim()))
//           .filter(Boolean)
//       : [];
//     payload.delivery_photo_urls = arr.length ? JSON.stringify(arr) : null;
//   }

//   if (cols.has("delivery_special_mode"))
//     payload.delivery_special_mode = orderData.delivery_special_mode || null;

//   if (cols.has("special_mode"))
//     payload.special_mode =
//       orderData.delivery_special_mode || orderData.special_mode || null;

//   if (cols.has("delivery_status")) {
//     payload.delivery_status = String(
//       orderData.delivery_status || "PENDING",
//     ).toUpperCase();
//   }

//   await db.query(`INSERT INTO orders SET ?`, payload);

//   for (const item of orderData.items || []) {
//     await db.query(`INSERT INTO order_items SET ?`, {
//       order_id,
//       business_id: item.business_id,
//       business_name: item.business_name,
//       menu_id: item.menu_id,
//       item_name: item.item_name,
//       item_image: item.item_image || null,
//       quantity: item.quantity,
//       price: item.price,
//       subtotal: item.subtotal,
//       platform_fee: 0,
//       delivery_fee: 0,
//     });
//   }

//   return order_id;
// };

// Order.findAll = async () => {
//   const hasReason = await ensureStatusReasonSupport();
//   const hasService = await ensureServiceTypeSupport();

//   const [orders] = await db.query(
//     `
//     SELECT
//       o.*,
//       ${hasReason ? "o.status_reason" : "NULL AS status_reason"},
//       ${hasService ? "o.service_type" : "NULL AS service_type"}
//     FROM orders o
//     ORDER BY o.created_at DESC
//     `,
//   );
//   if (!orders.length) return [];

//   const ids = orders.map((o) => o.order_id);
//   const [items] = await db.query(
//     `SELECT * FROM order_items WHERE order_id IN (?) ORDER BY order_id, business_id, menu_id`,
//     [ids],
//   );

//   const byOrder = new Map();
//   for (const o of orders) {
//     o.items = [];
//     o.delivery_address = parseDeliveryAddress(o.delivery_address);
//     byOrder.set(o.order_id, o);
//   }

//   for (const it of items) byOrder.get(it.order_id)?.items.push(it);
//   return orders;
// };

// Order.findByBusinessId = async (business_id) => {
//   const [items] = await db.query(
//     `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
//     [business_id],
//   );
//   return items;
// };

// Order.findByOrderIdGrouped = async (order_id) => {
//   const hasReason = await ensureStatusReasonSupport();
//   const hasService = await ensureServiceTypeSupport();

//   const [orders] = await db.query(
//     `
//     SELECT
//       o.order_id,
//       o.user_id,
//       u.user_name AS user_name,
//       u.email     AS user_email,
//       u.phone     AS user_phone,
//       ${hasService ? "o.service_type," : "NULL AS service_type,"}
//       ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
//       o.total_amount,
//       o.discount_amount,
//       o.delivery_fee,
//       o.platform_fee,
//       o.merchant_delivery_fee,
//       o.payment_method,
//       o.delivery_address,
//       o.note_for_restaurant,
//       o.if_unavailable,
//       o.estimated_arrivial_time,
//       o.status,
//       o.fulfillment_type,
//       o.priority,
//       o.created_at,
//       o.updated_at
//     FROM orders o
//     LEFT JOIN users u ON u.user_id = o.user_id
//     WHERE o.order_id = ?
//     LIMIT 1
//     `,
//     [order_id],
//   );
//   if (!orders.length) return [];

//   const [items] = await db.query(
//     `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id, business_id, menu_id`,
//     [order_id],
//   );

//   const o = orders[0];
//   o.items = items;

//   let resolvedServiceType = o.service_type || null;
//   if (!resolvedServiceType) {
//     try {
//       resolvedServiceType = await resolveOrderServiceType(order_id, db);
//     } catch {}
//   }

//   return [
//     {
//       user: {
//         user_id: o.user_id,
//         name: o.user_name || null,
//         email: o.user_email || null,
//         phone: o.user_phone || null,
//       },
//       orders: [
//         {
//           order_id: o.order_id,
//           service_type: resolvedServiceType || null,
//           status: o.status,
//           status_reason: o.status_reason || null,
//           total_amount: o.total_amount,
//           discount_amount: o.discount_amount,
//           delivery_fee: o.delivery_fee,
//           platform_fee: o.platform_fee,
//           merchant_delivery_fee: o.merchant_delivery_fee,
//           payment_method: o.payment_method,
//           delivery_address: parseDeliveryAddress(o.delivery_address),
//           note_for_restaurant: o.note_for_restaurant,
//           if_unavailable: o.if_unavailable || null,
//           estimated_arrivial_time: o.estimated_arrivial_time || null,
//           fulfillment_type: o.fulfillment_type,
//           priority: o.priority,
//           created_at: o.created_at,
//           updated_at: o.updated_at,
//           items: o.items,
//         },
//       ],
//     },
//   ];
// };

// Order.findByUserIdForApp = async (user_id, service_type = null) => {
//   const hasReason = await ensureStatusReasonSupport();
//   const hasService = await ensureServiceTypeSupport();
//   const extras = await ensureDeliveryExtrasSupport();

//   const params = [user_id];
//   let serviceWhere = "";
//   if (service_type && hasService) {
//     serviceWhere = " AND o.service_type = ? ";
//     params.push(service_type);
//   }

//   const [orders] = await db.query(
//     `
//     SELECT
//       o.order_id,
//       o.user_id,
//       ${hasService ? "o.service_type," : "NULL AS service_type,"}
//       ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
//       o.total_amount,
//       o.discount_amount,
//       o.delivery_fee,
//       o.platform_fee,
//       o.merchant_delivery_fee,
//       o.payment_method,
//       o.delivery_address,

//       ${extras.hasLat ? "o.delivery_lat" : "NULL AS delivery_lat"},
//       ${extras.hasLng ? "o.delivery_lng" : "NULL AS delivery_lng"},
//       ${extras.hasFloor ? "o.delivery_floor_unit" : "NULL AS delivery_floor_unit"},
//       ${extras.hasInstr ? "o.delivery_instruction_note" : "NULL AS delivery_instruction_note"},
//       ${extras.hasMode ? "o.delivery_special_mode" : "NULL AS delivery_special_mode"},
//       ${extras.hasPhoto ? "o.delivery_photo_url" : "NULL AS delivery_photo_url"},
//       ${extras.hasPhotoList ? "o.delivery_photo_urls" : "NULL AS delivery_photo_urls"},

//       o.note_for_restaurant,
//       o.if_unavailable,
//       o.estimated_arrivial_time,
//       o.status,
//       o.fulfillment_type,
//       o.priority,
//       o.created_at,
//       o.updated_at
//     FROM orders o
//     WHERE o.user_id = ?
//     ${serviceWhere}
//     ORDER BY o.created_at DESC
//     `,
//     params,
//   );

//   if (!orders.length) return [];

//   const orderIds = orders.map((o) => o.order_id);

//   const [items] = await db.query(
//     `
//     SELECT
//       order_id,
//       business_id,
//       business_name,
//       menu_id,
//       item_name,
//       item_image,
//       quantity,
//       price,
//       subtotal,
//       platform_fee,
//       delivery_fee
//     FROM order_items
//     WHERE order_id IN (?)
//     ORDER BY order_id, business_id, menu_id
//     `,
//     [orderIds],
//   );

//   const itemsByOrder = new Map();
//   const businessIdsSet = new Set();

//   for (const it of items) {
//     if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
//     itemsByOrder.get(it.order_id).push(it);

//     const bid = Number(it.business_id);
//     if (Number.isFinite(bid) && bid > 0) businessIdsSet.add(bid);
//   }

//   // business address/lat/lng lookup (safe)
//   const businessMap = new Map();
//   const bizIds = Array.from(businessIdsSet);

//   if (bizIds.length) {
//     try {
//       const [colsRows] = await db.query(
//         `
//         SELECT COLUMN_NAME
//           FROM INFORMATION_SCHEMA.COLUMNS
//          WHERE TABLE_SCHEMA = DATABASE()
//            AND TABLE_NAME = 'merchant_business_details'
//         `,
//       );
//       const cols = new Set(colsRows.map((r) => String(r.COLUMN_NAME)));

//       const addrCandidates = [
//         "business_address",
//         "address",
//         "full_address",
//         "location",
//         "business_location",
//         "business_addr",
//       ].filter((c) => cols.has(c));

//       const latCandidates = [
//         "lat",
//         "latitude",
//         "business_lat",
//         "delivery_lat",
//       ].filter((c) => cols.has(c));

//       const lngCandidates = [
//         "lng",
//         "longitude",
//         "business_lng",
//         "delivery_lng",
//       ].filter((c) => cols.has(c));

//       const addrExpr = addrCandidates.length
//         ? `COALESCE(${addrCandidates.map((c) => `m.\`${c}\``).join(", ")})`
//         : "NULL";

//       const latExpr = latCandidates.length
//         ? `m.\`${latCandidates[0]}\``
//         : "NULL";
//       const lngExpr = lngCandidates.length
//         ? `m.\`${lngCandidates[0]}\``
//         : "NULL";

//       const [bizRows] = await db.query(
//         `
//         SELECT
//           m.business_id,
//           ${addrExpr} AS address,
//           ${latExpr}  AS lat,
//           ${lngExpr}  AS lng
//         FROM merchant_business_details m
//         WHERE m.business_id IN (?)
//         `,
//         [bizIds],
//       );

//       for (const r of bizRows) {
//         const bid = Number(r.business_id);
//         if (!Number.isFinite(bid) || bid <= 0) continue;

//         businessMap.set(bid, {
//           address: r.address != null ? String(r.address).trim() : null,
//           lat:
//             r.lat != null && r.lat !== "" && !Number.isNaN(Number(r.lat))
//               ? Number(r.lat)
//               : null,
//           lng:
//             r.lng != null && r.lng !== "" && !Number.isNaN(Number(r.lng))
//               ? Number(r.lng)
//               : null,
//         });
//       }
//     } catch (e) {
//       console.error(
//         "[findByUserIdForApp] business address lookup failed:",
//         e?.message,
//       );
//     }
//   }

//   const parsePhotoList = (v) => {
//     if (v == null) return [];
//     if (Array.isArray(v)) return v.map(String).filter(Boolean);
//     const s = String(v).trim();
//     if (!s) return [];
//     try {
//       const arr = JSON.parse(s);
//       return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
//     } catch {
//       return [s].filter(Boolean);
//     }
//   };

//   const result = [];

//   for (const o of orders) {
//     const its = itemsByOrder.get(o.order_id) || [];
//     const primaryBiz = its[0] || null;

//     let st = o.service_type || null;
//     if (!st) {
//       try {
//         st = await resolveOrderServiceType(o.order_id, db);
//       } catch {}
//     }

//     const deliverTo = parseDeliveryAddress(o.delivery_address) || {};

//     if (deliverTo.lat == null && o.delivery_lat != null)
//       deliverTo.lat = Number(o.delivery_lat);
//     if (deliverTo.lng == null && o.delivery_lng != null)
//       deliverTo.lng = Number(o.delivery_lng);

//     deliverTo.delivery_floor_unit = o.delivery_floor_unit || null;
//     deliverTo.delivery_instruction_note = o.delivery_instruction_note || null;
//     deliverTo.delivery_special_mode = o.delivery_special_mode || null;

//     const listFromCol = parsePhotoList(o.delivery_photo_urls);
//     const legacy = o.delivery_photo_url
//       ? String(o.delivery_photo_url).trim()
//       : "";
//     const merged = Array.from(
//       new Set([...listFromCol, ...(legacy ? [legacy] : [])]),
//     ).filter(Boolean);

//     deliverTo.delivery_photo_urls = merged;
//     deliverTo.delivery_photo_url = merged[0] || null;

//     const bid = primaryBiz ? Number(primaryBiz.business_id) : null;
//     const bizInfo = bid && businessMap.has(bid) ? businessMap.get(bid) : null;

//     result.push({
//       order_id: o.order_id,
//       service_type: st || null,
//       status: o.status,
//       status_reason: o.status_reason || null,
//       payment_method: o.payment_method,
//       fulfillment_type: o.fulfillment_type,
//       created_at: o.created_at,
//       updated_at: o.updated_at,
//       if_unavailable: o.if_unavailable || null,
//       estimated_arrivial_time: o.estimated_arrivial_time || null,

//       business_details: primaryBiz
//         ? {
//             business_id: primaryBiz.business_id,
//             name: primaryBiz.business_name,
//             address: bizInfo?.address ?? null,
//             lat: bizInfo?.lat ?? null,
//             lng: bizInfo?.lng ?? null,
//           }
//         : null,

//       deliver_to: deliverTo,

//       totals: {
//         items_subtotal: its.reduce((s, it) => s + Number(it.subtotal || 0), 0),
//         delivery_fee: Number(o.delivery_fee || 0),
//         merchant_delivery_fee:
//           o.merchant_delivery_fee !== null
//             ? Number(o.merchant_delivery_fee)
//             : null,
//         platform_fee: Number(o.platform_fee || 0),
//         discount_amount: Number(o.discount_amount || 0),
//         total_amount: Number(o.total_amount || 0),
//       },

//       items: its.map((it) => ({
//         menu_id: it.menu_id,
//         name: it.item_name,
//         image: it.item_image,
//         quantity: it.quantity,
//         unit_price: it.price,
//         line_subtotal: it.subtotal,
//       })),
//     });
//   }

//   return result;
// };

// Order.update = async (order_id, orderData) => {
//   if (!orderData || !Object.keys(orderData).length) return 0;

//   if (orderData.status) {
//     let st = String(orderData.status).toUpperCase();
//     if (st === "COMPLETED") st = "DELIVERED";
//     orderData.status = st;
//   }

//   if (Object.prototype.hasOwnProperty.call(orderData, "service_type")) {
//     if (orderData.service_type != null) {
//       const st = String(orderData.service_type || "").toUpperCase();
//       if (!["FOOD", "MART"].includes(st))
//         throw new Error("Invalid service_type (must be FOOD or MART)");
//       orderData.service_type = st;
//     }
//   }

//   if (Object.prototype.hasOwnProperty.call(orderData, "delivery_address")) {
//     if (
//       orderData.delivery_address &&
//       typeof orderData.delivery_address === "object"
//     ) {
//       orderData.delivery_address = JSON.stringify(orderData.delivery_address);
//     } else if (orderData.delivery_address == null) {
//       orderData.delivery_address = null;
//     } else {
//       orderData.delivery_address = String(orderData.delivery_address);
//     }
//   }

//   const fields = Object.keys(orderData);
//   const values = Object.values(orderData);
//   const setClause = fields.map((f) => `\`${f}\` = ?`).join(", ");

//   const [result] = await db.query(
//     `UPDATE orders SET ${setClause}, updated_at = NOW() WHERE order_id = ?`,
//     [...values, order_id],
//   );
//   return result.affectedRows;
// };

// Order.updateStatus = async (order_id, status, reason) => {
//   const hasReason = await ensureStatusReasonSupport();

//   let st = String(status).toUpperCase();
//   if (st === "COMPLETED") st = "DELIVERED";

//   if (hasReason) {
//     const [r] = await db.query(
//       `UPDATE orders SET status = ?, status_reason = ?, updated_at = NOW() WHERE order_id = ?`,
//       [st, String(reason || "").trim(), order_id],
//     );
//     return r.affectedRows;
//   }

//   const [r] = await db.query(
//     `UPDATE orders SET status = ?, updated_at = NOW() WHERE order_id = ?`,
//     [st, order_id],
//   );
//   return r.affectedRows;
// };

// Order.delete = async (order_id) => {
//   const [r] = await db.query(`DELETE FROM orders WHERE order_id = ?`, [
//     order_id,
//   ]);
//   return r.affectedRows;
// };

// /* ================= KPI COUNTS BY BUSINESS ================= */
// Order.getOrderStatusCountsByBusiness = async (business_id) => {
//   const [rows] = await db.query(
//     `
//     SELECT o.status, COUNT(DISTINCT o.order_id) AS count
//       FROM orders o
//       INNER JOIN order_items oi ON oi.order_id = o.order_id
//      WHERE oi.business_id = ?
//      GROUP BY o.status
//     `,
//     [business_id],
//   );

//   const allStatuses = [
//     "PENDING",
//     "CONFIRMED",
//     "PREPARING",
//     "READY",
//     "OUT_FOR_DELIVERY",
//     "DELIVERED",
//     "CANCELLED",
//     "REJECTED",
//     "DECLINED",
//   ];

//   const result = {};
//   for (const s of allStatuses) result[s] = 0;

//   for (const row of rows) {
//     let key = String(row.status || "").toUpperCase();
//     if (key === "COMPLETED") key = "DELIVERED";
//     if (key) result[key] = Number(row.count) || 0;
//   }

//   const [todayRows] = await db.query(
//     `
//     SELECT COUNT(DISTINCT o.order_id) AS declined_today
//       FROM orders o
//       INNER JOIN order_items oi ON oi.order_id = o.order_id
//      WHERE oi.business_id = ?
//        AND o.status = 'DECLINED'
//        AND DATE(o.created_at) = CURDATE()
//     `,
//     [business_id],
//   );

//   result.order_declined_today = Number(todayRows[0]?.declined_today || 0);
//   return result;
// };

// /* ================= Merchant view: grouped by user ================= */
// Order.findByBusinessGroupedByUser = async (business_id) => {
//   const bid = Number(business_id);
//   if (!Number.isFinite(bid) || bid <= 0) return [];

//   const hasReason = await ensureStatusReasonSupport();
//   const hasService = await ensureServiceTypeSupport();
//   const extras = await ensureDeliveryExtrasSupport();

//   const derivedServiceType = (await getOwnerTypeByBusinessId(bid, db)) || null;

//   const [rows] = await db.query(
//     `
//     SELECT
//       o.order_id,
//       o.user_id,
//       u.user_name,
//       u.email,
//       u.phone,

//       ${hasService ? "o.service_type" : "NULL AS service_type"},
//       o.status,
//       ${hasReason ? "o.status_reason" : "NULL AS status_reason"},

//       o.total_amount,
//       o.discount_amount,
//       o.delivery_fee,
//       o.platform_fee,
//       o.merchant_delivery_fee,
//       o.payment_method,

//       o.delivery_address,
//       ${extras.hasLat ? "o.delivery_lat" : "NULL AS delivery_lat"},
//       ${extras.hasLng ? "o.delivery_lng" : "NULL AS delivery_lng"},

//       ${extras.hasFloor ? "o.delivery_floor_unit" : "NULL AS delivery_floor_unit"},
//       ${extras.hasInstr ? "o.delivery_instruction_note" : "NULL AS delivery_instruction_note"},
//       ${extras.hasMode ? "o.delivery_special_mode" : "NULL AS delivery_special_mode"},
//       ${extras.hasPhoto ? "o.delivery_photo_url" : "NULL AS delivery_photo_url"},

//       o.note_for_restaurant,
//       o.if_unavailable,
//       o.estimated_arrivial_time,
//       o.fulfillment_type,
//       o.priority,
//       o.created_at,
//       o.updated_at,

//       oi.item_id,
//       oi.business_id,
//       oi.business_name,
//       oi.menu_id,
//       oi.item_name,
//       oi.item_image,
//       oi.quantity,
//       oi.price,
//       oi.subtotal,
//       oi.platform_fee AS item_platform_fee,
//       oi.delivery_fee AS item_delivery_fee

//     FROM order_items oi
//     INNER JOIN orders o ON o.order_id = oi.order_id
//     LEFT JOIN users u ON u.user_id = o.user_id
//     WHERE oi.business_id = ?
//     ORDER BY o.created_at DESC, o.order_id DESC, oi.menu_id ASC
//     `,
//     [bid],
//   );

//   if (!rows.length) return [];

//   const byUser = new Map();

//   for (const r of rows) {
//     const uid = Number(r.user_id);

//     if (!byUser.has(uid)) {
//       byUser.set(uid, {
//         user: {
//           user_id: uid,
//           name: r.user_name || null,
//           email: r.email || null,
//           phone: r.phone || null,
//         },
//         orders: [],
//         _ordersMap: new Map(),
//       });
//     }

//     const group = byUser.get(uid);

//     if (!group._ordersMap.has(r.order_id)) {
//       let st = String(r.status || "").toUpperCase();
//       if (st === "COMPLETED") st = "DELIVERED";

//       const deliverTo = parseDeliveryAddress(r.delivery_address) || {};
//       if (deliverTo.lat == null && r.delivery_lat != null)
//         deliverTo.lat = Number(r.delivery_lat);
//       if (deliverTo.lng == null && r.delivery_lng != null)
//         deliverTo.lng = Number(r.delivery_lng);

//       deliverTo.delivery_floor_unit = r.delivery_floor_unit || null;
//       deliverTo.delivery_instruction_note = r.delivery_instruction_note || null;
//       deliverTo.delivery_special_mode = r.delivery_special_mode || null;
//       deliverTo.delivery_photo_url = r.delivery_photo_url || null;

//       const orderObj = {
//         order_id: r.order_id,
//         service_type: r.service_type || derivedServiceType,
//         status: st,
//         status_reason: r.status_reason || null,

//         // ✅ NEW: sum of item subtotals for THIS merchant (bid) within this order
//         items_total: 0,

//         payment_method: r.payment_method,
//         fulfillment_type: r.fulfillment_type,
//         priority: r.priority,
//         estimated_arrivial_time: r.estimated_arrivial_time || null,

//         note_for_restaurant: r.note_for_restaurant || null,
//         if_unavailable: r.if_unavailable || null,

//         deliver_to: deliverTo,

//         totals: {
//           total_amount: Number(r.total_amount || 0),
//           discount_amount: Number(r.discount_amount || 0),
//           delivery_fee: Number(r.delivery_fee || 0),
//           platform_fee: Number(r.platform_fee || 0),
//           merchant_delivery_fee:
//             r.merchant_delivery_fee != null
//               ? Number(r.merchant_delivery_fee)
//               : null,
//         },

//         created_at: r.created_at,
//         updated_at: r.updated_at,

//         business: {
//           business_id: r.business_id,
//           business_name: r.business_name || null,
//         },
//         items: [],
//       };

//       group._ordersMap.set(r.order_id, orderObj);
//       group.orders.push(orderObj);
//     }

//     const orderRef = group._ordersMap.get(r.order_id);

//     const lineSubtotal = Number(r.subtotal || 0);
//     orderRef.items_total = Number(
//       (Number(orderRef.items_total || 0) + lineSubtotal).toFixed(2),
//     );

//     orderRef.items.push({
//       item_id: r.item_id,
//       business_id: r.business_id,
//       business_name: r.business_name,
//       menu_id: r.menu_id,
//       item_name: r.item_name,
//       item_image: r.item_image || null,
//       quantity: r.quantity,
//       price: r.price,
//       subtotal: r.subtotal,
//       platform_fee: Number(r.item_platform_fee || 0),
//       delivery_fee: Number(r.item_delivery_fee || 0),
//     });
//   }

//   const out = Array.from(byUser.values()).map((g) => {
//     delete g._ordersMap;

//     // optional: ensure items_total always has 2dp number
//     g.orders = (g.orders || []).map((o) => ({
//       ...o,
//       items_total: Number(Number(o.items_total || 0).toFixed(2)),
//     }));

//     return g;
//   });

//   return out;
// };

// module.exports = Order;
