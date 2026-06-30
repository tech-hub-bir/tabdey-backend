import { mysqlPool } from "./mysql.js";

export async function insertMessage(row) {
  const sql = `
    INSERT INTO sms_messages
    (id, to_msisdn, sender_id, text, status, error, smpp_message_id, created_at, sent_at, delivered_at)
    VALUES
    (:id, :to_msisdn, :sender_id, :text, :status, :error, :smpp_message_id, :created_at, :sent_at, :delivered_at)
  `;
  await mysqlPool.execute(sql, row);
  return row.id;
}

export async function updateMessage(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;

  const sets = keys.map((k) => `${k} = :${k}`).join(", ");
  const sql = `UPDATE sms_messages SET ${sets} WHERE id = :id`;
  await mysqlPool.execute(sql, { id, ...patch });
}

export async function updateBySmppMessageId(smppMessageId, patch) {
  if (!smppMessageId) return;

  const keys = Object.keys(patch);
  if (!keys.length) return;

  const sets = keys.map((k) => `${k} = :${k}`).join(", ");
  const sql = `UPDATE sms_messages SET ${sets} WHERE smpp_message_id = :smpp_message_id`;
  await mysqlPool.execute(sql, { smpp_message_id: smppMessageId, ...patch });
}

export async function getMessage(id) {
  const [rows] = await mysqlPool.execute(`SELECT * FROM sms_messages WHERE id = ?`, [id]);
  return rows[0] || null;
}

export async function listMessages({ status, to, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (to) {
    where.push("to_msisdn = ?");
    params.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT * FROM sms_messages
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit), Number(offset));

  const [rows] = await mysqlPool.execute(sql, params);
  return rows;
}
