// orders/walletIdService.js
const axios = require("axios");

const IDS_BOTH_URL = process.env.WALLET_IDS_BOTH_URL;

async function postJson(url, body = {}, timeout = 8000) {
  if (!url) throw new Error("Wallet ID service URL is missing in env.");
  try {
    const { data } = await axios.post(url, body, {
      timeout,
      headers: { "Content-Type": "application/json" },
    });
    return data;
  } catch (e) {
    const status = e?.response?.status;
    const resp = e?.response?.data;
    const respText =
      resp == null
        ? ""
        : typeof resp === "string"
          ? resp.slice(0, 300)
          : JSON.stringify(resp).slice(0, 300);

    throw new Error(
      `Wallet ID service POST failed: ${url} ${status ? `(HTTP ${status})` : ""} ${e?.message || ""} ${respText}`,
    );
  }
}

function extractIdsShape(payload) {
  const p = payload?.data ? payload.data : payload;

  let txn_ids = null;
  if (Array.isArray(p?.transaction_ids) && p.transaction_ids.length >= 2) {
    txn_ids = [String(p.transaction_ids[0]), String(p.transaction_ids[1])];
  } else if (Array.isArray(p?.txn_ids) && p.txn_ids.length >= 2) {
    txn_ids = [String(p.txn_ids[0]), String(p.txn_ids[1])];
  }

  const journal =
    p?.journal_id || p?.journal || p?.journal_code || p?.journalCode || null;

  return { txn_ids, journal_id: journal || null };
}

async function fetchTxnAndJournalIds() {
  const data = await postJson(IDS_BOTH_URL, {});
  const { txn_ids, journal_id } = extractIdsShape(data);

  if (txn_ids && txn_ids.length >= 2) {
    return { dr_id: txn_ids[0], cr_id: txn_ids[1], journal_id };
  }

  throw new Error(
    `Wallet ID service returned unexpected payload: ${JSON.stringify(data).slice(0, 500)}`,
  );
}

// Prefetch transaction IDs OUTSIDE DB tx to avoid holding locks while doing HTTP
async function prefetchTxnIdsBatch(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fetchTxnAndJournalIds());
  return out;
}

module.exports = {
  fetchTxnAndJournalIds,
  prefetchTxnIdsBatch,
};
