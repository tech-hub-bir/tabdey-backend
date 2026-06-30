// orders/orderNotifications.js
const db = require("../../config/db");

const fmtNu = (n) => Number(n || 0).toFixed(2);

async function insertUserNotification(
  conn,
  { user_id, title, message, type = "wallet", data = null, status = "unread" },
) {
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, data, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      user_id,
      type,
      title,
      message,
      data ? JSON.stringify(data) : null,
      status === "read" ? "read" : "unread",
    ],
  );
}

function humanOrderStatus(status) {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "PENDING":
      return "pending";
    case "CONFIRMED":
      return "accepted by the store";
    case "PREPARING":
      return "being prepared";
    case "READY":
      return "ready for pickup";
    case "OUT_FOR_DELIVERY":
      return "out for delivery";
    case "DELIVERED":
    case "COMPLETED":
      return "delivered";
    case "CANCELLED":
      return "cancelled";
    case "DECLINED":
      return "declined by the store";
    default:
      return s.toLowerCase();
  }
}

async function addUserOrderStatusNotificationInternal(
  user_id,
  order_id,
  status,
  reason = "",
  conn = null,
) {
  const dbh = conn || db;
  let normalized = String(status || "").toUpperCase();
  if (normalized === "COMPLETED") normalized = "DELIVERED";

  const trimmedReason = String(reason || "").trim();

  let message;
  if (normalized === "CONFIRMED") {
    message = `Your order ${order_id} is accepted successfully.`;
  } else {
    const nice = humanOrderStatus(normalized);
    message = `Your order ${order_id} is now ${nice}.`;
  }

  if (trimmedReason) message += ` Reason: ${trimmedReason}`;

  await insertUserNotification(dbh, {
    user_id,
    type: "order_status",
    title: "Order update",
    message,
    data: { order_id, status: normalized, reason: trimmedReason || null },
    status: "unread",
  });
}

async function addUserUnavailableItemNotificationInternal(
  user_id,
  order_id,
  changes,
  final_total_amount = null,
  conn = null,
) {
  const dbh = conn || db;
  const removed = Array.isArray(changes?.removed) ? changes.removed : [];
  const replaced = Array.isArray(changes?.replaced) ? changes.replaced : [];

  const lines = [];

  if (removed.length) {
    const names = removed
      .map((x) => x.item_name || x.menu_id)
      .filter(Boolean)
      .join(", ");
    lines.push(
      names
        ? `Removed items: ${names}.`
        : `Some unavailable items were removed from your order.`,
    );
  }

  if (replaced.length) {
    const names = replaced
      .map((x) => x.new?.item_name || x.old?.item_name || x.old?.menu_id)
      .filter(Boolean)
      .join(", ");
    lines.push(
      names
        ? `Replaced items: ${names}.`
        : `Some unavailable items were replaced with alternatives.`,
    );
  }

  if (!lines.length) return;

  if (final_total_amount != null) {
    lines.push(
      `Your final payable amount for this order is Nu. ${fmtNu(final_total_amount)}.`,
    );
  }

  await insertUserNotification(dbh, {
    user_id,
    type: "order_unavailable_items",
    title: `Items updated in order ${order_id}`,
    message: lines.join(" "),
    data: {
      order_id,
      changes: { removed, replaced },
      final_total_amount:
        final_total_amount != null ? Number(final_total_amount) : null,
    },
    status: "unread",
  });
}

async function addUserWalletDebitNotificationInternal(
  user_id,
  order_id,
  order_amount,
  platform_fee,
  method,
  conn = null,
) {
  const dbh = conn || db;
  const payMethod = String(method || "").toUpperCase();
  const orderAmt = Number(order_amount || 0);
  const feeAmt = Number(platform_fee || 0);

  if (!(orderAmt > 0 || feeAmt > 0)) return;

  let message;
  if (payMethod === "WALLET") {
    message =
      `Your order ${order_id} is accepted successfully. ` +
      `Nu. ${fmtNu(orderAmt)} has been deducted from your wallet for the order and ` +
      `Nu. ${fmtNu(feeAmt)} as platform fee (your share).`;
  } else {
    message = `Order ${order_id}: Nu. ${fmtNu(feeAmt)} was deducted from your wallet as platform fee (your share).`;
  }

  await insertUserNotification(dbh, {
    user_id,
    type: "wallet_debit",
    title: "Wallet deduction",
    message,
    data: {
      order_id,
      order_amount: orderAmt,
      platform_fee: feeAmt,
      method: payMethod,
    },
    status: "unread",
  });
}

/* exported wrappers (controller-friendly) */
async function addUserOrderStatusNotification({
  user_id,
  order_id,
  status,
  reason = "",
  conn = null,
}) {
  return addUserOrderStatusNotificationInternal(
    user_id,
    order_id,
    status,
    reason,
    conn,
  );
}
async function addUserUnavailableItemNotification({
  user_id,
  order_id,
  changes,
  final_total_amount = null,
  conn = null,
}) {
  return addUserUnavailableItemNotificationInternal(
    user_id,
    order_id,
    changes,
    final_total_amount,
    conn,
  );
}
async function addUserWalletDebitNotification({
  user_id,
  order_id,
  order_amount,
  platform_fee,
  method,
  conn = null,
}) {
  return addUserWalletDebitNotificationInternal(
    user_id,
    order_id,
    order_amount,
    platform_fee,
    method,
    conn,
  );
}

module.exports = {
  insertUserNotification,
  addUserOrderStatusNotification,
  addUserUnavailableItemNotification,
  addUserWalletDebitNotification,
};
