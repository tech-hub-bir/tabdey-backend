const rand = () => Math.random().toString(36).slice(2);
const genTxnId = () => `TNX${Date.now()}${rand().toUpperCase()}`;
const genJournal = () => `JRN${rand().toUpperCase()}${rand().toUpperCase()}`;


function asMoneyString(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // 2dp string to avoid float issues in SQL
  return n.toFixed(2);
}
function clampNote(s, max = 180) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}


export async function walletTransfer(conn, { from_wallet, to_wallet, driver_credit_nu, passenger_debit_nu, reason, meta }) {
  const driver_credit_str = asMoneyString(driver_credit_nu);
  const passenger_debit_str = asMoneyString(passenger_debit_nu);
  if (!driver_credit_str) return { ok: false, reason: "invalid_amount" };
  if (Number(driver_credit_str) <= 0) return { ok: false, reason: "amount_not_positive" };

  const fromId = String(from_wallet).trim();
  const toId = String(to_wallet).trim();
  if (!fromId || !toId) return { ok: false, reason: "wallet_missing" };
  if (fromId === toId) return { ok: false, reason: "same_wallet" };

  // Lock wallets in consistent order to avoid deadlocks
  const [w1, w2] = fromId < toId ? [fromId, toId] : [toId, fromId];

  const [[w1row]] = await conn.execute(
    `SELECT wallet_id, amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [w1]
  );
  const [[w2row]] = await conn.execute(
    `SELECT wallet_id, amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [w2]
  );
  if (!w1row || !w2row) return { ok: false, reason: "wallet_not_found" };

  // Ensure sender has balance
  const [[fromRow]] = await conn.execute(
    `SELECT amount FROM wallets WHERE wallet_id = ? FOR UPDATE`,
    [fromId]
  );
  const fromBal = Number(fromRow?.amount ?? 0);
  if (!Number.isFinite(fromBal)) return { ok: false, reason: "invalid_balance" };
  if (fromBal < Number(driver_credit_str)) return { ok: false, reason: "insufficient_balance" };

  console.log("Driver credit Str:", driver_credit_str);
  console.log("Passenger debit Str:", passenger_debit_str);
  // ✅ debit with guard
  const [debit] = await conn.execute(
    `UPDATE wallets
     SET amount = amount - ?
     WHERE wallet_id = ? AND amount >= ?`,
    [passenger_debit_str, fromId, driver_credit_str]
  );
  if (!debit.affectedRows) return { ok: false, reason: "insufficient_balance_race" };

  // ✅ credit
  await conn.execute(
    `UPDATE wallets
     SET amount = amount + ?
     WHERE wallet_id = ?`,
    [driver_credit_str, toId]
  );

  // ✅ transaction ids must be UNIQUE (your DB enforces it)

  const txn_cr = genTxnId();
  const txn_dr = genTxnId();

  const journal_code = genJournal(); // varchar(36) ok
  const note = clampNote(JSON.stringify({ reason, ...(meta || {}) }), 500);
  const ts = new Date();

  // Sender row (DR) - remark ENUM('CR','DR')
  await conn.execute(
    `
    INSERT INTO wallet_transactions
      (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [txn_dr, journal_code, fromId, toId, passenger_debit_str, "DR", note, ts, ts]
  );

  // Receiver row (CR)
  await conn.execute(
    `
    INSERT INTO wallet_transactions
      (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [txn_cr, journal_code, fromId, toId, driver_credit_str, "CR", note, ts, ts]
  );

  return {
    ok: true,
    transaction_id_dr: txn_dr,
    transaction_id_cr: txn_cr,
    amount: Number(driver_credit_str),
  };
}