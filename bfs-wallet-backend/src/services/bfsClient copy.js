// src/services/bfsClient.js
const axios = require("axios");
const {
  BFS_API_URL,
  BFS_AS_URL,
  BFS_BENF_ID,
  BFS_BENF_BANK_CODE,
  BFS_TXN_CURRENCY,
  BFS_VERSION,
  BFS_TIMEOUT_MS,
} = require("../config/bfsConfig");
const {
  buildSourceString,
  signChecksum,
  // verifyChecksum,
} = require("../utils/bfsChecksum");
const { toFormUrlEncoded, parseBfsResponse } = require("../utils/nvp");
const { logRmaPg } = require("./rmaLogService");

// ===== Field orders from BFS spec =====

// AR / AS
const AR_AS_FIELDS = [
  "bfs_benfBankCode",
  "bfs_benfId",
  "bfs_benfTxnTime",
  "bfs_msgType",
  "bfs_orderNo",
  "bfs_paymentDesc",
  "bfs_remitterEmail",
  "bfs_txnAmount",
  "bfs_txnCurrency",
  "bfs_version",
];

// AE
const AE_FIELDS = [
  "bfs_benfId",
  "bfs_bfsTxnId",
  "bfs_msgType",
  "bfs_remitterAccNo",
  "bfs_remitterBankId",
];

// DR
const DR_FIELDS = [
  "bfs_benfId",
  "bfs_bfsTxnId",
  "bfs_msgType",
  "bfs_remitterOtp",
];

// RC (response to AR)
const RC_FIELDS = [
  "bfs_bankList",
  "bfs_bfsTxnId",
  "bfs_msgType",
  "bfs_responseCode",
  "bfs_responseDesc",
];

// EC (response to AE)
const EC_FIELDS = [
  "bfs_msgType",
  "bfs_responseCode",
  "bfs_responseDesc",
];

// AC (response to DR / AS)
const AC_FIELDS = [
  "bfs_benfId",
  "bfs_benfTxnTime",
  "bfs_bfsTxnId",
  "bfs_bfsTxnTime",
  "bfs_debitAuthCode",
  "bfs_debitAuthNo",
  "bfs_msgType",
  "bfs_orderNo",
  "bfs_remitterBankId",
  "bfs_remitterName",
  "bfs_txnAmount",
  "bfs_txnCurrency",
];

// ===== Core POST helper =====
// logCtx = { tag?, orderNo?, bfsTxnId? }
async function postToBfs(url, params, fieldOrder, respFieldOrder, logCtx = {}) {
  const source = buildSourceString(params, fieldOrder);
  const checksum = signChecksum(source);
  const fullParams = { ...params, bfs_checkSum: checksum };

  const body = toFormUrlEncoded(fullParams);
  // console.log("[BFS] Request body:", body);

  const { data } = await axios.post(url, body, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: BFS_TIMEOUT_MS,
  });

  const raw = typeof data === "string" ? data : String(data);
  const respObj = parseBfsResponse(raw);
  // console.log("[BFS] Raw response:", raw);
  // console.log("[BFS] Parsed response:", respObj);

  // 🔐 Log raw BFS response directly into DB
  try {
    const tag =
      logCtx.tag ||
      `${(params.bfs_msgType || "").toUpperCase()}-RES`; // e.g. AR-RES, AE-RES, ...
    const orderNo =
      logCtx.orderNo ||
      params.bfs_orderNo ||
      respObj.bfs_orderNo ||
      null;
    const bfsTxnId =
      logCtx.bfsTxnId ||
      respObj.bfs_bfsTxnId ||
      params.bfs_bfsTxnId ||
      null;

    await logRmaPg({
      orderNo,
      bfsTxnId,
      tag,
      raw,
    });
  } catch (e) {
    console.error("[RMA_LOG] failed to insert log:", e.message || e);
  }

  // 🔒 If you later enable response checksum verification, do it AFTER logging
  // so even failures are captured.
  // if (respObj.bfs_checkSum && respFieldOrder) {
  //   const ok = verifyChecksum(respObj, respFieldOrder, respObj.bfs_checkSum);
  //   if (!ok) {
  //     const err = new Error("BFS response checksum verification failed");
  //     err.raw = raw;
  //     throw err;
  //   }
  // }

  return { raw, obj: respObj };
}

// ===== High-level helpers =====

// AR – Authorization Request (init topup)
async function sendAR({ orderNo, benfTxnTime, amount, remitterEmail, paymentDesc }) {
  const params = {
    bfs_msgType: "AR",
    bfs_benfTxnTime: benfTxnTime,
    bfs_orderNo: orderNo,

    bfs_benfId: BFS_BENF_ID,
    bfs_benfBankCode: BFS_BENF_BANK_CODE,

    bfs_txnCurrency: BFS_TXN_CURRENCY || "BTN",
    bfs_txnAmount: Number(amount).toFixed(1), // e.g. 600.0
    bfs_remitterEmail: remitterEmail || "",
    bfs_paymentDesc: paymentDesc || "Wallet topup",
    bfs_version: BFS_VERSION || "1.0",
  };

  return postToBfs(BFS_API_URL, params, AR_AS_FIELDS, RC_FIELDS, {
    tag: "AR-RC",
    orderNo,
  });
}

// AE – Account Enquiry
async function sendAE({ bfsTxnId, remitterBankId, remitterAccNo, orderNo }) {
  const params = {
    bfs_msgType: "AE",
    bfs_bfsTxnId: bfsTxnId,
    bfs_benfId: BFS_BENF_ID,
    bfs_remitterBankId: remitterBankId,
    bfs_remitterAccNo: remitterAccNo,
  };

  return postToBfs(BFS_API_URL, params, AE_FIELDS, EC_FIELDS, {
    tag: "AE-EC",
    orderNo: orderNo || null,
    bfsTxnId,
  });
}

// DR – Debit Request (OTP)
async function sendDR({ bfsTxnId, otp, orderNo }) {
  const params = {
    bfs_msgType: "DR",
    bfs_bfsTxnId: bfsTxnId,
    bfs_benfId: BFS_BENF_ID,
    bfs_remitterOtp: otp,
  };

  return postToBfs(BFS_API_URL, params, DR_FIELDS, AC_FIELDS, {
    tag: "DR-AC",
    orderNo: orderNo || null,
    bfsTxnId,
  });
}

// AS – Status Check
async function sendAS({ orderNo, benfTxnTime, amount, remitterEmail, paymentDesc }) {
  const params = {
    bfs_msgType: "AS",
    bfs_benfTxnTime: benfTxnTime,
    bfs_orderNo: orderNo,
    bfs_benfId: BFS_BENF_ID,
    bfs_benfBankCode: BFS_BENF_BANK_CODE,
    bfs_txnCurrency: BFS_TXN_CURRENCY || "BTN",
    bfs_txnAmount: Number(amount).toFixed(1),
    bfs_remitterEmail: remitterEmail || "",
    bfs_paymentDesc: paymentDesc || "Wallet topup",
    bfs_version: BFS_VERSION || "1.0",
  };

  return postToBfs(BFS_AS_URL, params, AR_AS_FIELDS, AC_FIELDS, {
    tag: "AS-AC",
    orderNo,
  });
}

module.exports = {
  sendAR,
  sendAE,
  sendDR,
  sendAS,
};
