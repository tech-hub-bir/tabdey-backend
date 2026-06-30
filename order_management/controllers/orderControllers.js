// controllers/orderControllers.js
// ✅ Controller that DOES NOT use `Order.`
// ✅ Imports functions directly from your /models/orders/* files
// ✅ Uses: const db = require("../config/db");
// ✅ Keeps: upload + notifications + push + wallet capture delivered pipeline

const db = require("../config/db");
const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");
const { MAX_PHOTOS, toWebPaths } = require("../middleware/uploadDeliveryPhoto");
/* --------------------------- uploads support --------------------------- */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

/* --------------------------- Expo push (YOUR API SHAPE) --------------------------- */
const axios = require("axios");

const EXPO_NOTIFICATION_URL =
  process.env.EXPO_NOTIFICATION_URL ||
  "https://backend.tabdhey.bt/expo/api/push/send";

/* ============================================================
   Import model functions directly
   (Works whether modules export function directly or { fn } named)
============================================================ */

function pickFn(mod, name) {
  if (!mod) return null;
  if (typeof mod === "function") return mod; // module.exports = function
  if (name && typeof mod[name] === "function") return mod[name]; // module.exports = { name(){} }
  const first = Object.values(mod).find((v) => typeof v === "function");
  return first || null;
}
const PickupEmailService = require("../services/pickupEmailService");

/* ---------------- CRUD ---------------- */
const _createMod = require("../models/orders/crud/create");
const _findAllMod = require("../models/orders/crud/findAll");
const _findByBusinessIdMod = require("../models/orders/crud/findByBusinessId");
const _findByOrderIdGroupedMod = require("../models/orders/crud/findByOrderIdGrouped");
const _findByUserIdForAppMod = require("../models/orders/crud/findByUserIdForApp");
const _updateMod = require("../models/orders/crud/update");
const _updateStatusMod = require("../models/orders/crud/updateStatus");
const _deleteMod = require("../models/orders/crud/delete");
const updateStatusWithUnavailable = require("../models/orders/crud/updateStatusWithUnavailable");
const { captureOnAccept } = require("../models/orders/walletCaptureEngine");
const _getOrderStatusCountsByBusinessMod = require("../models/orders/crud/getOrderStatusCountsByBusiness");
const _findByBusinessGroupedByUserMod = require("../models/orders/crud/findByBusinessGroupedByUser");

const createDb = pickFn(_createMod, "create");
const findAllDb = pickFn(_findAllMod, "findAll");
const findByBusinessIdDb = pickFn(_findByBusinessIdMod, "findByBusinessId");
const findByOrderIdGroupedDb = pickFn(
  _findByOrderIdGroupedMod,
  "findByOrderIdGrouped",
);
const findByUserIdForAppDb = pickFn(
  _findByUserIdForAppMod,
  "findByUserIdForApp",
);
const updateDb = pickFn(_updateMod, "update");
const updateStatusDb = pickFn(_updateStatusMod, "updateStatus");
const deleteDb =
  pickFn(_deleteMod, "delete") ||
  pickFn(_deleteMod, "del") ||
  pickFn(_deleteMod, "remove");
const getOrderStatusCountsByBusinessDb = pickFn(
  _getOrderStatusCountsByBusinessMod,
  "getOrderStatusCountsByBusiness",
);
const findByBusinessGroupedByUserDb = pickFn(
  _findByBusinessGroupedByUserMod,
  "findByBusinessGroupedByUser",
);

/* ---------------- pipelines / notifications / helpers ---------------- */
const _helpersMod = require("../models/orders/helpers");
const generateOrderId =
  (typeof _helpersMod?.generateOrderId === "function" &&
    _helpersMod.generateOrderId) ||
  (typeof _helpersMod === "function" ? _helpersMod : null);

const _archiveMod = require("../models/orders/orderArchivePipeline");
const completeAndArchiveDeliveredOrder =
  _archiveMod?.completeAndArchiveDeliveredOrder ||
  pickFn(_archiveMod, "completeAndArchiveDeliveredOrder");
const cancelAndArchiveOrder =
  _archiveMod?.cancelAndArchiveOrder ||
  pickFn(_archiveMod, "cancelAndArchiveOrder");

const _notifMod = require("../models/orders/orderNotifications");
const addUserOrderStatusNotification =
  _notifMod?.addUserOrderStatusNotification ||
  pickFn(_notifMod, "addUserOrderStatusNotification");
const addUserWalletDebitNotification =
  _notifMod?.addUserWalletDebitNotification ||
  pickFn(_notifMod, "addUserWalletDebitNotification");

/* ============================================================
   PUSH helpers
============================================================ */

/**
 * If it's business_id -> get merchant user_id from merchant_business_details
 */
async function resolveMerchantUserIdFromBusinessId(conn, business_id) {
  const bid = Number(business_id);
  if (!Number.isFinite(bid) || bid <= 0) return null;

  const [[row]] = await conn.query(
    `SELECT user_id
       FROM merchant_business_details
      WHERE business_id = ?
      LIMIT 1`,
    [bid],
  );

  const uid = row?.user_id != null ? Number(row.user_id) : null;
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

/**
 * Supports multiple merchants across multiple business_ids
 */
async function getMerchantUserIdsByBusinessIds(businessIds = []) {
  const ids = Array.from(
    new Set(
      (businessIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );
  if (!ids.length) return [];

  try {
    const [rows] = await db.query(
      `SELECT DISTINCT user_id
         FROM merchant_business_details
        WHERE business_id IN (?)`,
      [ids],
    );

    return Array.from(
      new Set(
        rows
          .map((r) => Number(r.user_id))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    );
  } catch (e) {
    console.error("[getMerchantUserIdsByBusinessIds ERROR]", e?.message || e);
    return [];
  }
}

/**
 * ✅ IMPORTANT:
 * Your push API expects: { user_id: <number>, title: <string>, body: <string> }
 */
async function sendPushToUserId(user_id, { title, body }) {
  try {
    const uid = Number(user_id);
    if (!Number.isFinite(uid) || uid <= 0) return { ok: false, skipped: true };

    const payload = {
      user_id: uid,
      title: String(title || "Notification"),
      body: String(body || ""),
    };

    const { data } = await axios.post(EXPO_NOTIFICATION_URL, payload, {
      timeout: 8000,
      headers: { "Content-Type": "application/json" },
    });

    return { ok: true, data };
  } catch (e) {
    console.error("[PUSH FAILED]", e?.message || e);
    return { ok: false, error: e?.message || "push_failed" };
  }
}

/* ============================================================
   wallet+delivery notifications
============================================================ */

/**
 * Fallback: if capture doesn't include amounts (or is 0),
 * compute from DB like before:
 * - platform_fee_user = platform_fee * 0.5 (default)
 * - order_amount = total_amount - platform_fee
 */
async function resolveUserDebitAmounts(conn, order_id, user_id, capture = {}) {
  const out = {
    order_amount: Number(capture?.order_amount || 0),
    platform_fee_user: Number(
      capture?.platform_fee_user ??
        capture?.platform_fee_user_share ??
        capture?.platform_fee_user_amount ??
        0,
    ),
    platform_fee_total: Number(
      capture?.platform_fee ??
        capture?.final_platform_fee ??
        capture?.platform_fee_total ??
        0,
    ),
    total_amount: Number(
      capture?.total_amount ?? capture?.final_total_amount ?? 0,
    ),
  };

  // If amounts already look valid, keep them
  const looksValid =
    Number.isFinite(out.order_amount) &&
    out.order_amount > 0 &&
    Number.isFinite(out.platform_fee_user) &&
    out.platform_fee_user >= 0;

  if (looksValid) return out;

  try {
    // Prefer archive table first (because delivered pipeline often deletes from orders)
    let row = null;

    try {
      const [[r1]] = await conn.query(
        `SELECT total_amount, platform_fee
           FROM orders_archive
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
      if (r1) row = r1;
    } catch {}

    if (!row) {
      const [[r2]] = await conn.query(
        `SELECT total_amount, platform_fee
           FROM orders
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
      if (r2) row = r2;
    }

    if (!row) return out;

    const total_amount = Number(row.total_amount || 0);
    const platform_fee_total = Number(row.platform_fee || 0);

    const platform_fee_user = Number.isFinite(platform_fee_total)
      ? Number((platform_fee_total * 0.5).toFixed(2))
      : 0;

    // Order amount excludes the FULL platform fee (because platform fee is charged separately)
    const order_amount = Number.isFinite(total_amount)
      ? Number((total_amount - platform_fee_total).toFixed(2))
      : 0;

    // Only override missing/zero values
    if (!Number.isFinite(out.total_amount) || out.total_amount <= 0)
      out.total_amount = total_amount;
    if (!Number.isFinite(out.platform_fee_total) || out.platform_fee_total <= 0)
      out.platform_fee_total = platform_fee_total;

    if (!Number.isFinite(out.platform_fee_user) || out.platform_fee_user === 0)
      out.platform_fee_user = platform_fee_user;

    if (!Number.isFinite(out.order_amount) || out.order_amount === 0)
      out.order_amount = order_amount;

    return out;
  } catch (e) {
    console.error("[resolveUserDebitAmounts ERROR]", e?.message || e);
    return out;
  }
}
async function forceRevertConfirmedToPending(order_id, reason) {
  const oid = String(order_id || "")
    .trim()
    .toUpperCase();
  if (!oid) return { ok: false, code: "BAD_ORDER_ID" };

  const msg = reason || "Wallet transaction failed during order acceptance.";

  try {
    // Try with status_reason first
    const [result] = await db.query(
      `UPDATE orders
          SET status = 'PENDING',
              status_reason = ?,
              updated_at = NOW()
        WHERE order_id = ?
          AND status = 'CONFIRMED'`,
      [msg, oid],
    );

    const [[row]] = await db.query(
      `SELECT order_id, status
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [oid],
    );

    return {
      ok: String(row?.status || "").toUpperCase() === "PENDING",
      affectedRows: result?.affectedRows || 0,
      status: row?.status || null,
    };
  } catch (e) {
    // Fallback if status_reason column does not exist
    try {
      const [result] = await db.query(
        `UPDATE orders
            SET status = 'PENDING',
                updated_at = NOW()
          WHERE order_id = ?
            AND status = 'CONFIRMED'`,
        [oid],
      );

      const [[row]] = await db.query(
        `SELECT order_id, status
           FROM orders
          WHERE order_id = ?
          LIMIT 1`,
        [oid],
      );

      return {
        ok: String(row?.status || "").toUpperCase() === "PENDING",
        affectedRows: result?.affectedRows || 0,
        status: row?.status || null,
      };
    } catch (e2) {
      console.error("[FORCE REVERT TO PENDING FAILED]", {
        order_id: oid,
        error: e2?.message || e2,
      });

      return {
        ok: false,
        code: "REVERT_FAILED",
        error: e2?.message || String(e2),
      };
    }
  }
}
/**
 * After DELIVERED capture, write DB notifications + send PUSH
 * - Customer: wallet debit (order amount + platform fee share)
 * - Merchant: wallet credit (order credited) + merchant platform fee debit
 */
// async function safeNotifyWalletAndDelivery(
//   conn,
//   { order_id, user_id, capture },
// ) {
//   // customer wallet debit (DB + push)
//   if (capture?.captured && user_id) {
//     try {
//       const method = String(capture.payment_method || "WALLET").toUpperCase();

//       if (method === "WALLET") {
//         const computed = await resolveUserDebitAmounts(
//           conn,
//           order_id,
//           Number(user_id),
//           capture,
//         );

//         const orderAmt = Number(computed.order_amount || 0);
//         const feeAmt = Number(computed.platform_fee_user || 0);

//         // DB notification (if function exists)
//         if (typeof addUserWalletDebitNotification === "function") {
//           await addUserWalletDebitNotification({
//             user_id: Number(user_id),
//             order_id,
//             order_amount: orderAmt,
//             platform_fee: feeAmt,
//             method: "WALLET",
//             conn,
//           });
//         }

//         const bodyText =
//           `Order ${order_id} delivered. ` +
//           `Nu. ${Number(orderAmt || 0).toFixed(2)} deducted for order` +
//           (feeAmt > 0
//             ? ` and Nu. ${Number(feeAmt || 0).toFixed(2)} as platform fee.`
//             : ".");

//         await sendPushToUserId(Number(user_id), {
//           title: "Wallet deduction",
//           body: bodyText,
//         });
//       } else {
//         await sendPushToUserId(Number(user_id), {
//           title: "Order update",
//           body: `Order ${order_id} delivered.`,
//         });
//       }
//     } catch (e) {
//       console.error("[notify user wallet debit failed]", e?.message);
//     }
//   }

//   // merchant notification -> show wallet movements + DB + PUSH
//   if (capture?.captured && capture?.business_id) {
//     try {
//       const merchantUserId = await resolveMerchantUserIdFromBusinessId(
//         conn,
//         capture.business_id,
//       );

//       if (merchantUserId) {
//         const credited = Number(capture.order_amount || 0);
//         const debited = Number(capture.platform_fee_merchant || 0);

//         const parts = [];
//         parts.push(`Order ${order_id} delivered.`);
//         if (credited > 0)
//           parts.push(`Nu. ${credited.toFixed(2)} credited to your wallet.`);
//         if (debited > 0)
//           parts.push(
//             `Nu. ${debited.toFixed(2)} debited as platform fee (merchant share).`,
//           );

//         const msg = parts.join(" ");

//         await conn.query(
//           `INSERT INTO notifications (user_id, type, title, message, data, status, created_at)
//            VALUES (?, 'wallet_update', 'Wallet updated', ?, ?, 'unread', NOW())`,
//           [
//             merchantUserId,
//             msg,
//             JSON.stringify({
//               order_id,
//               business_id: Number(capture.business_id),
//               credited_order_amount: credited,
//               debited_platform_fee_merchant: debited,
//               payment_method: String(
//                 capture.payment_method || "WALLET",
//               ).toUpperCase(),
//             }),
//           ],
//         );

//         await sendPushToUserId(merchantUserId, {
//           title: "Wallet updated",
//           body: msg,
//         });
//       }
//     } catch (e) {
//       console.error("[notify merchant wallet movement failed]", e?.message);
//     }
//   }
// }
async function safeNotifyWalletCaptureOnAccept({ order_id, user_id, capture }) {
  if (!capture?.captured) return;

  const method = String(capture.payment_method || "WALLET").toUpperCase();
  if (method !== "WALLET") return;

  const conn = await db.getConnection();

  try {
    const orderAmount = Number(capture.order_amount || 0);
    const userPlatformFee = Number(capture.platform_fee_user || 0);
    const merchantPlatformFee = Number(capture.platform_fee_merchant || 0);
    const merchantDeliveryFee = Number(capture.merchant_delivery_fee || 0);

    const buyerTotalDebit = Number(
      capture.buyer_total_debit || orderAmount + userPlatformFee,
    );

    // =========================
    // 1. Customer wallet debit notification
    // =========================
    try {
      if (typeof addUserWalletDebitNotification === "function") {
        await addUserWalletDebitNotification({
          user_id: Number(user_id),
          order_id,
          order_amount: orderAmount,
          platform_fee: userPlatformFee,
          method: "WALLET",
          conn,
        });
      } else {
        await conn.query(
          `INSERT INTO notifications
             (user_id, type, title, message, data, status, created_at)
           VALUES (?, 'wallet_debit', 'Wallet debited', ?, ?, 'unread', NOW())`,
          [
            Number(user_id),
            `Nu. ${buyerTotalDebit.toFixed(2)} debited for order ${order_id}.`,
            JSON.stringify({
              order_id,
              order_amount: orderAmount,
              platform_fee_user: userPlatformFee,
              total_debited: buyerTotalDebit,
              payment_method: "WALLET",
            }),
          ],
        );
      }

      await sendPushToUserId(Number(user_id), {
        title: "Wallet debited",
        body:
          `Nu. ${buyerTotalDebit.toFixed(2)} debited for order ${order_id}. ` +
          `Order amount: Nu. ${orderAmount.toFixed(2)}` +
          (userPlatformFee > 0
            ? `, platform fee: Nu. ${userPlatformFee.toFixed(2)}.`
            : "."),
      });
    } catch (userNotifyErr) {
      console.error(
        "[ACCEPT WALLET USER NOTIFY FAILED]",
        userNotifyErr?.message || userNotifyErr,
      );
    }

    // =========================
    // 2. Merchant wallet credit/debit notification
    // =========================
    try {
      const merchantUserId = await resolveMerchantUserIdFromBusinessId(
        conn,
        capture.business_id,
      );

      if (merchantUserId) {
        const merchantNet = Number(
          orderAmount + merchantDeliveryFee - merchantPlatformFee,
        );

        const parts = [];

        parts.push(`Order ${order_id} accepted.`);

        if (orderAmount > 0) {
          parts.push(`Nu. ${orderAmount.toFixed(2)} credited to your wallet.`);
        }

        if (merchantDeliveryFee > 0) {
          parts.push(
            `Nu. ${merchantDeliveryFee.toFixed(2)} credited as delivery support.`,
          );
        }

        if (merchantPlatformFee > 0) {
          parts.push(
            `Nu. ${merchantPlatformFee.toFixed(2)} debited as platform fee.`,
          );
        }

        parts.push(`Net wallet change: Nu. ${merchantNet.toFixed(2)}.`);

        const merchantMessage = parts.join(" ");

        await conn.query(
          `INSERT INTO notifications
             (user_id, type, title, message, data, status, created_at)
           VALUES (?, 'wallet_update', 'Wallet updated', ?, ?, 'unread', NOW())`,
          [
            merchantUserId,
            merchantMessage,
            JSON.stringify({
              order_id,
              business_id: Number(capture.business_id),
              credited_order_amount: orderAmount,
              credited_merchant_delivery_fee: merchantDeliveryFee,
              debited_platform_fee_merchant: merchantPlatformFee,
              net_wallet_change: merchantNet,
              payment_method: "WALLET",
            }),
          ],
        );

        await sendPushToUserId(merchantUserId, {
          title: "Wallet updated",
          body: merchantMessage,
        });
      }
    } catch (merchantNotifyErr) {
      console.error(
        "[ACCEPT WALLET MERCHANT NOTIFY FAILED]",
        merchantNotifyErr?.message || merchantNotifyErr,
      );
    }
  } catch (e) {
    console.error("[safeNotifyWalletCaptureOnAccept ERROR]", e?.message || e);
  } finally {
    conn.release();
  }
}
/* ============================================================
   upload setup
============================================================ */

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const ORDERS_UPLOAD_DIR = path.join(UPLOAD_ROOT, "orders");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}
ensureDir(ORDERS_UPLOAD_DIR);

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function guessExtFromMime(mime) {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

const PUBLIC_UPLOAD_BASE =
  (process.env.PUBLIC_UPLOAD_BASE || "/uploads").replace(/\/+$/, "") + "/";

function toPublicUploadUrl(absPath) {
  const rel = path.relative(UPLOAD_ROOT, absPath).split(path.sep).join("/");
  return `${PUBLIC_UPLOAD_BASE}${rel}`;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const orderId = String(req.body?.order_id || req.generated_order_id || "")
      .trim()
      .toUpperCase();
    const safeId = orderId && /^ORD-\d{8}$/.test(orderId) ? orderId : "TMP";
    const dir = path.join(ORDERS_UPLOAD_DIR, safeId);
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext =
      path.extname(file.originalname) || guessExtFromMime(file.mimetype);
    const name = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, name);
  },
});

function fileFilter(_req, file, cb) {
  if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error("Only image files are allowed (jpg, png, webp)."));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 4 * 1024 * 1024),
    files: Number(process.env.UPLOAD_MAX_FILES || 10),
  },
});

const uploadOrderImages = upload.any();

/* ============================================================
   helpers
============================================================ */

const ALLOWED_STATUSES = new Set([
  "ASSIGNED",
  "PENDING",
  "DECLINED",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "PICKEDUP",
  "CANCELLED",
]);

function normalizeServiceType(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  return s || null;
}
function normalizePaymentMethod(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  return s || null;
}
function normalizeFulfillment(v) {
  const s = String(v || "Delivery").trim();
  return s || "Delivery";
}
function normalizeSpecialMode(v) {
  const s = String(v || "")
    .trim()
    .toUpperCase();
  if (!s) return null;
  if (s === "DROP_OFF" || s === "DROPOFF" || s === "DROP") return "DROP_OFF";
  if (s === "MEET_UP" || s === "MEETUP" || s === "MEET") return "MEET_UP";
  return null;
}

function buildPreview(items = [], total_amount) {
  const parts = items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.item_name}`);
  const more = items.length > 2 ? `, +${items.length - 2} more` : "";
  const totalStr = Number(total_amount ?? 0).toFixed(2);
  return `${parts.join(", ")}${more} · Total Nu ${totalStr}`;
}

function normalizeItemShape(raw = {}, idx = 0) {
  const it = raw && typeof raw === "object" ? raw : {};

  const business_id =
    it.business_id ??
    it.businessId ??
    it.businessID ??
    it.business?.id ??
    it.business?.business_id ??
    it.business?.businessId ??
    null;

  const business_name =
    it.business_name ??
    it.businessName ??
    it.business?.name ??
    it.business?.business_name ??
    null;

  const menu_id =
    it.menu_id ??
    it.menuId ??
    it.product_id ??
    it.productId ??
    it.product?.id ??
    it.menu?.id ??
    it.item?.id ??
    null;

  const item_name =
    it.item_name ??
    it.name ??
    it.itemName ??
    it.product?.name ??
    it.menu?.name ??
    it.item?.name ??
    null;

  const quantity =
    it.quantity ?? it.qty ?? it.count ?? it.units ?? it.unit_count ?? null;
  const price =
    it.price ?? it.unit_price ?? it.unitPrice ?? it.rate ?? it.cost ?? null;

  const subtotal =
    it.subtotal ??
    it.line_subtotal ??
    it.lineSubtotal ??
    it.line_total ??
    it.lineTotal ??
    (quantity != null && price != null
      ? Number(quantity) * Number(price)
      : null);

  const item_image =
    it.item_image ??
    it.image ??
    it.itemImage ??
    it.product?.image ??
    it.product?.image_url ??
    it.menu?.image ??
    it.item?.image ??
    null;

  return {
    ...it,
    business_id,
    business_name,
    menu_id,
    item_name,
    item_image,
    quantity,
    price,
    subtotal,
    _index: idx,
  };
}

function mapUploadedFilesToPayload(req, order_id, items) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { order_images: [], item_images: new Map() };

  const tmpDir = path.join(ORDERS_UPLOAD_DIR, "TMP");
  const finalDir = path.join(ORDERS_UPLOAD_DIR, order_id);
  ensureDir(finalDir);

  const orderImages = [];
  const itemImages = new Map();

  for (const f of files) {
    const field = String(f.fieldname || "");
    let absPath = f.path;

    try {
      if (absPath && absPath.startsWith(tmpDir + path.sep)) {
        const dest = path.join(finalDir, path.basename(absPath));
        fs.renameSync(absPath, dest);
        absPath = dest;
      }
    } catch {}

    const url = absPath ? toPublicUploadUrl(absPath) : null;
    if (!url) continue;

    if (
      field === "order_images" ||
      field === "order_image" ||
      field === "images"
    ) {
      orderImages.push(url);
      continue;
    }

    const idxMatch = field.match(/^item_image_(\d+)$/);
    if (idxMatch) {
      itemImages.set(Number(idxMatch[1]), url);
      continue;
    }

    const midMatch = field.match(/^item_image_(\d{1,10})$/);
    if (midMatch) {
      itemImages.set(String(midMatch[1]), url);
      continue;
    }
  }

  for (const it of items) {
    const idx = Number(it._index);
    const menuId = it.menu_id != null ? String(it.menu_id) : null;

    if (itemImages.has(idx)) it.item_image = itemImages.get(idx);
    else if (menuId && itemImages.has(menuId))
      it.item_image = itemImages.get(menuId);
  }

  return { order_images: orderImages, item_images: itemImages };
}

function parseMaybeJSON(v) {
  if (v == null) return v;
  if (typeof v !== "string") return v;

  const s = v.trim();
  if (!s) return v;
  if (!(s.startsWith("{") || s.startsWith("["))) return v;

  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function getOrderInput(req) {
  let body = req.body || {};

  if (typeof body.payload === "string") {
    const p = parseMaybeJSON(body.payload);
    if (p && typeof p === "object") body = p;
  }

  body.items = parseMaybeJSON(body.items);
  body.delivery_address = parseMaybeJSON(body.delivery_address);

  const numFields = [
    "user_id",
    "total_amount",
    "discount_amount",
    "platform_fee",
    "delivery_fee",
    "merchant_delivery_fee",
  ];
  for (const k of numFields) {
    if (body[k] != null && body[k] !== "") body[k] = Number(body[k]);
  }

  return body;
}

function dedupeStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const s = (x == null ? "" : String(x)).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/* ============================================================
   controllers
============================================================ */

async function createOrder(req, res) {
  const safeUnlink = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  };

  const cleanupUploadedFiles = () => {
    try {
      const files = [];

      if (Array.isArray(req.files)) {
        files.push(...req.files);
      }

      if (
        req.files &&
        typeof req.files === "object" &&
        !Array.isArray(req.files)
      ) {
        Object.values(req.files).forEach((value) => {
          if (Array.isArray(value)) files.push(...value);
        });
      }

      if (Array.isArray(req.deliveryPhotos)) {
        files.push(...req.deliveryPhotos);
      }

      const seen = new Set();

      for (const f of files) {
        const p = f?.path;
        if (!p || seen.has(p)) continue;
        seen.add(p);
        safeUnlink(p);
      }
    } catch {}
  };

  try {
    const payload = getOrderInput(req);

    const itemsRaw = Array.isArray(payload.items) ? payload.items : [];
    if (!itemsRaw.length) {
      cleanupUploadedFiles();
      return res.status(400).json({ ok: false, message: "Missing items" });
    }

    if (!payload.user_id || !Number.isFinite(Number(payload.user_id))) {
      cleanupUploadedFiles();
      return res.status(400).json({ ok: false, message: "Missing user_id" });
    }

    const serviceType = normalizeServiceType(payload.service_type);
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: "Invalid or missing service_type. Allowed: FOOD, MART",
      });
    }

    const payMethod = normalizePaymentMethod(payload.payment_method);
    if (!payMethod || payMethod !== "WALLET") {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: "Invalid or missing payment_method. Allowed: WALLET",
      });
    }

    const normalizedItems = itemsRaw.map((it, idx) =>
      normalizeItemShape(it, idx),
    );

    const order_id = String(
      payload.order_id ||
        (generateOrderId ? generateOrderId() : `ORD-${Date.now()}`),
    )
      .trim()
      .toUpperCase();
    payload.order_id = order_id;

    const moved = mapUploadedFilesToPayload(req, order_id, normalizedItems);

    const uploadedOrderPhotos = Array.isArray(moved.order_images)
      ? moved.order_images
      : [];

    // Photos uploaded through middleware/uploadDeliveryPhoto.js
    // This is the correct source when route uses uploadDeliveryPhotos.
    const uploadedDeliveryPhotos = toWebPaths(req.deliveryPhotos || []);
    payload.delivery_floor_unit =
      payload.delivery_floor_unit ??
      payload.floor_unit ??
      payload.floorUnit ??
      null;
    payload.delivery_instruction_note =
      payload.delivery_instruction_note ??
      payload.special_instructions ??
      payload.delivery_note ??
      null;
    payload.delivery_special_mode = normalizeSpecialMode(
      payload.delivery_special_mode ?? payload.special_mode,
    );

    const fulfillment = normalizeFulfillment(payload.fulfillment_type);

    if (
      payload.delivery_address &&
      typeof payload.delivery_address === "object"
    ) {
      payload.delivery_address = JSON.stringify(payload.delivery_address);
    }

    const bodyList = Array.isArray(payload.delivery_photo_urls)
      ? payload.delivery_photo_urls
      : [];
    const bodySingle = payload.delivery_photo_url
      ? [payload.delivery_photo_url]
      : [];

    const allPhotos = dedupeStrings([
      ...bodyList,
      ...bodySingle,
      ...uploadedOrderPhotos,
      ...uploadedDeliveryPhotos,
    ]);

    if (allPhotos.length > MAX_PHOTOS) {
      cleanupUploadedFiles();
      return res.status(400).json({
        ok: false,
        message: `Maximum ${MAX_PHOTOS} photos are allowed.`,
        received: allPhotos.length,
      });
    }

    payload.delivery_photo_urls = allPhotos;
    payload.delivery_photo_url = allPhotos.length ? allPhotos[0] : null;

    // wallet balance check
    {
      const itemsSubtotal = normalizedItems.reduce(
        (s, it) =>
          s +
          Number(
            it.subtotal ||
              Number(it.quantity || 0) * Number(it.price || 0) ||
              0,
          ),
        0,
      );
      const deliveryFee = Number(payload.delivery_fee || 0);
      const discount = Number(payload.discount_amount || 0);
      const platformFee = Number(payload.platform_fee || 0);
      const computedTotal = Number(
        (itemsSubtotal + deliveryFee - discount + platformFee).toFixed(2),
      );

      const required =
        payload.total_amount != null && payload.total_amount !== ""
          ? Number(payload.total_amount)
          : computedTotal;

      const [[w]] = await db.query(
        `SELECT amount FROM wallets WHERE user_id = ? LIMIT 1`,
        [Number(payload.user_id)],
      );
      const balance = Number(w?.amount || 0);

      if (!Number.isFinite(required) || required <= 0) {
        cleanupUploadedFiles();
        return res.status(400).json({
          ok: false,
          code: "INVALID_TOTAL",
          message: "Invalid total_amount for wallet payment.",
        });
      }

      if (balance < required) {
        cleanupUploadedFiles();
        return res.status(400).json({
          ok: false,
          code: "INSUFFICIENT_WALLET_BALANCE",
          message:
            "Unable to place order because wallet balance is insufficient.",
          wallet_balance: Number(balance.toFixed(2)),
          required_total_amount: Number(required.toFixed(2)),
        });
      }
    }

    const status = String(payload.status || "PENDING")
      .trim()
      .toUpperCase();

    if (typeof createDb !== "function") {
      throw new Error("create() model function not found/exported.");
    }

    const created_id =
      createDb.length >= 2
        ? await createDb(db, {
            ...payload,
            service_type: serviceType,
            payment_method: "WALLET",
            fulfillment_type: fulfillment,
            status,
            items: normalizedItems,
          })
        : await createDb({
            ...payload,
            service_type: serviceType,
            payment_method: "WALLET",
            fulfillment_type: fulfillment,
            status,
            items: normalizedItems,
          });

    // business ids
    const byBiz = new Map();
    for (const it of normalizedItems) {
      const bid = Number(it.business_id);
      if (!bid || Number.isNaN(bid)) continue;
      if (!byBiz.has(bid)) byBiz.set(bid, []);
      byBiz.get(bid).push(it);
    }
    const businessIds = Array.from(byBiz.keys());

    // DB + socket notifications for merchants
    for (const business_id of businessIds) {
      const its = byBiz.get(business_id) || [];
      const title = `New order #${created_id}`;
      const preview = buildPreview(its, payload.total_amount);

      try {
        await insertAndEmitNotification({
          business_id,
          user_id: payload.user_id,
          order_id: created_id,
          type: "order:create",
          title,
          body_preview: preview,
        });
      } catch (e) {
        console.error("[NOTIFY INSERT FAILED]", {
          order_id: created_id,
          business_id,
          err: e?.message,
        });
      }
    }

    // PUSH merchants
    try {
      const merchantUserIds =
        await getMerchantUserIdsByBusinessIds(businessIds);
      const title = `New order ${created_id}`;
      const bodyText = buildPreview(normalizedItems, payload.total_amount);

      for (const merchantUserId of merchantUserIds) {
        await sendPushToUserId(merchantUserId, { title, body: bodyText });
      }
    } catch (e) {
      console.error("[PUSH merchants new order FAILED]", e?.message || e);
    }

    broadcastOrderStatusToMany({
      order_id: created_id,
      user_id: payload.user_id,
      business_ids: businessIds,
      status,
    });

    return res.status(201).json({
      ok: true,
      order_id: created_id,
      delivery_photo_urls: payload.delivery_photo_urls || [],
      delivery_photo_url: payload.delivery_photo_url || null,
      delivery_floor_unit: payload.delivery_floor_unit || null,
      delivery_instruction_note: payload.delivery_instruction_note || null,
      delivery_special_mode: payload.delivery_special_mode || null,
    });
  } catch (err) {
    console.error("[createOrder ERROR]", err);
    cleanupUploadedFiles();
    return res.status(500).json({
      ok: false,
      message: "Unable to place order",
      error: err?.message || "Unknown error",
    });
  }
}

async function getOrders(_req, res) {
  try {
    if (typeof findAllDb !== "function")
      throw new Error("findAll() model function not found/exported.");
    const orders =
      findAllDb.length >= 1 ? await findAllDb(db) : await findAllDb();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrderById(req, res) {
  try {
    if (typeof findByOrderIdGroupedDb !== "function")
      throw new Error(
        "findByOrderIdGrouped() model function not found/exported.",
      );

    const grouped =
      findByOrderIdGroupedDb.length >= 2
        ? await findByOrderIdGroupedDb(db, req.params.order_id)
        : await findByOrderIdGroupedDb(req.params.order_id);

    if (!grouped.length)
      return res.status(404).json({ message: "Order not found" });
    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrdersByBusinessId(req, res) {
  try {
    if (typeof findByBusinessIdDb !== "function")
      throw new Error("findByBusinessId() model function not found/exported.");

    const items =
      findByBusinessIdDb.length >= 2
        ? await findByBusinessIdDb(db, req.params.business_id)
        : await findByBusinessIdDb(req.params.business_id);

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getBusinessOrdersGroupedByUser(req, res) {
  try {
    if (typeof findByBusinessGroupedByUserDb !== "function")
      throw new Error(
        "findByBusinessGroupedByUser() model function not found/exported.",
      );

    const data =
      findByBusinessGroupedByUserDb.length >= 2
        ? await findByBusinessGroupedByUserDb(db, req.params.business_id)
        : await findByBusinessGroupedByUserDb(req.params.business_id);

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getOrdersForUser(req, res) {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id" });
    }

    const qs = String(req.query?.service_type || "").trim();
    if (qs) {
      const st = qs.toUpperCase();
      if (!["FOOD", "MART"].includes(st)) {
        return res.status(400).json({
          success: false,
          message: "Invalid service_type filter. Allowed: FOOD, MART",
        });
      }
    }

    if (typeof findByUserIdForAppDb !== "function")
      throw new Error(
        "findByUserIdForApp() model function not found/exported.",
      );

    let data;
    if (findByUserIdForAppDb.length >= 3) {
      data = await findByUserIdForAppDb(
        db,
        userId,
        qs ? qs.toUpperCase() : null,
      );
    } else if (findByUserIdForAppDb.length >= 2) {
      data = await findByUserIdForAppDb(userId, qs ? qs.toUpperCase() : null);
    } else {
      data = await findByUserIdForAppDb(userId);
      if (qs) {
        const st = qs.toUpperCase();
        data = Array.isArray(data)
          ? data.filter(
              (o) => String(o.service_type || "").toUpperCase() === st,
            )
          : [];
      }
    }

    // ✅ If business_logo is missing, fetch it from merchant_business_details
    if (data && data.length) {
      const businessIds = new Set();
      for (const order of data) {
        if (order.business_details?.business_id) {
          businessIds.add(order.business_details.business_id);
        }
      }

      if (businessIds.size) {
        const [logos] = await db.query(
          `SELECT business_id, business_logo 
           FROM merchant_business_details 
           WHERE business_id IN (?)`,
          [Array.from(businessIds)],
        );

        const logoMap = new Map();
        for (const logo of logos) {
          logoMap.set(Number(logo.business_id), logo.business_logo);
        }

        // Attach logo to each order
        for (const order of data) {
          if (order.business_details?.business_id) {
            order.business_details.business_logo =
              logoMap.get(order.business_details.business_id) || null;
          }
        }
      }
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function updateOrder(req, res) {
  try {
    if (typeof updateDb !== "function")
      throw new Error("update() model function not found/exported.");

    const affectedRows =
      updateDb.length >= 3
        ? await updateDb(db, req.params.order_id, req.body)
        : await updateDb(req.params.order_id, req.body);

    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function updateEstimatedArrivalTime(order_id, estimated_minutes) {
  try {
    const mins = Number(estimated_minutes);
    if (!Number.isFinite(mins) || mins <= 0)
      throw new Error("Invalid estimated minutes");

    const now = new Date();
    const startDate = new Date(now.getTime() + mins * 60 * 1000);
    const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

    const BHUTAN_OFFSET_HOURS = 6;

    const toBhutanParts = (d) => {
      const hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
      const minute = d.getUTCMinutes();
      const meridiem = hour24 >= 12 ? "PM" : "AM";
      const hour12 = hour24 % 12 || 12;
      return { hour12, minute, meridiem };
    };

    const s = toBhutanParts(startDate);
    const e = toBhutanParts(endDate);

    const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
    const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

    const formattedRange =
      s.meridiem === e.meridiem
        ? `${sStr} - ${eStr} ${s.meridiem}`
        : `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`;

    await db.query(
      `UPDATE orders SET estimated_arrivial_time = ? WHERE order_id = ?`,
      [formattedRange, order_id],
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

/**
 * PUT /orders/:order_id/status
 */
async function updateOrderStatus(req, res) {
  try {
    const order_id = String(req.params.order_id || "")
      .trim()
      .toUpperCase();
    const body = req.body || {};
    const { status, reason, estimated_minutes, cancelled_by, delivered_by } =
      body;

    if (typeof status !== "string" || !status.trim()) {
      return res.status(400).json({ message: "Status is required" });
    }

    const normalizedRaw = status.trim().toUpperCase();
    const normalized =
      normalizedRaw === "COMPLETED" ? "DELIVERED" : normalizedRaw;

    if (!ALLOWED_STATUSES.has(normalized)) {
      return res.status(400).json({
        message: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUSES).join(", ")}`,
        received: normalizedRaw,
        normalized,
      });
    }

    const [[row]] = await db.query(
      `SELECT user_id, status AS current_status
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
    );

    if (!row) return res.status(404).json({ message: "Order not found" });

    const user_id = Number(row.user_id);
    const current = String(row.current_status || "PENDING").toUpperCase();
    const finalReason = String(reason || "").trim();

    const [bizRows] = await db.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id],
    );
    const business_ids = bizRows
      .map((r) => Number(r.business_id))
      .filter((n) => Number.isFinite(n) && n > 0);

    // DELIVERED pipeline
    if (normalized === "DELIVERED") {
      req.body = {
        ...(req.body || {}),
        order_id,
        delivered_by: delivered_by || "SYSTEM",
        reason: finalReason || "",
      };
      return markOrderDelivered(req, res);
    }

    // PICKEDUP pipeline (customer pickup)
    if (normalized === "PICKEDUP") {
      const pickedup_by = body.pickedup_by || "CUSTOMER";

      // Update order status only (don't migrate yet)
      await db.query(
        `UPDATE orders 
     SET pickedup_by = ?, 
         pickedup_at = NOW(),
         status = 'PICKEDUP',
         updated_at = NOW()
     WHERE order_id = ?`,
        [pickedup_by, order_id],
      );

      // ✅ Fetch order details and SEND EMAIL IMMEDIATELY
      try {
        // Get order details
        const [[order]] = await db.query(
          `SELECT * FROM orders WHERE order_id = ?`,
          [order_id],
        );

        // Get user
        const [users] = await db.query(
          `SELECT user_id, user_name, email, phone FROM users WHERE user_id = ?`,
          [order.user_id],
        );

        // Get items
        const [items] = await db.query(
          `SELECT oi.*, COALESCE(fm.item_name, 'Item') as menu_name
       FROM order_items oi
       LEFT JOIN food_menu fm ON oi.menu_id = fm.id
       WHERE oi.order_id = ?`,
          [order_id],
        );

        // Get business
        const [businesses] = await db.query(
          `SELECT business_id, business_name, address, business_logo
       FROM merchant_business_details 
       WHERE business_id = ?`,
          [order.business_id],
        );

        const business = businesses[0] || {};
        const user = users[0] || {};

        // Calculate totals
        const subtotal = items.reduce((sum, item) => {
          const price = parseFloat(item.price) || 0;
          const quantity = parseInt(item.quantity) || 0;
          return sum + price * quantity;
        }, 0);
        const grandTotal = parseFloat(order.total_amount) || subtotal;
        // Get platform_fee from order
        const platformFee = parseFloat(order.platform_fee) || 0;
        const discountAmount = parseFloat(order.discount_amount) || 0;

        // Build order data
        const orderData = {
          order_id: order.order_id,
          created_at: order.created_at,
          pickedup_at: order.pickedup_at,
          payment_method: order.payment_method,
          pickup_address: order.delivery_address,
          customer_name: user.user_name,
          customer_email: user.email,
          customer_phone: user.phone,
          business_name: business.business_name,
          business_logo: business.business_logo,
          business_address: business.address,
          platform_fee: platformFee, // ✅ Add this
          discount_amount: discountAmount, // ✅ Add this
          items: items.map((item) => ({
            menu_name: item.menu_name,
            quantity: item.quantity,
            price_per_unit: item.price,
            subtotal:
              (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0),
          })),
          subtotal: subtotal,
          grand_total: grandTotal,
        };

        // Send email immediately
        const emailResult =
          await PickupEmailService.sendPickupReceipt(orderData);

        if (emailResult.success) {
          // Save to receipt_email
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, user_name, business_name, receipt_sent, receipt_sent_at, email_status, delivery_method)
         VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), 'sent', 'PICKUP')
         ON DUPLICATE KEY UPDATE 
         receipt_sent = 1, receipt_sent_at = NOW(), email_status = 'sent'`,
            [
              order_id,
              order.user_id,
              order.business_id,
              user.email,
              user.user_name,
              business.business_name,
            ],
          );
          console.log(
            `[PICKEDUP] Email sent immediately for order ${order_id}`,
          );
        } else {
          console.error(
            `[PICKEDUP] Email failed for order ${order_id}:`,
            emailResult.error,
          );
          await db.query(
            `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, email_status, error_message, delivery_method)
         VALUES (?, ?, ?, ?, 'failed', ?, 'PICKUP')
         ON DUPLICATE KEY UPDATE email_status = 'failed', error_message = ?`,
            [
              order_id,
              order.user_id,
              order.business_id,
              user.email,
              emailResult.error,
              emailResult.error,
            ],
          );
        }

        // Send push notification
        await sendPushToUserId(order.user_id, {
          title: "✅ Order Picked Up Successfully",
          body: `You have successfully picked up your order ${order_id}. Thank you for shopping with us!`,
        });
      } catch (emailError) {
        console.error("[PICKEDUP] Failed to send email:", emailError);
      }

      return res.json({
        success: true,
        message: "Order marked as picked up. Receipt sent to customer.",
        order_id,
        status: "PICKEDUP",
      });
    }
    // CONFIRMED with unavailable changes
   if (normalized === "CONFIRMED") {
  const locked = new Set(["DELIVERED", "CANCELLED"]);

  if (locked.has(current)) {
    return res.status(400).json({
      success: false,
      message: `Order cannot be confirmed because it is already ${current}.`,
    });
  }

  const conn = await db.getConnection();

  let result = null;
  let captureResult = null;

  try {
    await conn.beginTransaction();

    // 1. Apply unavailable changes + status CONFIRMED inside same transaction
    result = await updateStatusWithUnavailable(
      order_id,
      {
        status: "CONFIRMED",
        reason: finalReason,
        estimated_minutes: body.estimated_minutes ?? estimated_minutes,
        final_total_amount: body.final_total_amount,
        final_platform_fee: body.final_platform_fee,
        final_discount_amount: body.final_discount_amount,
        final_delivery_fee: body.final_delivery_fee,
        final_merchant_delivery_fee: body.final_merchant_delivery_fee,
        unavailable_changes:
          body.unavailable_changes && typeof body.unavailable_changes === "object"
            ? body.unavailable_changes
            : { removed: [], replaced: [] },
      },
      conn,
    );

    if (!result?.ok) {
      await conn.rollback();

      if (result?.code === "NOT_FOUND") {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      return res.status(400).json({
        success: false,
        message: result?.code || "Unable to confirm order",
        data: result || null,
      });
    }

    // 2. Capture wallet inside same transaction
    captureResult = await captureOnAccept(order_id, conn);

    const captureOk =
      captureResult?.ok === true &&
      (
        captureResult?.capture?.captured === true ||
        captureResult?.capture?.alreadyCaptured === true ||
        captureResult?.capture?.skipped === true
      );

    if (!captureOk) {
      throw new Error(
        captureResult?.error ||
          captureResult?.code ||
          "Wallet capture failed during order acceptance.",
      );
    }

    // 3. Insert merchant earning inside same transaction
    const capture = captureResult.capture || {};

    if (
      capture?.captured === true &&
      String(capture.payment_method || "WALLET").toUpperCase() === "WALLET"
    ) {
      const businessId = Number(capture.business_id);
      const orderAmount = Number(capture.order_amount || 0);
      const merchantPlatformFee = Number(capture.platform_fee_merchant || 0);
      const merchantDeliveryFee = Number(capture.merchant_delivery_fee || 0);

      const merchantEarningAmount = Number(
        (orderAmount + merchantDeliveryFee - merchantPlatformFee).toFixed(2),
      );

      if (
        Number.isFinite(businessId) &&
        businessId > 0 &&
        Number.isFinite(merchantEarningAmount) &&
        merchantEarningAmount >= 0
      ) {
        await conn.query(
          `INSERT INTO merchant_earnings
             (business_id, date, total_amount, order_id)
           VALUES (?, DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+06:00')), ?, ?)
           ON DUPLICATE KEY UPDATE
             business_id = VALUES(business_id),
             date = VALUES(date),
             total_amount = VALUES(total_amount)`,
          [businessId, merchantEarningAmount, order_id],
        );
      }
    }

    // 4. Everything succeeded
    await conn.commit();
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}

    console.error("[CONFIRMED ACCEPT TRANSACTION ROLLED BACK]", {
      order_id,
      error: err?.message || err,
    });

    return res.status(400).json({
      success: false,
      message:
        "Order could not be accepted because wallet transaction failed. All order changes have been reverted.",
      code: "ACCEPT_ROLLED_BACK",
      error: err?.message || String(err),
    });
  } finally {
    conn.release();
  }

  // After commit only: notifications/socket/push
  console.log("[CONFIRMED ACCEPT SUCCESS]", {
    order_id,
    capture: captureResult.capture,
  });

  await safeNotifyWalletCaptureOnAccept({
    order_id,
    user_id,
    capture: captureResult.capture,
  });

  try {
    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: "CONFIRMED",
    });
  } catch {}

  for (const business_id of business_ids) {
    try {
      await insertAndEmitNotification({
        business_id,
        user_id,
        order_id,
        type: "order:status",
        title: `Order #${order_id} CONFIRMED`,
        body_preview: result?.estimated_arrivial_time
          ? `ETA: ${result.estimated_arrivial_time}`
          : "Order accepted by merchant.",
      });
    } catch (e) {
      console.error("[merchant notify failed]", {
        order_id,
        business_id,
        err: e?.message,
      });
    }
  }

  try {
    const eta = result?.estimated_arrivial_time
      ? ` ETA: ${result.estimated_arrivial_time}`
      : "";

    await sendPushToUserId(user_id, {
      title: "Order Update",
      body: `Your order ${order_id} has been confirmed.${eta}`,
    });
  } catch {}

  try {
    if (typeof addUserOrderStatusNotification === "function") {
      await addUserOrderStatusNotification({
        user_id,
        order_id,
        status: "CONFIRMED",
        reason: finalReason,
      });
    }
  } catch (e) {
    console.error("[user notify failed]", {
      order_id,
      err: e?.message,
    });
  }

  return res.json({
    success: true,
    message: "Order confirmed successfully. Wallet transaction completed.",
    order_id,
    status: "CONFIRMED",
    data: result,
    wallet_capture: captureResult.capture,
  });
}

    // CANCEL restriction
    if (normalized === "CANCELLED") {
      const locked = new Set([
        "CONFIRMED",
        "PREPARING",
        "READY",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ]);
      if (locked.has(current)) {
        return res.status(400).json({
          message:
            "Order cannot be cancelled after it has been accepted by the merchant.",
        });
      }
    }

    // ETA update
    if (estimated_minutes != null) {
      await updateEstimatedArrivalTime(order_id, estimated_minutes);
    }

    if (typeof updateStatusDb !== "function")
      throw new Error("updateStatus() model function not found/exported.");

    const affected =
      updateStatusDb.length >= 4
        ? await updateStatusDb(db, order_id, normalized, finalReason)
        : await updateStatusDb(order_id, normalized, finalReason);

    if (!affected) return res.status(404).json({ message: "Order not found" });

    broadcastOrderStatusToMany({
      order_id,
      user_id,
      business_ids,
      status: normalized,
    });

    for (const business_id of business_ids) {
      try {
        await insertAndEmitNotification({
          business_id,
          user_id,
          order_id,
          type: "order:status",
          title: `Order #${order_id} ${normalized}`,
          body_preview: finalReason || `Status updated to ${normalized}.`,
        });
      } catch (e) {
        console.error("[merchant notify failed]", {
          order_id,
          business_id,
          err: e?.message,
        });
      }
    }

    try {
      await sendPushToUserId(user_id, {
        title: "Order Update",
        body:
          `Your order ${order_id} has been ${normalized.toLowerCase().replace(/_/g, " ")}.` +
          (finalReason ? ` Reason: ${finalReason}` : ""),
      });
    } catch {}

    try {
      const merchantUserIds =
        await getMerchantUserIdsByBusinessIds(business_ids);
      for (const merchantUserId of merchantUserIds) {
        await sendPushToUserId(merchantUserId, {
          title: "Order Update",
          body:
            `Order ${order_id} is now ${normalized}.` +
            (finalReason ? ` Reason: ${finalReason}` : ""),
        });
      }
    } catch {}

    try {
      if (typeof addUserOrderStatusNotification === "function") {
        await addUserOrderStatusNotification({
          user_id,
          order_id,
          status: normalized,
          reason: finalReason,
        });
      }
    } catch (e) {
      console.error("[user notify failed]", { order_id, err: e?.message });
    }

    if (normalized === "CANCELLED") {
      const by =
        String(cancelled_by || "SYSTEM")
          .trim()
          .toUpperCase() || "SYSTEM";
      return res.json({
        success: true,
        message: "Order cancelled successfully.",
        order_id,
        status: "CANCELLED",
        cancelled_by: by,
      });
    }

    return res.json({
      success: true,
      message: "Order status updated successfully",
      order_id,
      status: normalized,
    });
  } catch (err) {
    console.error("[updateOrderStatus ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
}

async function deleteOrder(req, res) {
  try {
    if (typeof deleteDb !== "function")
      throw new Error("delete() model function not found/exported.");

    const affectedRows =
      deleteDb.length >= 2
        ? await deleteDb(db, req.params.order_id)
        : await deleteDb(req.params.order_id);

    if (!affectedRows)
      return res.status(404).json({ message: "Order not found" });
    res.json({ message: "Order deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOrderStatusCountsByBusiness(req, res) {
  try {
    const business_id = Number(req.params.business_id);
    if (!Number.isFinite(business_id) || business_id <= 0) {
      return res.status(400).json({ message: "Invalid business_id" });
    }

    if (typeof getOrderStatusCountsByBusinessDb !== "function")
      throw new Error(
        "getOrderStatusCountsByBusiness() model function not found/exported.",
      );

    const counts =
      getOrderStatusCountsByBusinessDb.length >= 2
        ? await getOrderStatusCountsByBusinessDb(db, business_id)
        : await getOrderStatusCountsByBusinessDb(business_id);

    return res.json(counts);
  } catch (err) {
    console.error("[getOrderStatusCountsByBusiness]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function cancelOrderByUser(req, res) {
  try {
    const user_id_param = Number(req.params.user_id);
    const order_id = req.params.order_id;
    const body = req.body || {};
    const userReason = String(body.reason || "").trim();

    if (!Number.isFinite(user_id_param) || user_id_param <= 0) {
      return res.status(400).json({ message: "Invalid user_id" });
    }

    const reason =
      userReason.length > 0
        ? `Cancelled by customer: ${userReason}`
        : "Cancelled by customer before the store accepted the order.";

    if (typeof cancelAndArchiveOrder !== "function")
      throw new Error("cancelAndArchiveOrder() pipeline not found/exported.");

    const out =
      cancelAndArchiveOrder.length >= 3
        ? await cancelAndArchiveOrder(db, order_id, {
            cancelled_by: "USER",
            reason,
            onlyIfStatus: "PENDING",
            expectedUserId: user_id_param,
          })
        : await cancelAndArchiveOrder(order_id, {
            cancelled_by: "USER",
            reason,
            onlyIfStatus: "PENDING",
            expectedUserId: user_id_param,
          });

    if (!out?.ok) {
      if (out?.code === "NOT_FOUND")
        return res.status(404).json({ message: "Order not found" });
      if (out?.code === "FORBIDDEN")
        return res
          .status(403)
          .json({ message: "You are not allowed to cancel this order." });

      if (out?.code === "SKIPPED") {
        return res.status(400).json({
          code: "CANNOT_CANCEL_AFTER_ACCEPT",
          message:
            "This order can no longer be cancelled because the store has already accepted it.",
          current_status: out.current_status,
        });
      }

      return res.status(400).json({ message: "Unable to cancel this order." });
    }

    broadcastOrderStatusToMany({
      order_id,
      user_id: out.user_id,
      business_ids: out.business_ids,
      status: "CANCELLED",
    });

    for (const business_id of out.business_ids || []) {
      try {
        await insertAndEmitNotification({
          business_id,
          user_id: out.user_id,
          order_id,
          type: "order:status",
          title: `Order #${order_id} CANCELLED`,
          body_preview: "Customer cancelled the order before acceptance.",
        });
      } catch (e) {
        console.error("[cancelOrderByUser notify merchant failed]", {
          order_id,
          business_id,
          err: e?.message,
        });
      }
    }

    try {
      await sendPushToUserId(out.user_id, {
        title: "Order Update",
        body: `Your order ${order_id} has been cancelled.${reason ? ` Reason: ${reason}` : ""}`,
      });
    } catch {}

    try {
      if (typeof addUserOrderStatusNotification === "function") {
        await addUserOrderStatusNotification({
          user_id: out.user_id,
          order_id,
          status: "CANCELLED",
          reason,
        });
      }
    } catch (e) {
      console.error("[cancelOrderByUser notify user failed]", {
        order_id,
        user_id: out.user_id,
        err: e?.message,
      });
    }

    return res.json({
      success: true,
      message: "Your order has been cancelled successfully.",
      order_id,
      status: "CANCELLED",
    });
  } catch (err) {
    console.error("[cancelOrderByUser ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
}

async function markOrderDelivered(req, res) {
  const order_id = String(req.params.order_id || req.body?.order_id || "")
    .trim()
    .toUpperCase();
  const delivered_by = String(req.body?.delivered_by || "SYSTEM").trim();
  const reason = String(req.body?.reason || "").trim();

  if (!order_id) {
    return res
      .status(400)
      .json({ success: false, message: "order_id is required" });
  }

  try {
    // ✅ STEP 1: Update order status to DELIVERED
    await db.query(
      `UPDATE orders 
       SET status = 'DELIVERED', 
           delivered_at = NOW(),
           updated_at = NOW()
       WHERE order_id = ?`,
      [order_id],
    );

    console.log(
      `[DELIVERED] Order ${order_id} marked as delivered by ${delivered_by}`,
    );

    // ✅ STEP 2: Fetch order details
    const [[order]] = await db.query(
      `SELECT * FROM orders WHERE order_id = ?`,
      [order_id],
    );

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // ✅ STEP 3: Fetch user details
    const [users] = await db.query(
      `SELECT user_id, user_name, email, phone FROM users WHERE user_id = ?`,
      [order.user_id],
    );

    const user = users[0] || {};

    if (!user.email) {
      console.error(`[DELIVERED] No email found for user ${order.user_id}`);
    }

    // ✅ STEP 4: Fetch order items
    const [items] = await db.query(
      `SELECT oi.*, COALESCE(fm.item_name, 'Item') as menu_name
       FROM order_items oi
       LEFT JOIN food_menu fm ON oi.menu_id = fm.id
       WHERE oi.order_id = ?`,
      [order_id],
    );

    if (!items.length) {
      console.error(`[DELIVERED] No items found for order ${order_id}`);
    }

    // ✅ STEP 5: Fetch business details
    const [businesses] = await db.query(
      `SELECT business_id, business_name, address, business_logo
       FROM merchant_business_details 
       WHERE business_id = ?`,
      [order.business_id],
    );

    const business = businesses[0] || {};

    // ✅ STEP 6: Calculate totals
    const subtotal = items.reduce((sum, item) => {
      const price = parseFloat(item.price) || 0;
      const quantity = parseInt(item.quantity) || 0;
      return sum + price * quantity;
    }, 0);

    const deliveryFee = parseFloat(order.delivery_fee) || 0;
    const platformFee = parseFloat(order.platform_fee) || 0;
    const discountAmount = parseFloat(order.discount_amount) || 0; // ✅ ADD THIS
    const merchantDeliveryFee = parseFloat(order.merchant_delivery_fee) || 0; // ✅ ADD THIS
    const grandTotal = parseFloat(order.total_amount) || subtotal;

    // ✅ STEP 7: Handle business logo URL
    let businessLogo = null;
    if (business.business_logo) {
      let logo = business.business_logo;
      if (logo.startsWith("/uploads/")) {
        businessLogo = `https://backend.tabdhey.bt/merchant${logo}`;
      } else if (logo.startsWith("http")) {
        businessLogo = logo;
      } else {
        businessLogo = `https://backend.tabdhey.bt/merchant/uploads/logos/${logo}`;
      }
    }

    // ✅ STEP 8: Parse delivery address
    let deliveryAddress = order.delivery_address || "N/A";
    if (deliveryAddress !== "N/A" && typeof deliveryAddress === "string") {
      try {
        const parsed = JSON.parse(deliveryAddress);
        deliveryAddress = parsed.address || deliveryAddress;
      } catch (e) {}
    }

    // ✅ STEP 9: Build order data for email
    const orderData = {
      order_id: order.order_id,
      delivered_at: order.delivered_at || new Date(),
      payment_method: order.payment_method,
      delivery_address: deliveryAddress,
      status: "DELIVERED",
      customer_name: user.user_name || "Customer",
      customer_email: user.email,
      customer_phone: user.phone || "N/A",
      business_name: business.business_name || "TàbDey",
      business_logo: businessLogo,
      business_address: business.address || "Thimphu, Bhutan",
      items: items.map((item) => ({
        menu_name: item.menu_name,
        quantity: parseInt(item.quantity) || 0,
        price_per_unit: parseFloat(item.price) || 0,
        subtotal:
          (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0),
      })),
      subtotal: subtotal,
      delivery_fee: deliveryFee,
      platform_fee: platformFee,
      discount_amount: discountAmount, // ✅ ADD THIS
      merchant_delivery_fee: merchantDeliveryFee, // ✅ ADD THIS
      grand_total: grandTotal,
    };

    console.log(
      `[DELIVERED] Discount: ${discountAmount}, Merchant Delivery Fee: ${merchantDeliveryFee}`,
    );

    // ✅ STEP 10: Send email immediately
    console.log(`[DELIVERED] Sending delivery receipt to ${user.email}...`);
    const EmailService = require("../services/emailService");
    const emailResult = await EmailService.sendOrderReceipt(orderData);

    if (emailResult.success) {
      // Save to receipt_email
      await db.query(
        `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, user_name, business_name, receipt_sent, receipt_sent_at, email_status, delivery_method)
         VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), 'sent', 'DELIVERY')
         ON DUPLICATE KEY UPDATE 
         receipt_sent = 1, receipt_sent_at = NOW(), email_status = 'sent', delivery_method = 'DELIVERY'`,
        [
          order_id,
          order.user_id,
          order.business_id,
          user.email,
          user.user_name,
          business.business_name,
        ],
      );
      console.log(
        `[DELIVERED] ✅ Email sent successfully for order ${order_id}`,
      );
    } else {
      console.error(
        `[DELIVERED] ❌ Email failed for order ${order_id}:`,
        emailResult.error,
      );
      await db.query(
        `INSERT INTO receipt_email (order_id, user_id, business_id, user_email, email_status, error_message, delivery_method)
         VALUES (?, ?, ?, ?, 'failed', ?, 'DELIVERY')
         ON DUPLICATE KEY UPDATE email_status = 'failed', error_message = ?`,
        [
          order_id,
          order.user_id,
          order.business_id,
          user.email,
          emailResult.error,
          emailResult.error,
        ],
      );
    }

    // ✅ STEP 11: Send push notification
    try {
      await sendPushToUserId(order.user_id, {
        title: "✅ Order Delivered Successfully",
        body: `Your order ${order_id} has been delivered successfully. Thank you for shopping with us!`,
      });
    } catch (pushErr) {
      console.error("[DELIVERED] Push notification failed:", pushErr);
    }

    // ✅ STEP 12: Return success (order stays in orders table for 30 minutes)
    return res.json({
      success: true,
      message: "Order marked as delivered. Receipt sent to customer.",
      order_id,
      status: "DELIVERED",
    });
  } catch (e) {
    console.error("[markOrderDelivered]", e);
    return res.status(500).json({
      success: false,
      message: "Technical error while marking delivered.",
      error: e?.message,
    });
  }
}

// Add this function after markOrderDelivered function (around line 900+)

async function markOrderPickedUp(req, res) {
  const order_id = String(req.params.order_id || req.body?.order_id || "")
    .trim()
    .toUpperCase();
  const pickedup_by = String(req.body?.pickedup_by || "SYSTEM").trim();
  const reason = String(req.body?.reason || "").trim();

  if (!order_id) {
    return res
      .status(400)
      .json({ success: false, message: "order_id is required" });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Get order details
    const [[order]] = await conn.query(
      `SELECT * FROM orders WHERE order_id = ? FOR UPDATE`,
      [order_id],
    );

    if (!order) {
      await conn.rollback();
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    // Check if already migrated
    const [[existing]] = await conn.query(
      `SELECT order_id FROM pickedup_orders WHERE order_id = ? LIMIT 1`,
      [order_id],
    );

    if (existing) {
      await conn.commit();
      return res.json({
        success: true,
        message: "Order already migrated to pickedup_orders",
        order_id,
        status: "PICKEDUP",
      });
    }

    // ✅ FIXED: Removed fm.name (only use item_name)
    const [items] = await conn.query(
      `SELECT oi.*, COALESCE(fm.item_name, 'Item') as menu_name
       FROM order_items oi
       LEFT JOIN food_menu fm ON oi.menu_id = fm.id
       WHERE oi.order_id = ?`,
      [order_id],
    );

    if (!items.length) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "No items found for this order",
      });
    }

    // Get business name
    const [[business]] = await conn.query(
      `SELECT business_name FROM merchant_business_details WHERE business_id = ?`,
      [order.business_id],
    );

    const businessName = business?.business_name || "Unknown Business";

    // Parse pickup address
    let pickupAddress = order.delivery_address || "N/A";
    if (pickupAddress !== "N/A" && typeof pickupAddress === "string") {
      try {
        const parsed = JSON.parse(pickupAddress);
        pickupAddress = parsed.address || pickupAddress;
      } catch (e) {}
    }

    // Insert into pickedup_orders
    await conn.query(
      `INSERT INTO pickedup_orders (
        order_id, user_id, business_id, business_name, status,
        total_amount, discount_amount, payment_method, pickup_address,
        pickedup_by, pickedup_at, original_created_at, original_updated_at
      ) VALUES (?, ?, ?, ?, 'PICKEDUP', ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        order_id,
        order.user_id,
        order.business_id,
        businessName,
        order.total_amount,
        order.discount_amount || 0,
        order.payment_method,
        pickupAddress,
        pickedup_by,
        order.created_at,
        order.updated_at,
      ],
    );

    // Insert items into pickedup_order_items
    for (const item of items) {
      const subtotal =
        (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0);

      await conn.query(
        `INSERT INTO pickedup_order_items (
          order_id, business_id, business_name, menu_id, item_name,
          item_image, quantity, price, subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order_id,
          item.business_id || order.business_id,
          businessName,
          item.menu_id,
          item.menu_name || `Item ${item.menu_id}`,
          item.item_image || null,
          item.quantity,
          item.price,
          subtotal,
        ],
      );
    }

    // Delete from orders
    await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
    await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);

    await conn.commit();

    console.log(
      `[PICKEDUP] Order ${order_id} migrated to pickedup_orders by ${pickedup_by}`,
    );

    // Send push notification (optional)
    try {
      const [[user]] = await conn.query(
        `SELECT user_name FROM users WHERE user_id = ?`,
        [order.user_id],
      );

      await sendPushToUserId(order.user_id, {
        title: "✅ Order Picked Up Successfully",
        body: `You have successfully picked up your order ${order_id}. Thank you for shopping with us!`,
      });
    } catch (notifyErr) {
      console.error("[PICKEDUP notify error]", notifyErr);
    }

    return res.json({
      success: true,
      message: "Order marked as picked up and migrated successfully.",
      data: { order_id, status: "PICKEDUP" },
    });
  } catch (e) {
    await conn.rollback();
    console.error("[markOrderPickedUp]", e);
    return res.status(500).json({
      success: false,
      message: "Technical error while marking picked up.",
      error: e?.message,
    });
  } finally {
    conn.release();
  }
}
module.exports = {
  uploadOrderImages,
  createOrder,
  getOrders,
  getOrderById,
  getOrdersByBusinessId,
  getBusinessOrdersGroupedByUser,
  getOrdersForUser,
  updateOrder,
  updateOrderStatus,
  deleteOrder,
  getOrderStatusCountsByBusiness,
  cancelOrderByUser,
  markOrderDelivered,
  markOrderPickedUp,
};
