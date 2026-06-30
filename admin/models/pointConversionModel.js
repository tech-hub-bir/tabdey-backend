const { prisma } = require("../lib/prisma.js");
const axios = require("axios");

// Admin wallet that funds the conversion
const ADMIN_WALLET_ID = process.env.ADMIN_WALLET_ID;

// Endpoint that generates transaction_ids + journal_code
const WALLET_IDS_BOTH_ENDPOINT = process.env.WALLET_IDS_BOTH_ENDPOINT;

/**
 * Get active conversion rule from point_conversion_rule (id = 1, is_active = 1)
 */
async function getActiveConversionRule() {
  const rule = await prisma.point_conversion_rule.findFirst({
    where: {
      id: 1,
      is_active: true,
    },
  });

  if (!rule) return null;

  return {
    id: Number(rule.id),
    points_required: Number(rule.points_required),
    wallet_amount: Number(rule.wallet_amount),
    is_active: rule.is_active,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  };
}

/**
 * Convert user's points into wallet amount based on active rule.
 * Points source: users.points, amount column in wallets.
 *
 * Formula:
 *  - Require: pointsToConvert >= points_required
 *  - Require: pointsToConvert <= users.points
 *  - walletAmount = (pointsToConvert * wallet_amount_rule) / points_required
 *
 * Inserts:
 *  - 2 wallet_transactions rows (DR for admin, CR for user)
 *  - 1 notifications row for user
 *
 * Returns:
 *  {
 *    points_converted,
 *    wallet_amount,
 *    transaction_id,   // ✅ user-side tx id
 *    journal_code,
 *    calculation: {...}
 *  }
 */
async function convertPointsToWallet(userId, pointsToConvert) {
  // 1. Load active conversion rule
  const rule = await getActiveConversionRule();
  if (!rule) {
    const err = new Error(
      "Point conversion rule is not configured or is inactive.",
    );
    err.code = "RULE_NOT_FOUND";
    throw err;
  }

  if (!rule.is_active) {
    const err = new Error("Point conversion rule is inactive.");
    err.code = "RULE_INACTIVE";
    throw err;
  }

  const pointsRequired = Number(rule.points_required);
  const walletPerBlock = Number(rule.wallet_amount);

  if (
    !Number.isInteger(pointsRequired) ||
    pointsRequired <= 0 ||
    !Number.isFinite(walletPerBlock) ||
    walletPerBlock <= 0
  ) {
    const err = new Error("Invalid point conversion rule configuration.");
    err.code = "RULE_INVALID_CONFIG";
    throw err;
  }

  // Start transaction
  const result = await prisma.$transaction(async (tx) => {
    /* -----------------------
       2. Lock user row (users.points)
    ------------------------*/
    const userRows = await tx.users.findFirst({
      where: { user_id: userId },
      select: { user_id: true, points: true },
    });

    if (!userRows) {
      const err = new Error("User not found.");
      err.code = "USER_NOT_FOUND";
      throw err;
    }

    const currentPoints = Number(userRows.points || 0);

    // >= rule minimum
    if (pointsToConvert < pointsRequired) {
      const err = new Error(
        `Minimum points required for conversion is ${pointsRequired}. You requested ${pointsToConvert} points.`,
      );
      err.code = "NOT_ENOUGH_POINTS_FOR_CONVERSION";
      throw err;
    }

    // must not exceed user's available points
    if (pointsToConvert > currentPoints) {
      const err = new Error(
        `Insufficient points. You have ${currentPoints} points and tried to convert ${pointsToConvert}.`,
      );
      err.code = "INSUFFICIENT_USER_POINTS";
      throw err;
    }

    // 3. Compute wallet amount using formula
    const amountPerPoint = walletPerBlock / pointsRequired;
    const walletAmountRaw = pointsToConvert * amountPerPoint;
    const walletAmount = Number(walletAmountRaw.toFixed(2));

    if (walletAmount <= 0) {
      const err = new Error("Calculated wallet amount is not valid.");
      err.code = "RULE_INVALID_CONFIG";
      throw err;
    }

    const newPointsBalance = currentPoints - pointsToConvert;

    /* -----------------------
       4. Lock admin wallet (amount)
    ------------------------*/
    const adminWalletRows = await tx.wallets.findFirst({
      where: { wallet_id: ADMIN_WALLET_ID },
      select: { wallet_id: true, amount: true },
    });

    if (!adminWalletRows) {
      const err = new Error("Admin wallet not found.");
      err.code = "ADMIN_WALLET_NOT_FOUND";
      throw err;
    }

    const adminAmount = Number(adminWalletRows.amount || 0);
    if (adminAmount < walletAmount) {
      const err = new Error(
        "Admin wallet has insufficient balance to process conversion.",
      );
      err.code = "ADMIN_WALLET_INSUFFICIENT";
      throw err;
    }

    /* -----------------------
       5. Lock user wallet (amount)
    ------------------------*/
    const userWalletRows = await tx.wallets.findFirst({
      where: { user_id: userId },
      select: { wallet_id: true, amount: true },
    });

    if (!userWalletRows) {
      const err = new Error("User wallet not found.");
      err.code = "USER_WALLET_NOT_FOUND";
      throw err;
    }

    const userWalletId = userWalletRows.wallet_id;
    const userWalletAmount = Number(userWalletRows.amount || 0);

    /* -----------------------
       6. Update user points (users.points)
    ------------------------*/
    await tx.users.update({
      where: { user_id: userId },
      data: { points: newPointsBalance },
    });

    /* -----------------------
       7. Update wallet amounts (wallets.amount)
    ------------------------*/
    const newAdminAmount = adminAmount - walletAmount;
    const newUserAmount = userWalletAmount + walletAmount;

    await tx.wallets.update({
      where: { wallet_id: ADMIN_WALLET_ID },
      data: { amount: newAdminAmount },
    });

    await tx.wallets.update({
      where: { wallet_id: userWalletId },
      data: { amount: newUserAmount },
    });

    /* -----------------------
       8. Fetch transaction_ids + journal_code
          from https://grab.newedge.bt/wallet/ids/both
    ------------------------*/
    let transactionIds = [];
    let journalCode = null;

    try {
      const resp = await axios.post(WALLET_IDS_BOTH_ENDPOINT, {});
      const payload = resp.data || {};

      if (
        !payload.ok ||
        !payload.data ||
        !Array.isArray(payload.data.transaction_ids) ||
        !payload.data.journal_code
      ) {
        const err = new Error(
          "Failed to fetch transaction ids and journal code.",
        );
        err.code = "TXN_ID_FETCH_FAILED";
        throw err;
      }

      transactionIds = payload.data.transaction_ids;
      journalCode = payload.data.journal_code;
    } catch (e) {
      console.error("Error calling wallet ids endpoint:", e);
      const err = new Error(
        "Unable to generate transaction/journal codes for wallet transaction.",
      );
      err.code = "TXN_ID_FETCH_FAILED";
      throw err;
    }

    const adminTxnId = transactionIds[0];
    const userTxnId = transactionIds[1] || transactionIds[0];

    /* -----------------------
       9. Insert wallet_transactions
       - one DR row for admin wallet
       - one CR row for user wallet
    ------------------------*/

    // Admin DEBIT (DR)
    await tx.wallet_transactions.create({
      data: {
        transaction_id: adminTxnId,
        journal_code: journalCode,
        tnx_from: ADMIN_WALLET_ID,
        tnx_to: userWalletId,
        amount: walletAmount,
        remark: "DR",
        note: `Points conversion to ${userWalletId}`,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // User CREDIT (CR)
    await tx.wallet_transactions.create({
      data: {
        transaction_id: userTxnId,
        journal_code: journalCode,
        tnx_from: ADMIN_WALLET_ID,
        tnx_to: userWalletId,
        amount: walletAmount,
        remark: "CR",
        note: `Points conversion from ${ADMIN_WALLET_ID}`,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    /* -----------------------
       10. Insert notification for user
    ------------------------*/
    const notifyTitle = "Transaction successful";
    const notifyMessage = `Your account has been credited with Nu. ${walletAmount.toFixed(
      2,
    )} from acc ${ADMIN_WALLET_ID} to ${userWalletId}.`;

    const notifyData = {
      to: userWalletId,
      from: ADMIN_WALLET_ID,
      amount: walletAmount,
      source: "points_conversion",
      journal_code: journalCode,
      transaction_id: userTxnId,
      admin_transaction_id: adminTxnId,
      points_converted: pointsToConvert,
    };

    await tx.notifications.create({
      data: {
        user_id: userId,
        type: "wallet_credit",
        title: notifyTitle,
        message: notifyMessage,
        data: JSON.stringify(notifyData),
        status: "unread",
        created_at: new Date(),
      },
    });

    return {
      points_converted: pointsToConvert,
      wallet_amount: walletAmount,
      transaction_id: userTxnId,
      journal_code: journalCode,
      calculation: {
        points_required: pointsRequired,
        wallet_per_block: walletPerBlock,
        points_requested: pointsToConvert,
        total_points_before: currentPoints,
        total_points_after: newPointsBalance,
        amount_per_point: amountPerPoint,
        formula: `amount = (points * ${walletPerBlock}) / ${pointsRequired}`,
        leftover_points: newPointsBalance,
      },
    };
  });

  return result;
}

module.exports = {
  convertPointsToWallet,
};
