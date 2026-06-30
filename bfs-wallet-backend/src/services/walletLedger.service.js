// src/services/walletLedger.service.js  (CommonJS)

async function auditWithdrawal(conn, { requestId, actorType, actorId = null, action, metadata = null }) {
  await conn.execute(
    `INSERT INTO withdrawal_audit (request_id, actor_type, actor_id, action, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
    [requestId, actorType, actorId, action, metadata ? JSON.stringify(metadata) : null]
  );
}

async function postWalletLedger(conn, { userId, entryType, amount, sourceType, sourceId, note = null }) {
  await conn.execute(
    `INSERT INTO wallet_ledger (user_id, entry_type, amount, source_type, source_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, entryType, amount, sourceType, sourceId, note]
  );
}

module.exports = { auditWithdrawal, postWalletLedger };
