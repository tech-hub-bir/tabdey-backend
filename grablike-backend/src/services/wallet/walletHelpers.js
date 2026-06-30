/* ---------------- Resolve user_id + wallet_id for driver/passenger ---------------- */
const WALLETS_TBL = "wallets";

export async function getDriverUserAndWallet(conn, driverId) {
  const [[row]] = await conn.query(
    `SELECT d.user_id FROM drivers d WHERE d.driver_id = ? LIMIT 1`,
    [driverId]
  );

  const user_id = row?.user_id ? Number(row.user_id) : null;
  if (!user_id) return { user_id: null, wallet_id: null };

  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id = ? LIMIT 1`,
    [user_id]
  );

  return { user_id, wallet_id: w?.wallet_id || null };
}