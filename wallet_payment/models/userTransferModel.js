// models/userTransferModel.js
const axios = require("axios");
const { prisma } = require("../lib/prisma");

const {
  createWalletTransactionLog,
} = require("./walletTransactionLogModel");

/**
 * POST https://grab.newedge.bt/wallet/ids/both
 * returns:
 * {
 *   ok: true,
 *   data: {
 *     transaction_ids: [ "TNX...", "TNX..." ],
 *     journal_code: "JRN..."
 *   }
 * }
 */
async function fetchTxIdsAndJournalCode() {
  const url = String(process.env.WALLET_IDS_BOTH_URL || "").trim();

  if (!url) {
    throw new Error("WALLET_IDS_BOTH_URL missing in env");
  }

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
}

/* ---------------- helpers ---------------- */

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

function normalizeAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function prismaModelFields(modelName) {
  try {
    const model = prisma?._runtimeDataModel?.models?.[modelName];

    if (!model || !Array.isArray(model.fields)) {
      return new Set();
    }

    return new Set(model.fields.map((f) => f.name));
  } catch {
    return new Set();
  }
}

function transactionCreateData(data) {
  const fields = prismaModelFields("wallet_transactions");

  const out = {
    transaction_id: data.transaction_id,
    journal_code: data.journal_code,
    tnx_from: data.tnx_from,
    tnx_to: data.tnx_to,
    amount: data.amount,
    remark: data.remark,
    note: data.note,
  };

  const now = new Date();

  if (fields.has("created_at")) out.created_at = now;
  if (fields.has("updated_at")) out.updated_at = now;

  return out;
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

/**
 * Wallet-to-wallet transfer logic
 * Inserts two rows:
 *  - DR (sender)
 *  - CR (recipient)
 */
async function userWalletTransfer({
  sender_wallet_id,
  recipient_wallet_id,
  amount_nu,
  note = "",
}) {
  let txIdDr = null;
  let txIdCr = null;
  let journal_code = null;

  try {
    const ids = await fetchTxIdsAndJournalCode();

    const transaction_ids = ids.transaction_ids;
    journal_code = ids.journal_code;
    [txIdDr, txIdCr] = transaction_ids;

    const amt = normalizeAmount(amount_nu);

    if (!Number.isFinite(amt) || amt <= 0) {
      return {
        ok: false,
        status: 400,
        message: "Invalid amount.",
      };
    }

    const result = await prisma.$transaction(async (tx) => {
      const sender = await tx.wallets.findUnique({
        where: {
          wallet_id: String(sender_wallet_id).trim(),
        },
        select: {
          id: true,
          user_id: true,
          wallet_id: true,
          amount: true,
          status: true,
        },
      });

      if (!sender) {
        return {
          ok: false,
          status: 404,
          message: "Sender wallet not found.",
        };
      }

      const recipient = await tx.wallets.findUnique({
        where: {
          wallet_id: String(recipient_wallet_id).trim(),
        },
        select: {
          id: true,
          user_id: true,
          wallet_id: true,
          amount: true,
          status: true,
        },
      });

      if (!recipient) {
        return {
          ok: false,
          status: 404,
          message: "Recipient wallet not found.",
        };
      }

      if (String(sender.status || "").toUpperCase() !== "ACTIVE") {
        return {
          ok: false,
          status: 403,
          message: "Sender wallet is not ACTIVE.",
          sender_wallet: {
            wallet_id: sender.wallet_id,
            user_id: sender.user_id,
          },
        };
      }

      if (String(recipient.status || "").toUpperCase() !== "ACTIVE") {
        return {
          ok: false,
          status: 403,
          message: "Recipient wallet is not ACTIVE.",
          sender_wallet: {
            wallet_id: sender.wallet_id,
            user_id: sender.user_id,
          },
          recipient_wallet: {
            wallet_id: recipient.wallet_id,
            user_id: recipient.user_id,
          },
        };
      }

      if (toDecimalNumber(sender.amount) < amt) {
        return {
          ok: false,
          status: 400,
          message: "Insufficient balance in sender wallet.",
          sender_wallet: {
            wallet_id: sender.wallet_id,
            user_id: sender.user_id,
          },
          recipient_wallet: {
            wallet_id: recipient.wallet_id,
            user_id: recipient.user_id,
          },
        };
      }

      const debitResult = await tx.wallets.updateMany({
        where: {
          id: sender.id,
          wallet_id: String(sender_wallet_id).trim(),
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
          status: 400,
          message: "Insufficient balance in sender wallet.",
          sender_wallet: {
            wallet_id: sender.wallet_id,
            user_id: sender.user_id,
          },
          recipient_wallet: {
            wallet_id: recipient.wallet_id,
            user_id: recipient.user_id,
          },
        };
      }

      const creditResult = await tx.wallets.updateMany({
        where: {
          id: recipient.id,
          wallet_id: String(recipient_wallet_id).trim(),
          status: "ACTIVE",
        },
        data: {
          amount: {
            increment: amt,
          },
        },
      });

      if (Number(creditResult.count || 0) !== 1) {
        throw new Error("Failed to credit recipient wallet.");
      }

      await tx.wallet_transactions.create({
        data: transactionCreateData({
          transaction_id: txIdDr,
          journal_code,
          tnx_from: String(sender_wallet_id).trim(),
          tnx_to: String(recipient_wallet_id).trim(),
          amount: amt,
          remark: "DR",
          note: note || "",
        }),
      });

      await tx.wallet_transactions.create({
        data: transactionCreateData({
          transaction_id: txIdCr,
          journal_code,
          tnx_from: String(sender_wallet_id).trim(),
          tnx_to: String(recipient_wallet_id).trim(),
          amount: amt,
          remark: "CR",
          note: note || "",
        }),
      });

      const senderNew = await tx.wallets.findUnique({
        where: {
          id: sender.id,
        },
        select: {
          amount: true,
        },
      });

      const recipientNew = await tx.wallets.findUnique({
        where: {
          id: recipient.id,
        },
        select: {
          amount: true,
        },
      });

      return {
        ok: true,
        status: 200,
        message: "Transfer completed.",
        journal_code,
        transaction_ids,
        sender_balance: toDecimalNumber(senderNew?.amount),
        recipient_balance: toDecimalNumber(recipientNew?.amount),
        sender_wallet: {
          wallet_id: sender.wallet_id,
          user_id: sender.user_id,
        },
        recipient_wallet: {
          wallet_id: recipient.wallet_id,
          user_id: recipient.user_id,
        },
      };
    });

    if (!result.ok) {
      await safeWalletLog({
        transaction_id: null,
        journal_code,
        wallet_id: sender_wallet_id,
        user_id: result.sender_wallet?.user_id || null,
        action: "USER_WALLET_TRANSFER",
        status: "FAILED",
        message: result.message,
        request_payload: {
          sender_wallet_id,
          recipient_wallet_id,
          amount_nu,
          note,
        },
        response_payload: result,
      });

      return result;
    }

    await safeWalletLog({
      transaction_id: txIdDr,
      journal_code,
      wallet_id: result.sender_wallet.wallet_id,
      user_id: result.sender_wallet.user_id,
      action: "USER_WALLET_TRANSFER",
      status: "SUCCESS",
      message: "Sender wallet debited successfully.",
      request_payload: {
        sender_wallet_id,
        recipient_wallet_id,
        amount_nu,
        note,
      },
      response_payload: {
        transaction_id: txIdDr,
        journal_code,
        amount_nu,
        direction: "DR",
        sender_balance: result.sender_balance,
      },
    });

    await safeWalletLog({
      transaction_id: txIdCr,
      journal_code,
      wallet_id: result.recipient_wallet.wallet_id,
      user_id: result.recipient_wallet.user_id,
      action: "USER_WALLET_TRANSFER",
      status: "SUCCESS",
      message: "Recipient wallet credited successfully.",
      request_payload: {
        sender_wallet_id,
        recipient_wallet_id,
        amount_nu,
        note,
      },
      response_payload: {
        transaction_id: txIdCr,
        journal_code,
        amount_nu,
        direction: "CR",
        recipient_balance: result.recipient_balance,
      },
    });

    delete result.sender_wallet;
    delete result.recipient_wallet;

    return result;
  } catch (err) {
    console.error("Error in userWalletTransfer:", err);

    await safeWalletLog({
      transaction_id: null,
      journal_code,
      wallet_id: sender_wallet_id || null,
      action: "USER_WALLET_TRANSFER",
      status: "ERROR",
      message: err.message,
      request_payload: {
        sender_wallet_id,
        recipient_wallet_id,
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
  userWalletTransfer,
};