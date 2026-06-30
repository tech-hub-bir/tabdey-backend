// models/adminTransferModel.js
const axios = require("axios");
const { prisma } = require("../lib/prisma");

const {
  createWalletTransactionLog,
} = require("./walletTransactionLogModel");

const ADMIN_ROLES = ["admin", "super admin"];
const ADMIN_ROLE_VARIANTS = [
  "admin",
  "Admin",
  "ADMIN",
  "super admin",
  "Super Admin",
  "SUPER ADMIN",
];

const ID_SERVICE_URL = process.env.ID_SERVICE_URL;
const WALLET_IDS_BOTH_URL = process.env.WALLET_IDS_BOTH_URL;

console.log("ID Service URL:", ID_SERVICE_URL);

/* ---------- ID SERVICE ---------- */

async function fetchTxIdsAndJournalCode() {
  const url =
    String(WALLET_IDS_BOTH_URL || "").trim() ||
    `${String(ID_SERVICE_URL || "").trim()}/ids/both`;

  if (!url || url === "/ids/both") {
    throw new Error("WALLET_IDS_BOTH_URL or ID_SERVICE_URL missing in env.");
  }

  try {
    const resp = await axios.post(url, {}, { timeout: 5000 });

    if (!resp.data || !resp.data.ok || !resp.data.data) {
      throw new Error("Invalid response from wallet/ids/both");
    }

    const { transaction_ids, journal_code } = resp.data.data;

    if (!Array.isArray(transaction_ids) || transaction_ids.length < 2) {
      throw new Error("wallet/ids/both did not return valid transaction_ids");
    }

    if (!journal_code) {
      throw new Error("wallet/ids/both did not return journal_code");
    }

    return {
      transaction_ids,
      journal_code,
    };
  } catch (err) {
    console.error("[ID SERVICE ERROR]", {
      url,
      message: err.message,
      code: err.code,
      status: err.response?.status,
      data: err.response?.data,
    });

    throw err;
  }
}

/* ---------- HELPERS ---------- */

function toDecimalNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);

  if (
    typeof v === "object" &&
    typeof v.toString === "function" &&
    v.constructor?.name === "Decimal"
  ) {
    return Number(v.toString());
  }

  return Number(v);
}

function moneyString(v) {
  const n = toDecimalNumber(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function normalizeAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

async function safeWalletLog(payload) {
  try {
    await createWalletTransactionLog(payload);
  } catch (err) {
    console.error("[wallet_transaction_logs] write failed:", {
      message: err.message,
      action: payload?.action,
      status: payload?.status,
      transaction_id: payload?.transaction_id,
    });
  }
}

async function findAdminByUserName(tx, admin_name) {
  const cleanName = String(admin_name || "").trim().toLowerCase();

  if (!cleanName) return null;

  const users = await tx.users.findMany({
    where: {
      role: {
        in: ADMIN_ROLE_VARIANTS,
      },
    },
    select: {
      user_id: true,
      user_name: true,
      role: true,
    },
  });

  return (
    users.find(
      (u) =>
        String(u.user_name || "").trim().toLowerCase() === cleanName &&
        ADMIN_ROLES.includes(String(u.role || "").trim().toLowerCase()),
    ) || null
  );
}

/**
 * Admin Tip Transfer:
 * - verifies admin by users.user_name + role
 * - validates both wallets
 * - debits admin wallet
 * - credits user wallet
 * - inserts 2 wallet_transactions
 * - logs admin action
 * - marks driver ride_ratings payment_status true
 */
async function adminTipTransfer({
  admin_name,
  admin_wallet_id,
  user_wallet_id,
  amount_nu,
  note = "",
}) {
  let txnAdmin = null;
  let txnUser = null;
  let journal_code = null;

  const amt = normalizeAmount(amount_nu);

  if (!Number.isFinite(amt) || amt <= 0) {
    await safeWalletLog({
      wallet_id: admin_wallet_id || null,
      action: "ADMIN_TIP_TRANSFER",
      status: "FAILED",
      message: "Amount must be a positive number (Nu).",
      request_payload: {
        admin_name,
        admin_wallet_id,
        user_wallet_id,
        amount_nu,
        note,
      },
    });

    return {
      ok: false,
      status: 400,
      message: "Amount must be a positive number (Nu).",
    };
  }

  const amtStr = amt.toFixed(2);

  try {
    const ids = await fetchTxIdsAndJournalCode();

    const transaction_ids = ids.transaction_ids;
    journal_code = ids.journal_code;
    [txnAdmin, txnUser] = transaction_ids;

    const result = await prisma.$transaction(
      async (tx) => {
        const adminUser = await findAdminByUserName(tx, admin_name);

        if (!adminUser) {
          return {
            ok: false,
            status: 403,
            message: "Admin not found or not permitted.",
          };
        }

        const adminW = await tx.wallets.findUnique({
          where: {
            wallet_id: String(admin_wallet_id).trim(),
          },
        });

        const userW = await tx.wallets.findUnique({
          where: {
            wallet_id: String(user_wallet_id).trim(),
          },
        });

        if (!adminW) {
          return {
            ok: false,
            status: 404,
            message: "Admin wallet not found.",
          };
        }

        if (!userW) {
          return {
            ok: false,
            status: 404,
            message: "User wallet not found.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
          };
        }

        if (String(adminW.status || "").toUpperCase() !== "ACTIVE") {
          return {
            ok: false,
            status: 409,
            message: "Admin wallet is not ACTIVE.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          };
        }

        if (String(userW.status || "").toUpperCase() !== "ACTIVE") {
          return {
            ok: false,
            status: 409,
            message: "User wallet is not ACTIVE.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          };
        }

        if (toDecimalNumber(adminW.amount) < amt) {
          return {
            ok: false,
            status: 409,
            message: "Insufficient admin wallet balance.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          };
        }

        const driver = await tx.drivers.findFirst({
          where: {
            user_id: BigInt(userW.user_id),
          },
          select: {
            driver_id: true,
          },
        });

        if (!driver) {
          return {
            ok: false,
            status: 404,
            message: "Driver not found for this user.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          };
        }

        const debitResult = await tx.wallets.updateMany({
          where: {
            id: BigInt(adminW.id),
            wallet_id: adminW.wallet_id,
            status: "ACTIVE",
            amount: {
              gte: amt,
            },
          },
          data: {
            amount: {
              decrement: amt,
            },
          },
        });

        if (Number(debitResult.count || 0) !== 1) {
          return {
            ok: false,
            status: 409,
            message: "Insufficient admin wallet balance.",
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          };
        }

        const creditResult = await tx.wallets.updateMany({
          where: {
            id: BigInt(userW.id),
            wallet_id: userW.wallet_id,
            status: "ACTIVE",
          },
          data: {
            amount: {
              increment: amt,
            },
          },
        });

        if (Number(creditResult.count || 0) !== 1) {
          throw new Error("Failed to credit user wallet.");
        }

        await tx.wallet_transactions.create({
          data: {
            transaction_id: txnAdmin,
            journal_code,
            tnx_from: adminW.wallet_id,
            tnx_to: userW.wallet_id,
            amount: amt,
            remark: "DR",
            note: note || "",
          },
        });

        await tx.wallet_transactions.create({
          data: {
            transaction_id: txnUser,
            journal_code,
            tnx_from: adminW.wallet_id,
            tnx_to: userW.wallet_id,
            amount: amt,
            remark: "CR",
            note: note || "",
          },
        });

        const activity =
          `TIP_TRANSFER: ${adminUser.user_name} [${adminUser.role}] sent Nu. ${amtStr} ` +
          `to ${userW.wallet_id} (user_id: ${userW.user_id}) from ${adminW.wallet_id}` +
          (note ? ` | ${note}` : "");

        await tx.admin_logs.create({
          data: {
            user_id: BigInt(userW.user_id),
            admin_name: adminUser.user_name,
            activity,
          },
        });

        await tx.ride_ratings.updateMany({
          where: {
            driver_id: BigInt(driver.driver_id),
            payment_status: false,
          },
          data: {
            payment_status: true,
          },
        });

        const adminNew = await tx.wallets.findUnique({
          where: {
            id: BigInt(adminW.id),
          },
        });

        const userNew = await tx.wallets.findUnique({
          where: {
            id: BigInt(userW.id),
          },
        });

        return {
          ok: true,
          journal_code,
          amount: amtStr,
          note,
          admin_verified: {
            user_id: Number(adminUser.user_id),
            user_name: adminUser.user_name,
            role: adminUser.role,
          },
          from: {
            wallet_id: adminNew.wallet_id,
            user_id: Number(adminNew.user_id),
            balance: moneyString(adminNew.amount),
          },
          to: {
            wallet_id: userNew.wallet_id,
            user_id: Number(userNew.user_id),
            balance: moneyString(userNew.amount),
          },
          transactions: {
            admin_dr: txnAdmin,
            user_cr: txnUser,
          },
          _log_meta: {
            admin_wallet: {
              wallet_id: adminW.wallet_id,
              user_id: adminW.user_id,
            },
            user_wallet: {
              wallet_id: userW.wallet_id,
              user_id: userW.user_id,
            },
          },
        };
      },
      {
        maxWait: 5000,
        timeout: 15000,
      },
    );

    if (!result.ok) {
      await safeWalletLog({
        transaction_id: null,
        journal_code,
        wallet_id:
          result.admin_wallet?.wallet_id ||
          result.user_wallet?.wallet_id ||
          admin_wallet_id ||
          null,
        user_id:
          result.admin_wallet?.user_id ||
          result.user_wallet?.user_id ||
          null,
        action: "ADMIN_TIP_TRANSFER",
        status: "FAILED",
        message: result.message,
        request_payload: {
          admin_name,
          admin_wallet_id,
          user_wallet_id,
          amount_nu,
          note,
        },
        response_payload: result,
      });

      delete result.admin_wallet;
      delete result.user_wallet;

      return result;
    }

    const logMeta = result._log_meta || {};
    delete result._log_meta;

    await safeWalletLog({
      transaction_id: txnAdmin,
      journal_code,
      wallet_id: logMeta.admin_wallet?.wallet_id || admin_wallet_id,
      user_id: logMeta.admin_wallet?.user_id || null,
      action: "ADMIN_TIP_TRANSFER",
      status: "SUCCESS",
      message: "Admin wallet debited successfully.",
      request_payload: {
        admin_name,
        admin_wallet_id,
        user_wallet_id,
        amount_nu,
        note,
      },
      response_payload: {
        transaction_id: txnAdmin,
        journal_code,
        amount: amtStr,
        direction: "DR",
        result,
      },
    });

    await safeWalletLog({
      transaction_id: txnUser,
      journal_code,
      wallet_id: logMeta.user_wallet?.wallet_id || user_wallet_id,
      user_id: logMeta.user_wallet?.user_id || null,
      action: "ADMIN_TIP_TRANSFER",
      status: "SUCCESS",
      message: "User wallet credited successfully.",
      request_payload: {
        admin_name,
        admin_wallet_id,
        user_wallet_id,
        amount_nu,
        note,
      },
      response_payload: {
        transaction_id: txnUser,
        journal_code,
        amount: amtStr,
        direction: "CR",
        result,
      },
    });

    return result;
  } catch (err) {
    console.error("Error in adminTipTransfer:", err);

    await safeWalletLog({
      transaction_id: null,
      journal_code,
      wallet_id: admin_wallet_id || null,
      action: "ADMIN_TIP_TRANSFER",
      status: "ERROR",
      message: err.message,
      request_payload: {
        admin_name,
        admin_wallet_id,
        user_wallet_id,
        amount_nu,
        note,
      },
      error_payload: {
        message: err.message,
        stack: err.stack,
      },
    });

    return {
      ok: false,
      status: 500,
      message: err.message,
    };
  }
}

module.exports = {
  adminTipTransfer,
};