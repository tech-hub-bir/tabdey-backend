// src/models/userModel.js
import { withConn, qConn, execConn } from '../db/mysql.js';

export const findUserById = async (userId) => {
  const sql = `
    SELECT user_id, tier, segment, points
    FROM users
    WHERE user_id = ?
    LIMIT 1
  `;
  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [userId]);
    return rows.length ? rows[0] : null;
  });
};

export const updateUserPoints = async (userId, newPoints) => {
  const sql = `
    UPDATE users
    SET points = ?
    WHERE user_id = ?
  `;
  return withConn(async (conn) => execConn(conn, sql, [newPoints, userId]));
};

export const addUserPoints = async (userId, pointsToAdd) => {
  return withConn(async (conn) => {
    await conn.beginTransaction();
    try {
      const rows = await qConn(conn, 'SELECT points FROM users WHERE user_id = ? FOR UPDATE', [userId]);
      if (!rows.length) throw new Error('User not found');
      const current = rows[0].points || 0;
      const newPoints = current + pointsToAdd;
      await execConn(conn, 'UPDATE users SET points = ? WHERE user_id = ?', [newPoints, userId]);
      await conn.commit();
      return newPoints;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
};