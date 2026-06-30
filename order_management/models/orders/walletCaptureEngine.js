// models/orders/walletCaptureEngine.js
const db = require("../../config/db");

const {
  getBuyerWalletByUserId,
  getAdminWallet,
  getMerchantWalletByBusinessId,
} = require("./walletLookups");

const {
  fetchTxnAndJournalIds,
  prefetchTxnIdsBatch,
} = require("./walletIdService");

const PLATFORM_USER_SHARE = 0.5;
const PLATFORM_MERCHANT_SHARE = 0.5;
/* ============================================================
   Basic helpers
============================================================ */

function round2(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function splitPlatformFee(platformFeeTotal) {
  const fee = round2(platformFeeTotal);

  if (!(fee > 0)) {
    return {
      userFee: 0,
      merchFee: 0,
    };
  }

  const userFee = round2(fee * PLATFORM_USER_SHARE);
  const merchFee = round2(fee - userFee);

  return {
    userFee,
    merchFee,
  };
}

/**
 * IMPORTANT:
 * Keep this SHORT because order_wallet_captures.buyer_txn_id,
 * merch_txn_id and admin_txn_id may be small VARCHAR columns.
 *
 * Do NOT store "txn1/txn2|txn3/txn4" here.
 * Full details are already stored in wallet_transactions.
 */
function captureTxnId(txn, preferred = "dr") {
  if (!txn) return null;

  const value =
    preferred === "cr"
      ? txn.cr_txn_id || txn.dr_txn_id || txn.journal_id
      : txn.dr_txn_id || txn.cr_txn_id || txn.journal_id;

  if (!value) return null;

  return String(value).slice(0, 64);
}

/**
 * Model:
 * orders.total_amount = gross payable
 *
 * Example:
 * total_amount = 619
 * platform_fee = 29
 *
 * Wallet movement:
 * Buyer    -> Merchant = 619 - 29 = 590
 * Buyer    -> Admin    = 29 / 2 = 14.5
 * Merchant -> Admin    = 29 / 2 = 14.5
 *
 * Buyer total debit = 590 + 14.5 = 604.5
 */
function computeWalletAmounts(order) {
  const finalTotalAmount = round2(order.total_amount);
  const platformFeeTotal = round2(order.platform_fee);
  const merchantDeliveryFee = round2(order.merchant_delivery_fee);

  if (!(finalTotalAmount > 0)) {
    throw new Error("Invalid total_amount for wallet capture");
  }

  if (platformFeeTotal < 0 || merchantDeliveryFee < 0) {
    throw new Error("Invalid negative fee amount for wallet capture");
  }

  const { userFee, merchFee } = splitPlatformFee(platformFeeTotal);

  // Main correction:
  // Merchant receives gross total minus full platform fee.
  const buyerToMerchant = round2(finalTotalAmount - platformFeeTotal);

  if (buyerToMerchant < 0) {
    throw new Error("Invalid wallet split: platform_fee exceeds total_amount");
  }

  // Buyer pays order/delivery amount + user-side platform fee only.
  const needFromBuyer = round2(buyerToMerchant + userFee);

  return {
    finalTotalAmount,
    platformFeeTotal,
    merchantDeliveryFee,
    buyerToMerchant,
    userFee,
    merchFee,
    needFromBuyer,
  };
}

/* ============================================================
   Capture helpers
============================================================ */

async function captureExists(order_id, capture_type, conn = null) {
  const dbh = conn || db;

  const [[row]] = await dbh.query(
    `SELECT order_id
       FROM order_wallet_captures
      WHERE order_id = ?
        AND capture_type = ?
      LIMIT 1`,
    [order_id, capture_type],
  );

  return !!row;
}

async function computeBusinessSplit(order_id, conn = null) {
  const dbh = conn || db;

  const [items] = await dbh.query(
    `SELECT business_id, subtotal
       FROM order_items
      WHERE order_id = ?
      ORDER BY menu_id ASC`,
    [order_id],
  );

  if (!items.length) {
    throw new Error("Order has no items");
  }

  const primaryBizId = Number(items[0].business_id);

  if (!Number.isFinite(primaryBizId) || primaryBizId <= 0) {
    throw new Error("Unable to identify merchant business for wallet capture");
  }

  const itemsTotal = items.reduce(
    (sum, item) => round2(sum + Number(item.subtotal || 0)),
    0,
  );

  return {
    business_id: primaryBizId,
    items_total: itemsTotal,
  };
}

async function recordWalletTransfer(
  conn,
  { fromId, toId, amount, note = null },
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
    [amt, fromId, amt],
  );

  if (!dr.affectedRows) {
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);
  }

  await conn.query(
    `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, toId],
  );

  const { dr_id, cr_id, journal_id } = await fetchTxnAndJournalIds();

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [dr_id, journal_id || null, fromId, toId, amt, note],
  );

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [cr_id, journal_id || null, fromId, toId, amt, note],
  );

  return {
    dr_txn_id: dr_id,
    cr_txn_id: cr_id,
    journal_id: journal_id || null,
  };
}
async function recordWalletTransferWithIds(
  conn,
  { fromId, toId, amount, note = null, ids },
) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return null;

  const [dr] = await conn.query(
    `UPDATE wallets SET amount = amount - ? WHERE wallet_id = ? AND amount >= ?`,
    [amt, fromId, amt],
  );

  if (!dr.affectedRows) {
    throw new Error(`Insufficient funds or missing wallet: ${fromId}`);
  }

  await conn.query(
    `UPDATE wallets SET amount = amount + ? WHERE wallet_id = ?`,
    [amt, toId],
  );

  const { dr_id, cr_id, journal_id } = ids || {};

  if (!dr_id || !cr_id) {
    throw new Error("Prefetched transaction ids missing (dr_id/cr_id).");
  }

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'DR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [dr_id, journal_id || null, fromId, toId, amt, note],
  );

  await conn.query(
    `INSERT INTO wallet_transactions
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'CR', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [cr_id, journal_id || null, fromId, toId, amt, note],
  );

  return {
    dr_txn_id: dr_id,
    cr_txn_id: cr_id,
    journal_id: journal_id || null,
  };
}
async function lockAndGetOrder(conn, order_id) {
  const [[order]] = await conn.query(
    `SELECT user_id, total_amount, platform_fee, merchant_delivery_fee, payment_method
       FROM orders
      WHERE order_id = ?
      FOR UPDATE`,
    [order_id],
  );

  return order || null;
}

/* ============================================================
   WALLET capture - standalone
   Used by captureOnAccept(order_id)
============================================================ */

async function captureOrderFunds(order_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const order = await lockAndGetOrder(conn, order_id);

    if (!order) {
      throw new Error("Order not found for capture");
    }

    if (await captureExists(order_id, "WALLET_FULL", conn)) {
      await conn.commit();

      return {
        captured: false,
        alreadyCaptured: true,
        payment_method: "WALLET",
        order_id,
      };
    }

    const pm = String(order.payment_method || "WALLET").toUpperCase();

    if (pm !== "WALLET") {
      await conn.commit();

      return {
        captured: false,
        skipped: true,
        payment_method: pm,
        reason: "payment_method != WALLET",
      };
    }

    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merchant = await getMerchantWalletByBusinessId(
      split.business_id,
      conn,
    );
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merchant) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const {
      finalTotalAmount,
      platformFeeTotal,
      merchantDeliveryFee,
      buyerToMerchant,
      userFee,
      merchFee,
      needFromBuyer,
    } = computeWalletAmounts(order);

    console.log("[WALLET CAPTURE AMOUNTS]", {
      order_id,
      total_amount_from_db: finalTotalAmount,
      platform_fee_from_db: platformFeeTotal,
      buyer_to_merchant: buyerToMerchant,
      buyer_platform_fee: userFee,
      merchant_platform_fee: merchFee,
      buyer_total_debit: needFromBuyer,
      merchant_delivery_fee: merchantDeliveryFee,
    });

    const [[freshBuyer]] = await conn.query(
      `SELECT amount
         FROM wallets
        WHERE id = ?
        FOR UPDATE`,
      [buyer.id],
    );

    if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
      throw new Error("Insufficient wallet balance during capture");
    }

    // 1. Buyer pays merchant: gross total minus full platform fee
    const tOrder = await recordWalletTransfer(conn, {
      fromId: buyer.wallet_id,
      toId: merchant.wallet_id,
      amount: buyerToMerchant,
      note: `Order + delivery amount credited to merchant for ${order_id}`,
    });

    // 2. Buyer pays 50% platform fee to admin
    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `Platform fee user share 50% for ${order_id}`,
      });
    }

    // 3. Merchant pays 50% platform fee to admin
    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merchant.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        note: `Platform fee merchant share 50% for ${order_id}`,
      });
    }

    // 4. Optional admin/platform support for merchant delivery fee
    let tMerchantDelivery = null;
    if (merchantDeliveryFee > 0) {
      tMerchantDelivery = await recordWalletTransfer(conn, {
        fromId: admin.wallet_id,
        toId: merchant.wallet_id,
        amount: merchantDeliveryFee,
        note: `Merchant delivery fee support for ${order_id}`,
      });
    }

    // Keep these short to avoid "Data too long" errors.
    await conn.query(
      `INSERT INTO order_wallet_captures
         (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
      [
        order_id,
        captureTxnId(tUserFee, "dr") || captureTxnId(tOrder, "dr"),
        captureTxnId(tMerchFee, "dr") || captureTxnId(tOrder, "cr"),
        captureTxnId(tUserFee, "cr") || captureTxnId(tMerchFee, "cr"),
      ],
    );

    await conn.commit();

    return {
      captured: true,
      payment_method: "WALLET",
      order_id,
      user_id: Number(order.user_id),
      business_id: Number(split.business_id),

      total_amount: finalTotalAmount,
      order_amount: buyerToMerchant,
      platform_fee_total: platformFeeTotal,
      platform_fee_user: userFee,
      platform_fee_merchant: merchFee,
      merchant_delivery_fee: merchantDeliveryFee,
      buyer_total_debit: needFromBuyer,

      txns: {
        buyer_to_merchant_order: tOrder,
        buyer_to_admin_platform_fee: tUserFee,
        merchant_to_admin_platform_fee: tMerchFee,
        admin_to_merchant_delivery: tMerchantDelivery,
      },
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    throw e;
  } finally {
    conn.release();
  }
}

/* ============================================================
   COD capture - standalone
============================================================ */

async function captureOrderCODFee(order_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const order = await lockAndGetOrder(conn, order_id);

    if (!order) {
      throw new Error("Order not found for COD fee capture");
    }

    if (await captureExists(order_id, "COD_FEE", conn)) {
      await conn.commit();

      return {
        captured: false,
        alreadyCaptured: true,
        payment_method: "COD",
        order_id,
      };
    }

    const pm = String(order.payment_method || "").toUpperCase();

    if (pm !== "COD") {
      await conn.commit();

      return {
        captured: false,
        skipped: true,
        payment_method: pm,
        reason: "payment_method != COD",
      };
    }

    const split = await computeBusinessSplit(order_id, conn);

    const buyer = await getBuyerWalletByUserId(order.user_id, conn);
    const merchant = await getMerchantWalletByBusinessId(
      split.business_id,
      conn,
    );
    const admin = await getAdminWallet(conn);

    if (!buyer) throw new Error("Buyer wallet missing");
    if (!merchant) throw new Error("Merchant wallet missing");
    if (!admin) throw new Error("Admin wallet missing");

    const { userFee, merchFee } = splitPlatformFee(order.platform_fee);

    let tUserFee = null;
    if (userFee > 0) {
      tUserFee = await recordWalletTransfer(conn, {
        fromId: buyer.wallet_id,
        toId: admin.wallet_id,
        amount: userFee,
        note: `COD platform fee user share 50% for ${order_id}`,
      });
    }

    let tMerchFee = null;
    if (merchFee > 0) {
      tMerchFee = await recordWalletTransfer(conn, {
        fromId: merchant.wallet_id,
        toId: admin.wallet_id,
        amount: merchFee,
        note: `COD platform fee merchant share 50% for ${order_id}`,
      });
    }

    await conn.query(
      `INSERT INTO order_wallet_captures
         (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
       VALUES (?, 'COD_FEE', ?, ?, ?)`,
      [
        order_id,
        captureTxnId(tUserFee, "dr"),
        captureTxnId(tMerchFee, "dr"),
        captureTxnId(tUserFee, "cr") || captureTxnId(tMerchFee, "cr"),
      ],
    );

    await conn.commit();

    return {
      captured: true,
      payment_method: "COD",
      order_id,
      user_id: Number(order.user_id),
      business_id: Number(split.business_id),
      platform_fee_user: userFee,
      platform_fee_merchant: merchFee,
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}

    throw e;
  } finally {
    conn.release();
  }
}

/* ============================================================
   WALLET capture inside existing transaction
============================================================ */

async function captureOrderFundsWithConn(conn, order_id, prefetchedIds = []) {
  const order = await lockAndGetOrder(conn, order_id);

  if (!order) {
    throw new Error("Order not found for wallet capture");
  }

  if (await captureExists(order_id, "WALLET_FULL", conn)) {
    return {
      captured: false,
      alreadyCaptured: true,
      payment_method: "WALLET",
      order_id,
    };
  }

  const pm = String(order.payment_method || "").toUpperCase();

  if (pm !== "WALLET") {
    return {
      captured: false,
      skipped: true,
      payment_method: pm || "WALLET",
    };
  }

  const split = await computeBusinessSplit(order_id, conn);

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merchant = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merchant) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  const {
    finalTotalAmount,
    platformFeeTotal,
    merchantDeliveryFee,
    buyerToMerchant,
    userFee,
    merchFee,
    needFromBuyer,
  } = computeWalletAmounts(order);

  console.log("[WALLET CAPTURE WITH CONN AMOUNTS]", {
    order_id,
    total_amount_from_db: finalTotalAmount,
    platform_fee_from_db: platformFeeTotal,
    buyer_to_merchant: buyerToMerchant,
    buyer_platform_fee: userFee,
    merchant_platform_fee: merchFee,
    buyer_total_debit: needFromBuyer,
    merchant_delivery_fee: merchantDeliveryFee,
  });

  const [[freshBuyer]] = await conn.query(
    `SELECT amount
       FROM wallets
      WHERE id = ?
      FOR UPDATE`,
    [buyer.id],
  );

  if (!freshBuyer || Number(freshBuyer.amount) < needFromBuyer) {
    throw new Error("Insufficient wallet balance during capture");
  }

  const nextIds = async (index) => {
    if (prefetchedIds?.[index]) return prefetchedIds[index];
    return fetchTxnAndJournalIds();
  };

  const tOrder = await recordWalletTransferWithIds(conn, {
    fromId: buyer.wallet_id,
    toId: merchant.wallet_id,
    amount: buyerToMerchant,
    note: `Order + delivery amount credited to merchant for ${order_id}`,
    ids: await nextIds(0),
  });

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `Platform fee user share 50% for ${order_id}`,
      ids: await nextIds(1),
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merchant.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `Platform fee merchant share 50% for ${order_id}`,
      ids: await nextIds(2),
    });
  }

  let tMerchantDelivery = null;
  if (merchantDeliveryFee > 0) {
    tMerchantDelivery = await recordWalletTransferWithIds(conn, {
      fromId: admin.wallet_id,
      toId: merchant.wallet_id,
      amount: merchantDeliveryFee,
      note: `Merchant delivery fee support for ${order_id}`,
      ids: await nextIds(3),
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures
       (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'WALLET_FULL', ?, ?, ?)`,
    [
      order_id,
      captureTxnId(tUserFee, "dr") || captureTxnId(tOrder, "dr"),
      captureTxnId(tMerchFee, "dr") || captureTxnId(tOrder, "cr"),
      captureTxnId(tUserFee, "cr") || captureTxnId(tMerchFee, "cr"),
    ],
  );

  return {
    captured: true,
    payment_method: "WALLET",
    order_id,
    user_id: Number(order.user_id),
    business_id: Number(split.business_id),

    total_amount: finalTotalAmount,
    order_amount: buyerToMerchant,
    platform_fee_total: platformFeeTotal,
    platform_fee_user: userFee,
    platform_fee_merchant: merchFee,
    merchant_delivery_fee: merchantDeliveryFee,
    buyer_total_debit: needFromBuyer,

    txns: {
      buyer_to_merchant_order: tOrder,
      buyer_to_admin_platform_fee: tUserFee,
      merchant_to_admin_platform_fee: tMerchFee,
      admin_to_merchant_delivery: tMerchantDelivery,
    },
  };
}

/* ============================================================
   COD capture inside existing transaction
============================================================ */

async function captureOrderCODFeeWithConn(conn, order_id, prefetchedIds = []) {
  const order = await lockAndGetOrder(conn, order_id);

  if (!order) {
    throw new Error("Order not found for COD fee capture");
  }

  if (await captureExists(order_id, "COD_FEE", conn)) {
    return {
      captured: false,
      alreadyCaptured: true,
      payment_method: "COD",
      order_id,
    };
  }

  const pm = String(order.payment_method || "").toUpperCase();

  if (pm !== "COD") {
    return {
      captured: false,
      skipped: true,
      payment_method: pm || "COD",
    };
  }

  const split = await computeBusinessSplit(order_id, conn);

  const buyer = await getBuyerWalletByUserId(order.user_id, conn);
  const merchant = await getMerchantWalletByBusinessId(split.business_id, conn);
  const admin = await getAdminWallet(conn);

  if (!buyer) throw new Error("Buyer wallet missing");
  if (!merchant) throw new Error("Merchant wallet missing");
  if (!admin) throw new Error("Admin wallet missing");

  const { userFee, merchFee } = splitPlatformFee(order.platform_fee);

  const nextIds = async (index) => {
    if (prefetchedIds?.[index]) return prefetchedIds[index];
    return fetchTxnAndJournalIds();
  };

  let tUserFee = null;
  if (userFee > 0) {
    tUserFee = await recordWalletTransferWithIds(conn, {
      fromId: buyer.wallet_id,
      toId: admin.wallet_id,
      amount: userFee,
      note: `COD platform fee user share 50% for ${order_id}`,
      ids: await nextIds(0),
    });
  }

  let tMerchFee = null;
  if (merchFee > 0) {
    tMerchFee = await recordWalletTransferWithIds(conn, {
      fromId: merchant.wallet_id,
      toId: admin.wallet_id,
      amount: merchFee,
      note: `COD platform fee merchant share 50% for ${order_id}`,
      ids: await nextIds(1),
    });
  }

  await conn.query(
    `INSERT INTO order_wallet_captures
       (order_id, capture_type, buyer_txn_id, merch_txn_id, admin_txn_id)
     VALUES (?, 'COD_FEE', ?, ?, ?)`,
    [
      order_id,
      captureTxnId(tUserFee, "dr"),
      captureTxnId(tMerchFee, "dr"),
      captureTxnId(tUserFee, "cr") || captureTxnId(tMerchFee, "cr"),
    ],
  );

  return {
    captured: true,
    payment_method: "COD",
    order_id,
    user_id: Number(order.user_id),
    business_id: Number(split.business_id),
    platform_fee_user: userFee,
    platform_fee_merchant: merchFee,
  };
}

/* ============================================================
   Helper used by controller
============================================================ */

async function captureOnAccept(order_id, conn = null, prefetchedIds = []) {
  const dbh = conn || db;

  const [[order]] = await dbh.query(
    `SELECT user_id, payment_method
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );

  if (!order) {
    return {
      ok: false,
      code: "NOT_FOUND",
    };
  }

  const pm = String(order.payment_method || "WALLET").toUpperCase();

  if (pm === "WALLET") {
    return {
      ok: true,
      payment_method: "WALLET",
      capture: conn
        ? await captureOrderFundsWithConn(conn, order_id, prefetchedIds)
        : await captureOrderFunds(order_id),
    };
  }

  if (pm === "COD") {
    return {
      ok: true,
      payment_method: "COD",
      capture: conn
        ? await captureOrderCODFeeWithConn(conn, order_id, prefetchedIds)
        : await captureOrderCODFee(order_id),
    };
  }

  return {
    ok: true,
    payment_method: pm,
    skipped: true,
  };
}

module.exports = {
  PLATFORM_USER_SHARE,
  PLATFORM_MERCHANT_SHARE,

  prefetchTxnIdsBatch,
  computeBusinessSplit,

  captureOrderFunds,
  captureOrderCODFee,

  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,

  captureOnAccept,
};