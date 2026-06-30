// src/controllers/platformFeeRules.controller.js
import { withConn, qConn, execConn } from "../db/mysql.js";
import { ok, fail } from "../utils/http.js";

const FEE_TYPES = new Set(["percent", "fixed", "mixed"]);
const APPLY_ON = new Set(["subtotal", "fare_after_discounts", "driver_take_home_base"]);

const s = (v) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t : null;
};
const i = (v, def = null) => {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const b01 = (v, def = null) => {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return n ? 1 : 0;
};

const SELECT_FIELDS = `
  rule_id, country_code, city_id, service_type, trip_type, channel,
  fee_type, fee_percent_bp, fee_fixed_cents, min_cents, max_cents,
  apply_on, priority, is_active, starts_at, ends_at, created_at, updated_at
`;

/** GET /platform-fee-rules */
export async function listPlatformFeeRules(req, res) {
  try {
    const where = [];
    const params = [];

    const country_code = s(req.query.country_code);
    const city_id = s(req.query.city_id);
    const service_type = s(req.query.service_type);
    const trip_type = s(req.query.trip_type);
    const channel = s(req.query.channel);
    const is_active = req.query.is_active != null ? b01(req.query.is_active, null) : null;

    const effective_at = s(req.query.effective_at);
    const limit = Math.min(Math.max(i(req.query.limit, 50), 1), 200);
    const offset = Math.max(i(req.query.offset, 0), 0);

    if (country_code) { where.push("country_code = ?"); params.push(country_code); }
    if (city_id) { where.push("city_id = ?"); params.push(city_id); }
    if (service_type) { where.push("service_type = ?"); params.push(service_type); }
    if (trip_type) { where.push("trip_type = ?"); params.push(trip_type); }
    if (channel) { where.push("channel = ?"); params.push(channel); }
    if (is_active !== null) { where.push("is_active = ?"); params.push(is_active); }

    if (effective_at) {
      where.push("starts_at <= ?");
      params.push(effective_at);
      where.push("(ends_at IS NULL OR ends_at > ?)");
      params.push(effective_at);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await withConn((conn) =>
      qConn(
        conn,
        `
        SELECT ${SELECT_FIELDS}
        FROM platform_fee_rules
        ${whereSql}
        ORDER BY priority ASC, rule_id DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      )
    );

    return ok(res, rows);
  } catch (e) {
    console.error("[listPlatformFeeRules]", e);
    return fail(res, 500, "Database error");
  }
}

/** GET /platform-fee-rules/:id */
export async function getPlatformFeeRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const row = await withConn(async (conn) => {
      const rows = await qConn(conn, `SELECT ${SELECT_FIELDS} FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      return rows[0] || null;
    });

    if (!row) return fail(res, 404, "Platform fee rule not found");
    return ok(res, row);
  } catch (e) {
    console.error("[getPlatformFeeRule]", e);
    return fail(res, 500, "Database error");
  }
}

/** POST /platform-fee-rules */
export async function createPlatformFeeRule(req, res) {
  const country_code = s(req.body?.country_code);
  const city_id = s(req.body?.city_id);
  const service_type = s(req.body?.service_type);
  const trip_type = s(req.body?.trip_type);
  const channel = s(req.body?.channel);

  const fee_type = s(req.body?.fee_type);
  const fee_percent_bp = i(req.body?.fee_percent_bp, 0);
  const fee_fixed_cents = i(req.body?.fee_fixed_cents, 0);
  const min_cents = i(req.body?.min_cents, 0);
  const max_cents = i(req.body?.max_cents, 0);

  const apply_on = s(req.body?.apply_on) ?? "subtotal";
  const priority = i(req.body?.priority, 100);
  const is_active = b01(req.body?.is_active, 1);

  const starts_at = s(req.body?.starts_at);
  const ends_at = s(req.body?.ends_at);

  if (!fee_type || !FEE_TYPES.has(fee_type)) return fail(res, 400, "Invalid fee_type");
  if (!APPLY_ON.has(apply_on)) return fail(res, 400, "Invalid apply_on");
  if (!starts_at) return fail(res, 400, "starts_at is required");

  try {
    const created = await withConn(async (conn) => {
      const result = await execConn(
        conn,
        `
        INSERT INTO platform_fee_rules
        (country_code, city_id, service_type, trip_type, channel,
         fee_type, fee_percent_bp, fee_fixed_cents, min_cents, max_cents,
         apply_on, priority, is_active, starts_at, ends_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          country_code, city_id, service_type, trip_type, channel,
          fee_type, fee_percent_bp, fee_fixed_cents, min_cents, max_cents,
          apply_on, priority, is_active, starts_at, ends_at,
        ]
      );

      const id = result.insertId;
      const rows = await qConn(conn, `SELECT ${SELECT_FIELDS} FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      return rows[0];
    });

    return ok(res, created);
  } catch (e) {
    console.error("[createPlatformFeeRule]", e);
    return fail(res, 500, "Database error");
  }
}

/** PUT /platform-fee-rules/:id */
export async function updatePlatformFeeRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const updated = await withConn(async (conn) => {
      const rows = await qConn(conn, `SELECT ${SELECT_FIELDS} FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      const existing = rows[0];
      if (!existing) return null;

      const next = {
        country_code: req.body?.country_code !== undefined ? s(req.body.country_code) : existing.country_code,
        city_id: req.body?.city_id !== undefined ? s(req.body.city_id) : existing.city_id,
        service_type: req.body?.service_type !== undefined ? s(req.body.service_type) : existing.service_type,
        trip_type: req.body?.trip_type !== undefined ? s(req.body.trip_type) : existing.trip_type,
        channel: req.body?.channel !== undefined ? s(req.body.channel) : existing.channel,

        fee_type: req.body?.fee_type !== undefined ? s(req.body.fee_type) : existing.fee_type,
        fee_percent_bp: req.body?.fee_percent_bp !== undefined ? i(req.body.fee_percent_bp, 0) : existing.fee_percent_bp,
        fee_fixed_cents: req.body?.fee_fixed_cents !== undefined ? i(req.body.fee_fixed_cents, 0) : existing.fee_fixed_cents,
        min_cents: req.body?.min_cents !== undefined ? i(req.body.min_cents, 0) : existing.min_cents,
        max_cents: req.body?.max_cents !== undefined ? i(req.body.max_cents, 0) : existing.max_cents,

        apply_on: req.body?.apply_on !== undefined ? s(req.body.apply_on) : existing.apply_on,
        priority: req.body?.priority !== undefined ? i(req.body.priority, 100) : existing.priority,
        is_active: req.body?.is_active !== undefined ? (req.body.is_active === null ? existing.is_active : b01(req.body.is_active, 1)) : existing.is_active,

        starts_at: req.body?.starts_at !== undefined ? s(req.body.starts_at) : existing.starts_at,
        ends_at: req.body?.ends_at !== undefined ? s(req.body.ends_at) : existing.ends_at,
      };

      if (!next.fee_type || !FEE_TYPES.has(next.fee_type)) throw new Error("Invalid fee_type");
      if (!next.apply_on || !APPLY_ON.has(next.apply_on)) throw new Error("Invalid apply_on");
      if (!next.starts_at) throw new Error("starts_at is required");

      await execConn(
        conn,
        `
        UPDATE platform_fee_rules SET
          country_code=?,
          city_id=?,
          service_type=?,
          trip_type=?,
          channel=?,
          fee_type=?,
          fee_percent_bp=?,
          fee_fixed_cents=?,
          min_cents=?,
          max_cents=?,
          apply_on=?,
          priority=?,
          is_active=?,
          starts_at=?,
          ends_at=?
        WHERE rule_id=?
        `,
        [
          next.country_code, next.city_id, next.service_type, next.trip_type, next.channel,
          next.fee_type, next.fee_percent_bp, next.fee_fixed_cents, next.min_cents, next.max_cents,
          next.apply_on, next.priority, next.is_active, next.starts_at, next.ends_at,
          id,
        ]
      );

      const after = await qConn(conn, `SELECT ${SELECT_FIELDS} FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      return after[0];
    });

    if (!updated) return fail(res, 404, "Platform fee rule not found");
    return ok(res, updated);
  } catch (e) {
    console.error("[updatePlatformFeeRule]", e);
    const msg = String(e?.message || "");
    if (msg.startsWith("Invalid") || msg.includes("required")) return fail(res, 400, msg);
    return fail(res, 500, "Database error");
  }
}

/** DELETE /platform-fee-rules/:id */
export async function deletePlatformFeeRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const deleted = await withConn(async (conn) => {
      const rows = await qConn(conn, `SELECT rule_id FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      if (!rows[0]) return false;
      await execConn(conn, `DELETE FROM platform_fee_rules WHERE rule_id = ?`, [id]);
      return true;
    });

    if (!deleted) return fail(res, 404, "Platform fee rule not found");
    return ok(res, true, { message: "Deleted" });
  } catch (e) {
    console.error("[deletePlatformFeeRule]", e);
    return fail(res, 500, "Database error");
  }
}
