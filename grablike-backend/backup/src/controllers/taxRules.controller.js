// src/controllers/taxRules.controller.js
import { withConn, qConn, execConn } from "../db/mysql.js";
import { ok, fail } from "../utils/http.js";

const TAX_TYPES = new Set(["VAT", "GST", "TDS", "DST", "LOCAL_SURCHARGE"]);
const TAXABLE_BASES = new Set([
  "platform_fee",
  "fare_subtotal",
  "fare_after_discounts",
  "driver_earnings",
]);

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
  tax_rule_id, country_code, city_id, service_type, tax_type,
  rate_percent_bp, tax_inclusive, taxable_base,
  priority, is_active, starts_at, ends_at, created_at, updated_at
`;

/** GET /tax-rules */
export async function listTaxRules(req, res) {
  try {
    const where = [];
    const params = [];

    const country_code = s(req.query.country_code);
    const city_id = s(req.query.city_id);
    const service_type = s(req.query.service_type);
    const tax_type = s(req.query.tax_type);
    const is_active =
      req.query.is_active != null ? b01(req.query.is_active, null) : null;

    const effective_at = s(req.query.effective_at); // optional datetime
    const limit = Math.min(Math.max(i(req.query.limit, 50), 1), 200);
    const offset = Math.max(i(req.query.offset, 0), 0);

    if (country_code) {
      where.push("country_code = ?");
      params.push(country_code);
    }
    if (city_id) {
      where.push("city_id = ?");
      params.push(city_id);
    }
    if (service_type) {
      where.push("service_type = ?");
      params.push(service_type);
    }
    if (tax_type) {
      where.push("tax_type = ?");
      params.push(tax_type);
    }
    if (is_active !== null) {
      where.push("is_active = ?");
      params.push(is_active);
    }

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
        FROM tax_rules
        ${whereSql}
        ORDER BY priority ASC, tax_rule_id DESC
        LIMIT ? OFFSET ?
        `,
        [...params, limit, offset]
      )
    );

    return ok(res, rows);
  } catch (e) {
    console.error("[listTaxRules]", e);
    return fail(res, 500, "Database error");
  }
}

/** GET /tax-rules/:id */
export async function getTaxRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const row = await withConn(async (conn) => {
      const rows = await qConn(
        conn,
        `SELECT ${SELECT_FIELDS} FROM tax_rules WHERE tax_rule_id = ?`,
        [id]
      );
      return rows[0] || null;
    });

    if (!row) return fail(res, 404, "Tax rule not found");
    return ok(res, row);
  } catch (e) {
    console.error("[getTaxRule]", e);
    return fail(res, 500, "Database error");
  }
}

/** POST /tax-rules */
export async function createTaxRule(req, res) {
  const country_code = s(req.body?.country_code);
  const city_id = s(req.body?.city_id);
  const service_type = s(req.body?.service_type);

  const tax_type = s(req.body?.tax_type);
  const rate_percent_bp = i(req.body?.rate_percent_bp, null);
  const tax_inclusive = b01(req.body?.tax_inclusive, 0);
  const taxable_base = s(req.body?.taxable_base) ?? "platform_fee";

  const priority = i(req.body?.priority, 100);
  const is_active = b01(req.body?.is_active, 1);

  const starts_at = s(req.body?.starts_at);
  const ends_at = s(req.body?.ends_at);

  if (!tax_type || !TAX_TYPES.has(tax_type))
    return fail(res, 400, "Invalid tax_type");
  if (rate_percent_bp === null || rate_percent_bp < 0)
    return fail(res, 400, "Invalid rate_percent_bp");
  if (!TAXABLE_BASES.has(taxable_base))
    return fail(res, 400, "Invalid taxable_base");
  if (!starts_at) return fail(res, 400, "starts_at is required");

  try {
    const created = await withConn(async (conn) => {
      const result = await execConn(
        conn,
        `
        INSERT INTO tax_rules
        (country_code, city_id, service_type, tax_type,
         rate_percent_bp, tax_inclusive, taxable_base,
         priority, is_active, starts_at, ends_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          country_code,
          city_id,
          service_type,
          tax_type,
          rate_percent_bp,
          tax_inclusive,
          taxable_base,
          priority,
          is_active,
          starts_at,
          ends_at,
        ]
      );

      const id = result.insertId;
      const rows = await qConn(
        conn,
        `SELECT ${SELECT_FIELDS} FROM tax_rules WHERE tax_rule_id = ?`,
        [id]
      );
      return rows[0];
    });

    return ok(res, created);
  } catch (e) {
    console.error("[createTaxRule]", e);
    return fail(res, 500, "Database error");
  }
}

/** PUT /tax-rules/:id */
export async function updateTaxRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const updated = await withConn(async (conn) => {
      const rows = await qConn(
        conn,
        `SELECT ${SELECT_FIELDS} FROM tax_rules WHERE tax_rule_id = ?`,
        [id]
      );
      const existing = rows[0];
      if (!existing) return null;

      const next = {
        country_code:
          req.body?.country_code !== undefined
            ? s(req.body.country_code)
            : existing.country_code,
        city_id:
          req.body?.city_id !== undefined
            ? s(req.body.city_id)
            : existing.city_id,
        service_type:
          req.body?.service_type !== undefined
            ? s(req.body.service_type)
            : existing.service_type,

        tax_type:
          req.body?.tax_type !== undefined
            ? s(req.body.tax_type)
            : existing.tax_type,
        rate_percent_bp:
          req.body?.rate_percent_bp !== undefined
            ? i(req.body.rate_percent_bp, null)
            : existing.rate_percent_bp,
        tax_inclusive:
          req.body?.tax_inclusive !== undefined
            ? b01(req.body.tax_inclusive, 0)
            : existing.tax_inclusive,
        taxable_base:
          req.body?.taxable_base !== undefined
            ? s(req.body.taxable_base)
            : existing.taxable_base,

        priority:
          req.body?.priority !== undefined
            ? i(req.body.priority, 100)
            : existing.priority,
        is_active:
          req.body?.is_active !== undefined
            ? b01(req.body.is_active, 1)
            : existing.is_active,

        starts_at:
          req.body?.starts_at !== undefined
            ? s(req.body.starts_at)
            : existing.starts_at,
        ends_at:
          req.body?.ends_at !== undefined
            ? s(req.body.ends_at)
            : existing.ends_at,
      };

      if (!next.tax_type || !TAX_TYPES.has(next.tax_type))
        throw new Error("Invalid tax_type");
      if (next.rate_percent_bp === null || next.rate_percent_bp < 0)
        throw new Error("Invalid rate_percent_bp");
      if (!next.taxable_base || !TAXABLE_BASES.has(next.taxable_base))
        throw new Error("Invalid taxable_base");
      if (!next.starts_at) throw new Error("starts_at is required");

      await execConn(
        conn,
        `
        UPDATE tax_rules SET
          country_code=?,
          city_id=?,
          service_type=?,
          tax_type=?,
          rate_percent_bp=?,
          tax_inclusive=?,
          taxable_base=?,
          priority=?,
          is_active=?,
          starts_at=?,
          ends_at=?
        WHERE tax_rule_id=?
        `,
        [
          next.country_code,
          next.city_id,
          next.service_type,
          next.tax_type,
          next.rate_percent_bp,
          next.tax_inclusive,
          next.taxable_base,
          next.priority,
          next.is_active,
          next.starts_at,
          next.ends_at,
          id,
        ]
      );

      const after = await qConn(
        conn,
        `SELECT ${SELECT_FIELDS} FROM tax_rules WHERE tax_rule_id = ?`,
        [id]
      );
      return after[0];
    });

    if (!updated) return fail(res, 404, "Tax rule not found");
    return ok(res, updated);
  } catch (e) {
    console.error("[updateTaxRule]", e);
    const msg = String(e?.message || "");
    if (msg.startsWith("Invalid") || msg.includes("required"))
      return fail(res, 400, msg);
    return fail(res, 500, "Database error");
  }
}

/** DELETE /tax-rules/:id */
export async function deleteTaxRule(req, res) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return fail(res, 400, "Invalid id");

  try {
    const deleted = await withConn(async (conn) => {
      const rows = await qConn(
        conn,
        `SELECT tax_rule_id FROM tax_rules WHERE tax_rule_id = ?`,
        [id]
      );
      if (!rows[0]) return false;
      await execConn(conn, `DELETE FROM tax_rules WHERE tax_rule_id = ?`, [id]);
      return true;
    });

    if (!deleted) return fail(res, 404, "Tax rule not found");
    return ok(res, true, { message: "Deleted" });
  } catch (e) {
    console.error("[deleteTaxRule]", e);
    return fail(res, 500, "Database error");
  }
}
