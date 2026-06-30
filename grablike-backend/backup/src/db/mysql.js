// src/db/mysql.js
import mysql from "mysql2/promise";
import { env } from "../config/env.js";

export const mysqlPool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  connectionLimit: Number(env.MYSQL_CONNECTION_LIMIT || 10),
  timezone: "Z",
});

export async function getConn() {
  const conn = await mysqlPool.getConnection();
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

export async function withConn(fn) {
  const conn = await getConn();
  try {
    await conn.ping();
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function qConn(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

export async function execConn(conn, sql, params = []) {
  const [result] = await conn.execute(sql, params);
  return result;
}
