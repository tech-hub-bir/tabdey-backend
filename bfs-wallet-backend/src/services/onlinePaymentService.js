const { createPayment, updatePayment, getPayment } = require("../config/onlinePaymentDb");
const { sendAR, sendAE, sendDR, sendAS } = require("./bfsClient");
const walletService = require("./walletService");

// System wallet owner — receives all online payments.
// Set SYSTEM_WALLET_USER_ID in your .env.
function getSystemUserId() {
  const id = Number(process.env.SYSTEM_WALLET_USER_ID);
  if (!id) throw new Error("SYSTEM_WALLET_USER_ID is not configured");
  return id;
}

function generateOrderNo() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `PAY${ts}${rand}`;
}

function formatTxnTime(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

const BFS_CODE_MESSAGES = {
  "00": "Payment successful.",
  "03": "Invalid beneficiary.",
  "05": "Beneficiary account closed.",
  "12": "Invalid transaction.",
  "13": "Invalid amount.",
  "14": "Invalid remitter account.",
  "20": "Invalid response from bank.",
  "30": "Transaction not supported or format error.",
  "45": "Duplicate order number.",
  "47": "Invalid currency.",
  "48": "Transaction limit exceeded.",
  "51": "Insufficient funds.",
  "53": "No savings account found.",
  "57": "Transaction not permitted.",
  "61": "Withdrawal limit exceeded.",
  "65": "Withdrawal frequency exceeded.",
  "76": "Transaction not found.",
  "78": "Decryption failed.",
  "80": "Transaction cancelled by buyer.",
  "84": "Invalid transaction type.",
  "85": "Internal error at bank system.",
  BC: "Transaction cancelled by customer.",
  UC: "Transaction cancelled by customer.",
  NF: "Transaction not found.",
  UN: "Unknown error.",
  IM: "Invalid request received.",
  DO: "Duplicate order number received.",
  IE: "Account verification failed. Please check your bank and account number.",
  TO: "Transaction timed out.",
  TI: "Transaction invalid status.",
  RB: "Remitter bank is blocked.",
  IB: "Invalid remitter bank.",
  ID: "Transaction ID invalid.",
};

function mapBfsMessage(code, defaultMsg) {
  return BFS_CODE_MESSAGES[code] || defaultMsg || "Payment failed.";
}

function logBfs(tag, orderNo, payload) {
  try {
    console.log(
      `[BFS-PAY][${tag}][orderNo=${orderNo}]`,
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
    );
  } catch {
    console.log(`[BFS-PAY][${tag}][orderNo=${orderNo}]`, payload);
  }
}

// ==== INIT (AR) ====
async function initPayment({ userId, amount, email, description }) {
  if (!amount || amount <= 0) throw new Error("Invalid amount");

  const now = new Date();
  const orderNo = generateOrderNo();
  const benfTxnTime = formatTxnTime(now);

  createPayment({
    order_no: orderNo,
    user_id: userId || null,
    amount,
    currency: "BTN",
    description: description || "Online payment",
    status: "INITIATED",
    bfs_txn_id: null,
    benf_txn_time: benfTxnTime,
    created_at: now,
    updated_at: now,
    system_credited: false,
  });

  const { raw, obj } = await sendAR({
    orderNo,
    benfTxnTime,
    amount,
    remitterEmail: email,
    paymentDesc: description || "Online payment",
  });

  logBfs("AR-RC-RAW", orderNo, raw);
  logBfs("AR-RC-OBJ", orderNo, obj);

  if (obj.bfs_responseCode !== "00") {
    updatePayment(orderNo, {
      status: "AR_FAILED",
      bfs_response_code: obj.bfs_responseCode,
      bfs_response_desc: obj.bfs_responseDesc,
      raw_rc: raw,
    });

    const err = new Error(
      mapBfsMessage(obj.bfs_responseCode, obj.bfs_responseDesc || "Authorization failed.")
    );
    err.code = obj.bfs_responseCode;
    err.status = 400;
    throw err;
  }

  const bfsTxnId = obj.bfs_bfsTxnId;

  updatePayment(orderNo, {
    status: "AR_OK",
    bfs_txn_id: bfsTxnId,
    bfs_response_code: obj.bfs_responseCode,
    bfs_response_desc: obj.bfs_responseDesc,
    raw_rc: raw,
  });

  const bankListStr = obj.bfs_bankList || "";
  const bankList = bankListStr
    .split("#")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split("~");
      return { id: parts[0], name: parts[1], status: parts[2] };
    });

  return { orderNo, bfsTxnId, bankList };
}

// ==== ACCOUNT ENQUIRY (AE) ====
async function accountEnquiry({ orderNo, remitterBankId, remitterAccNo }) {
  const payment = getPayment(orderNo);
  if (!payment) throw new Error("Order not found");
  if (!payment.bfs_txn_id) throw new Error("BFS transaction not initialized");

  const { raw, obj } = await sendAE({
    bfsTxnId: payment.bfs_txn_id,
    remitterBankId,
    remitterAccNo,
    orderNo,
  });

  logBfs("AE-EC-RAW", orderNo, raw);
  logBfs("AE-EC-OBJ", orderNo, obj);

  if (obj.bfs_responseCode !== "00") {
    updatePayment(orderNo, {
      status: "AE_FAILED",
      raw_ec: raw,
      bfs_ae_code: obj.bfs_responseCode,
      bfs_ae_desc: obj.bfs_responseDesc,
    });

    const err = new Error(
      mapBfsMessage(obj.bfs_responseCode, obj.bfs_responseDesc || "Account verification failed.")
    );
    err.code = obj.bfs_responseCode;
    err.status = 400;
    throw err;
  }

  updatePayment(orderNo, {
    status: "AE_OK",
    remitter_bank_id: remitterBankId,
    remitter_acc_no: remitterAccNo,
    raw_ec: raw,
  });

  return {
    orderNo,
    status: "ACCOUNT_VERIFIED",
    responseCode: obj.bfs_responseCode,
    responseDesc: obj.bfs_responseDesc,
  };
}

// ==== PAY (DR) — credits system wallet ====
async function pay({ orderNo, otp }) {
  const payment = getPayment(orderNo);
  if (!payment) throw new Error("Order not found");
  if (!payment.bfs_txn_id) throw new Error("BFS transaction not initialized");

  const { raw, obj } = await sendDR({
    bfsTxnId: payment.bfs_txn_id,
    otp,
    orderNo,
  });

  logBfs("DR-AC-RAW", orderNo, raw);
  logBfs("DR-AC-OBJ", orderNo, obj);

  const code = obj.bfs_debitAuthCode;
  const isSuccess = code === "00";

  updatePayment(orderNo, {
    status: isSuccess ? "SUCCESS" : "FAILED",
    bfs_debit_auth_code: code,
    bfs_debit_auth_no: obj.bfs_debitAuthNo,
    remitter_name: obj.bfs_remitterName,
    remitter_bank_id: obj.bfs_remitterBankId,
    raw_ac: raw,
    dr_submitted_at: new Date(),
    as_poll_count: 0,
  });

  if (isSuccess && !payment.system_credited) {
    const systemUserId = getSystemUserId();
    try {
      await walletService.credit(systemUserId, payment.amount, {
        journalCode: orderNo,
        transactionId: orderNo,
        tnxFrom: obj?.bfs_remitterBankId || "BFS",
        note: payment.description || "Online payment",
      });

      updatePayment(orderNo, { system_credited: true });
    } catch (err) {
      logBfs("SYSTEM-CREDIT-ERROR", orderNo, err.message || err);
      throw err;
    }
  }

  return {
    orderNo,
    bfsTxnId: payment.bfs_txn_id,
    status: isSuccess ? "SUCCESS" : "FAILED",
    code,
    message: mapBfsMessage(code, "Payment result received."),
    amount: payment.amount,
  };
}

// ==== STATUS (AS) ====
// Spec rules: start polling 6 min after DR, max 3 retries.
const AS_MIN_DELAY_MS = 6 * 60 * 1000;
const AS_MAX_POLLS = 3;

async function checkStatus(orderNo) {
  const payment = getPayment(orderNo);
  if (!payment) throw new Error("Order not found");

  if (payment.dr_submitted_at) {
    const pollCount = payment.as_poll_count || 0;

    if (pollCount >= AS_MAX_POLLS) {
      const err = new Error(
        "Maximum status check attempts (3) reached. Transaction is deemed approved — contact RMA support if funds are not settled."
      );
      err.status = 429;
      throw err;
    }

    const elapsed = Date.now() - new Date(payment.dr_submitted_at).getTime();
    if (elapsed < AS_MIN_DELAY_MS) {
      const waitSec = Math.ceil((AS_MIN_DELAY_MS - elapsed) / 1000);
      const err = new Error(
        `Status check too early. Please wait ${waitSec} more seconds before polling (RMA spec requires 6 minutes after debit request).`
      );
      err.status = 429;
      throw err;
    }

    updatePayment(orderNo, { as_poll_count: pollCount + 1 });
  }

  const { raw, obj } = await sendAS({
    orderNo,
    benfTxnTime: payment.benf_txn_time,
    amount: payment.amount,
    remitterEmail: "N/A",
    paymentDesc: payment.description || "Online payment",
  });

  logBfs("AS-AC-RAW", orderNo, raw);
  logBfs("AS-AC-OBJ", orderNo, obj);

  const code = obj.bfs_debitAuthCode;
  const isSuccess = code === "00";

  updatePayment(orderNo, {
    status: isSuccess ? "SUCCESS" : "FAILED",
    bfs_debit_auth_code: code,
    bfs_debit_auth_no: obj.bfs_debitAuthNo,
    raw_as: raw,
  });

  if (isSuccess && !payment.system_credited) {
    const systemUserId = getSystemUserId();
    try {
      await walletService.credit(systemUserId, payment.amount, {
        journalCode: orderNo,
        transactionId: orderNo,
        tnxFrom: obj?.bfs_remitterBankId || "BFS",
        note: payment.description || "Online payment",
      });

      updatePayment(orderNo, { system_credited: true });
    } catch (err) {
      logBfs("SYSTEM-CREDIT-ERROR", orderNo, err.message || err);
      throw err;
    }
  }

  return {
    orderNo,
    status: isSuccess ? "SUCCESS" : "FAILED",
    code,
    message: mapBfsMessage(code, "Payment status refreshed."),
    from: "BFS",
  };
}

module.exports = { initPayment, accountEnquiry, pay, checkStatus };
