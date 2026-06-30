// orders/walletLookups.js
const db = require("../../config/db");

/* ======================= CONFIG ======================= */
const ADMIN_WALLET_ID = process.env.ADMIN_WALLET_ID;

/* ================= WALLET LOOKUPS ================= */
async function getBuyerWalletByUserId(user_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status
       FROM wallets
      WHERE user_id = ?
      LIMIT 1`,
    [user_id],
  );
  return rows[0] || null;
}

async function getAdminWallet(conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `SELECT id, wallet_id, user_id, amount, status
       FROM wallets
      WHERE wallet_id = ?
      LIMIT 1`,
    [ADMIN_WALLET_ID],
  );
  return rows[0] || null;
}

async function getMerchantWalletByBusinessId(business_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT w.id, w.wallet_id, w.user_id, w.amount, w.status
      FROM merchant_business_details m
      JOIN wallets w ON w.user_id = m.user_id
     WHERE m.business_id = ?
     LIMIT 1
    `,
    [business_id],
  );
  return rows[0] || null;
}

module.exports = {
  ADMIN_WALLET_ID,
  getBuyerWalletByUserId,
  getAdminWallet,
  getMerchantWalletByBusinessId,
};
