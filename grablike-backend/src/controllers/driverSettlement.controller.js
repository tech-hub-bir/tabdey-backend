// src/controllers/driverSettlement.controller.js
import { mysqlPool } from "../db/mysql.js"; // adjust if needed
import crypto from "crypto";

// ✅ Reuse your existing wallet engine (same one used in driverCompleteTrip)
// Adjust paths to your project
import { walletTransfer } from "../services/wallet/walletTransfer.js";
import { getDriverUserAndWallet } from "../services/wallet/walletHelpers.js";
import { resolveUserIdFromDriverId } from "../utils/resolveDriverId.js";

/* ---------------- helpers ---------------- */
const clampInt = (v, def, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const x = Math.trunc(n);
  return Math.max(min, Math.min(max, x));
};

const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(String(s));
  return Number.isFinite(d.getTime()) ? d : null;
};

const toCents = ({ amount_cents, amount_nu }) => {
  if (Number.isFinite(Number(amount_cents))) return Math.trunc(Number(amount_cents));
  if (Number.isFinite(Number(amount_nu))) return Math.round(Number(amount_nu) * 100);
  return null;
};

const centsToNuFixed = (cents) => (Number(cents || 0) / 100).toFixed(2);
const centsToNuNum = (cents) => Number((Number(cents || 0) / 100).toFixed(2));

const genId = (prefix) =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

/**
 * Idempotent posting:
 * - Upserts ledger rows for (party_type, party_id, source_type, source_id, entry_type)
 * - Updates balance by delta only
 */
async function postSettlementLines(
  conn,
  { party_type, party_id, source_type, source_id, currency = "BTN", lines }
) {
  const cleanLines = (Array.isArray(lines) ? lines : [])
    .map((l) => ({
      entry_type: String(l.entry_type || "").trim(),
      amount_cents: Number(l.amount_cents || 0),
      note: l.note ? String(l.note).slice(0, 255) : null,
    }))
    .filter((l) => l.entry_type && Number.isFinite(l.amount_cents));

  if (!cleanLines.length) return { ok: true, delta_cents: 0 };

  // lock existing rows for safe delta calc
  const [existing] = await conn.query(
    `
    SELECT entry_type, amount_cents
    FROM settlement_ledger
    WHERE party_type = ? AND party_id = ?
      AND source_type = ? AND source_id = ?
      AND entry_type IN (${cleanLines.map(() => "?").join(",")})
    FOR UPDATE
    `,
    [party_type, party_id, source_type, source_id, ...cleanLines.map((l) => l.entry_type)]
  );

  const oldMap = new Map();
  for (const r of existing) oldMap.set(String(r.entry_type), Number(r.amount_cents || 0));

  const oldSum = cleanLines.reduce((s, l) => s + (oldMap.get(l.entry_type) || 0), 0);
  const newSum = cleanLines.reduce((s, l) => s + l.amount_cents, 0);
  const delta = newSum - oldSum;

  for (const l of cleanLines) {
    await conn.query(
      `
      INSERT INTO settlement_ledger
        (party_type, party_id, source_type, source_id, entry_type, amount_cents, currency, note)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        amount_cents = VALUES(amount_cents),
        currency     = VALUES(currency),
        note         = VALUES(note)
      `,
      [party_type, party_id, source_type, source_id, l.entry_type, l.amount_cents, currency, l.note]
    );
  }

  if (delta !== 0) {
    await conn.query(
      `
      INSERT INTO settlement_accounts (party_type, party_id, balance_cents, currency)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        balance_cents = balance_cents + VALUES(balance_cents),
        currency      = VALUES(currency)
      `,
      [party_type, party_id, delta, currency]
    );
  }

  return { ok: true, delta_cents: delta };
}

/* ---------------- platform wallet helper ---------------- */
async function getPlatformWalletId(conn) {
  // 1) env override (recommended)
  const envId = process.env.PLATFORM_WALLET_ID || "NET000001";
  if (envId && String(envId).trim()) return String(envId).trim();

  // 2) fallback DB lookup (ADJUST this WHERE to match your schema)
  // Examples you might have:
  // - wallets.wallet_type = 'PLATFORM'
  // - wallets.owner_type = 'PLATFORM'
  // - wallets.user_id = 0
  const [[row]] = await conn.query(
    `
    SELECT wallet_id
    FROM wallets
    WHERE wallet_type='PLATFORM'
       OR owner_type='PLATFORM'
       OR user_id=0
    ORDER BY created_at ASC
    LIMIT 1
    `
  );

  if (!row?.wallet_id) {
    throw new Error("Platform wallet not configured. Set PLATFORM_WALLET_ID in .env");
  }
  return String(row.wallet_id);
}

/* ---------------- GET balance ---------------- */
export async function getDriverSettlementBalance(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid driver id" });
  }

  let conn;
  try {
    conn = await mysqlPool.getConnection();

    const [[row]] = await conn.query(
      `
      SELECT party_type, party_id, balance_cents, currency, updated_at
      FROM settlement_accounts
      WHERE party_type='DRIVER' AND party_id=?
      LIMIT 1
      `,
      [driverId]
    );

    const balance_cents = Number(row?.balance_cents || 0);
    const currency = row?.currency || "BTN";

    return res.json({
      ok: true,
      data: {
        driver_id: driverId,
        balance_cents,
        balance_nu: centsToNuNum(balance_cents),
        currency,
        updated_at: row?.updated_at || null,
      },
    });
  } catch (e) {
    console.error("[getDriverSettlementBalance]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* ---------------- GET ledger ---------------- */
export async function getDriverSettlementLedger(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid driver id" });
  }

  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 1_000_000);
  const fromDate = parseDate(req.query.from);
  const toDate = parseDate(req.query.to);

  let conn;
  try {
    conn = await mysqlPool.getConnection();

    const [[bal]] = await conn.query(
      `
      SELECT balance_cents, currency, updated_at
      FROM settlement_accounts
      WHERE party_type='DRIVER' AND party_id=?
      LIMIT 1
      `,
      [driverId]
    );

    const current_balance_cents = Number(bal?.balance_cents || 0);
    const currency = bal?.currency || "BTN";

    const where = [`party_type='DRIVER'`, `party_id=?`];
    const params = [driverId];

    if (fromDate) {
      where.push(`created_at >= ?`);
      params.push(fromDate);
    }
    if (toDate) {
      where.push(`created_at <= ?`);
      params.push(toDate);
    }

    const [[cnt]] = await conn.query(
      `SELECT COUNT(*) AS total FROM settlement_ledger WHERE ${where.join(" AND ")}`,
      params
    );

    const [rows] = await conn.query(
      `
      SELECT
        entry_id, source_type, source_id, entry_type,
        amount_cents, currency, note, created_at
      FROM settlement_ledger
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      meta: {
        driver_id: driverId,
        currency,
        current_balance_cents,
        current_balance_nu: centsToNuNum(current_balance_cents),
        total: Number(cnt?.total || 0),
        limit,
        offset,
        from: fromDate ? fromDate.toISOString() : null,
        to: toDate ? toDate.toISOString() : null,
      },
      data: rows.map((r) => {
        const amt = Number(r.amount_cents || 0);
        return {
          entry_id: r.entry_id,
          source_type: r.source_type,
          source_id: r.source_id,
          entry_type: r.entry_type,
          amount_cents: amt,
          amount_nu: centsToNuNum(amt),
          currency: r.currency || currency,
          note: r.note || null,
          created_at: r.created_at,
        };
      }),
    });
  } catch (e) {
    console.error("[getDriverSettlementLedger]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* ---------------- POST pay ----------------
   ✅ UPDATED:
   - If method=WALLET => deduct from driver wallet and credit platform wallet
   - Pays exact DUE if amount not provided
   - Caps payment at due
   - Idempotent by (source_type='PAYMENT', source_id, entry_type)
   Body:
   {
     amount_cents?: number,        // optional
     amount_nu?: number,           // optional
     method?: "MANUAL" | "WALLET", // default WALLET
     reference?: string,
     idempotency_key?: string,
     note?: string
   }
*/
export async function postDriverSettlementPay(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid driver id" });
  }

  const method = String(req.body?.method || "WALLET").toUpperCase();
  if (method !== "WALLET" && method !== "MANUAL") {
    return res.status(400).json({ ok: false, error: "method must be WALLET or MANUAL" });
  }

  const currency = "BTN";
  const note = req.body?.note ? String(req.body.note).slice(0, 200) : null;
  const reference = req.body?.reference ? String(req.body.reference).slice(0, 120) : null;

  // ✅ idempotency key for safe retry
  const source_id = String(req.body?.idempotency_key || reference || genId("PAY"));

  const entry_type = method === "WALLET" ? "WALLET_PAYMENT" : "MANUAL_PAYMENT";

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    // ✅ lock settlement balance (DUE)
    const [[acct]] = await conn.query(
      `
      SELECT balance_cents, currency, updated_at
      FROM settlement_accounts
      WHERE party_type='DRIVER' AND party_id=?
      FOR UPDATE
      `,
      [driverId]
    );

    const dueCents = Number(acct?.balance_cents || 0);
    if (dueCents <= 0) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "No settlement due" });
    }

    // ✅ amount is optional; if missing => pay full due
    let payCents = toCents(req.body || {});
    if (payCents == null) payCents = dueCents;

    if (!Number.isFinite(payCents) || payCents <= 0) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "amount_cents/amount_nu must be > 0" });
    }

    // ✅ never allow paying more than due
    payCents = Math.min(Math.abs(Math.trunc(payCents)), dueCents);

    // ✅ idempotency guard: if this payment already exists, return success (do NOT walletTransfer again)
    const [[existingPay]] = await conn.query(
      `
      SELECT amount_cents, note
      FROM settlement_ledger
      WHERE party_type='DRIVER' AND party_id=?
        AND source_type='PAYMENT' AND source_id=?
        AND entry_type=?
      LIMIT 1
      FOR UPDATE
      `,
      [driverId, source_id, entry_type]
    );

    if (existingPay) {
      // if same amount, treat as already processed
      const oldAmt = Number(existingPay.amount_cents || 0);
      if (oldAmt === -Math.abs(payCents)) {
        const [[after]] = await conn.query(
          `
          SELECT balance_cents, currency, updated_at
          FROM settlement_accounts
          WHERE party_type='DRIVER' AND party_id=?
          LIMIT 1
          `,
          [driverId]
        );

        await conn.commit();
        return res.json({
          ok: true,
          info: "already_processed",
          data: {
            driver_id: driverId,
            paid_cents: Math.abs(payCents),
            paid_nu: centsToNuNum(Math.abs(payCents)),
            method,
            source_id,
            settlement: {
              balance_cents: Number(after?.balance_cents || 0),
              balance_nu: centsToNuNum(Number(after?.balance_cents || 0)),
              currency: after?.currency || "BTN",
              updated_at: after?.updated_at || null,
            },
          },
        });
      }

      // conflict: same source_id but different amount
      await conn.rollback();
      return res.status(409).json({
        ok: false,
        error: "idempotency_key already used with a different amount",
        existing_amount_cents: Number(existingPay.amount_cents || 0),
        requested_amount_cents: -Math.abs(payCents),
      });
    }

    // ✅ do wallet transfer if WALLET
    let walletResult = { ok: false, reason: "not_wallet" };

    if (method === "WALLET") {
      const { wallet_id: driver_wallet } = await getDriverUserAndWallet(conn, driverId);
      if (!driver_wallet) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "Driver wallet missing" });
      }

      const platform_wallet = await getPlatformWalletId(conn);

      const amtNu = centsToNuFixed(payCents);

      walletResult = await walletTransfer(conn, {
        from_wallet: driver_wallet,
        to_wallet: platform_wallet,

        // ✅ keep your existing walletTransfer signature the same
        passenger_debit_nu: amtNu, // debit from driver wallet
        driver_credit_nu: amtNu,   // credit to platform wallet

        reason: "DRIVER_SETTLEMENT",
        meta: {
          driver_id: driverId,
          settlement_source_id: source_id,
          reference,
          note,
        },
      });

      if (!walletResult?.ok) {
        await conn.rollback();
        return res.status(400).json({
          ok: false,
          error: walletResult?.reason || "Wallet payment failed",
          wallet: walletResult,
        });
      }
    } else {
      walletResult = { ok: true, mode: "MANUAL", reference };
    }

    // ✅ Payment reduces debt → negative amount
    const noteOut =
      (reference ? `${reference}` : "Settlement payment") +
      (note ? ` | ${note}` : "") +
      (walletResult?.tx_id ? ` | tx=${walletResult.tx_id}` : "") +
      (walletResult?.transaction_id ? ` | tx=${walletResult.transaction_id}` : "");

    const result = await postSettlementLines(conn, {
      party_type: "DRIVER",
      party_id: driverId,
      source_type: "PAYMENT",
      source_id,
      currency,
      lines: [
        {
          entry_type,
          amount_cents: -Math.abs(payCents),
          note: noteOut.slice(0, 255),
        },
      ],
    });

    const [[after]] = await conn.query(
      `
      SELECT balance_cents, currency, updated_at
      FROM settlement_accounts
      WHERE party_type='DRIVER' AND party_id=?
      LIMIT 1
      `,
      [driverId]
    );

    await conn.commit();

    return res.json({
      ok: true,
      data: {
        driver_id: driverId,
        paid_cents: Math.abs(payCents),
        paid_nu: centsToNuNum(Math.abs(payCents)),
        method,
        posted: {
          source_type: "PAYMENT",
          source_id,
          entry_type,
          amount_cents: -Math.abs(payCents),
        },
        delta_cents: result.delta_cents,
        settlement: {
          balance_cents: Number(after?.balance_cents || 0),
          balance_nu: centsToNuNum(Number(after?.balance_cents || 0)),
          currency: after?.currency || "BTN",
          updated_at: after?.updated_at || null,
        },
        wallet: walletResult, // ✅ contains tx details from walletTransfer()
      },
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[postDriverSettlementPay]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* ---------------- POST adjust ----------------
   Body:
   {
     amount_cents OR amount_nu,   // can be + or -
     reference?: string,
     idempotency_key?: string,
     note?: string
   }
*/
export async function postDriverSettlementAdjust(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid driver id" });
  }

  const cents = toCents(req.body || {});
  if (cents == null || !Number.isFinite(cents) || cents === 0) {
    return res.status(400).json({ ok: false, error: "amount_cents/amount_nu must be non-zero" });
  }

  const currency = "BTN";
  const note = req.body?.note || null;
  const reference = req.body?.reference || null;
  const source_id = String(req.body?.idempotency_key || req.body?.reference || genId("ADJ"));

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const result = await postSettlementLines(conn, {
      party_type: "DRIVER",
      party_id: driverId,
      source_type: "ADJUSTMENT",
      source_id,
      currency,
      lines: [
        {
          entry_type: "ADJUSTMENT",
          amount_cents: Math.trunc(cents), // + or -
          note: reference ? `${reference}${note ? ` | ${note}` : ""}` : note,
        },
      ],
    });

    await conn.commit();

    return res.json({
      ok: true,
      data: {
        driver_id: driverId,
        posted: {
          source_type: "ADJUSTMENT",
          source_id,
          entry_type: "ADJUSTMENT",
          amount_cents: Math.trunc(cents),
        },
        delta_cents: result.delta_cents,
      },
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[postDriverSettlementAdjust]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* ---------------- POST reverse ----------------
   Body option A:
   { entry_id: 91, reference?: "...", note?: "..." }

   Body option B:
   { source_type: "RIDE", source_id: "701", entry_type: "PLATFORM_FEE_DUE", reference?: "...", note?: "..." }
*/
export async function postDriverSettlementReverse(req, res) {
  const driverId = Number(req.params.id);
  if (!Number.isFinite(driverId) || driverId <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid driver id" });
  }

  const entry_id = req.body?.entry_id != null ? Number(req.body.entry_id) : null;
  const source_type = req.body?.source_type
    ? String(req.body.source_type).toUpperCase()
    : null;
  const source_id = req.body?.source_id ? String(req.body.source_id) : null;
  const entry_type = req.body?.entry_type ? String(req.body.entry_type).toUpperCase() : null;

  if (!entry_id && !(source_type && source_id && entry_type)) {
    return res.status(400).json({
      ok: false,
      error: "Provide entry_id OR (source_type, source_id, entry_type)",
    });
  }

  const reference = req.body?.reference || null;
  const note = req.body?.note || null;
  const currency = "BTN";

  let conn;
  try {
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    let target;

    if (entry_id) {
      const [[row]] = await conn.query(
        `
        SELECT entry_id, source_type, source_id, entry_type, amount_cents, currency
        FROM settlement_ledger
        WHERE party_type='DRIVER' AND party_id=? AND entry_id=?
        LIMIT 1
        FOR UPDATE
        `,
        [driverId, entry_id]
      );
      target = row;
    } else {
      const [[row]] = await conn.query(
        `
        SELECT entry_id, source_type, source_id, entry_type, amount_cents, currency
        FROM settlement_ledger
        WHERE party_type='DRIVER' AND party_id=?
          AND source_type=? AND source_id=? AND entry_type=?
        LIMIT 1
        FOR UPDATE
        `,
        [driverId, source_type, source_id, entry_type]
      );
      target = row;
    }

    if (!target) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Target ledger entry not found" });
    }

    const revSourceId = String(reference || `REV:${target.entry_id}`);
    const reverseAmount = -Number(target.amount_cents || 0);

    const result = await postSettlementLines(conn, {
      party_type: "DRIVER",
      party_id: driverId,
      source_type: "ADJUSTMENT",
      source_id: revSourceId,
      currency: target.currency || currency,
      lines: [
        {
          entry_type: "REVERSAL",
          amount_cents: reverseAmount,
          note: `Reverse entry_id=${target.entry_id}` + (note ? ` | ${note}` : ""),
        },
      ],
    });

    await conn.commit();

    return res.json({
      ok: true,
      data: {
        driver_id: driverId,
        reversed: {
          target_entry_id: target.entry_id,
          target_entry_type: target.entry_type,
          target_amount_cents: Number(target.amount_cents || 0),
          reversal_source_id: revSourceId,
          reversal_amount_cents: reverseAmount,
        },
        delta_cents: result.delta_cents,
      },
    });
  } catch (e) {
    try {
      await conn?.rollback();
    } catch {}
    console.error("[postDriverSettlementReverse]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

/* ---------------- GET all due settlements (ledger) ---------------- */
export async function getAllDueSettlements(req, res) {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 10_000_000);

  // default: show only due settlements unless explicitly turned off
  const only_due_raw = req.query.only_due;
  const only_due =
    only_due_raw == null
      ? true
      : !["0", "false", "no"].includes(String(only_due_raw).toLowerCase());

  const party_type = req.query.party_type
    ? String(req.query.party_type).toUpperCase()
    : null;

  const party_id =
    req.query.party_id != null && String(req.query.party_id).trim() !== ""
      ? Number(req.query.party_id)
      : null;

  const source_type = req.query.source_type
    ? String(req.query.source_type).toUpperCase()
    : null;

  const entry_type = req.query.entry_type
    ? String(req.query.entry_type).toUpperCase()
    : null;

  const fromDate = parseDate(req.query.from);
  const toDate = parseDate(req.query.to);

  let conn;
  try {
    conn = await mysqlPool.getConnection();

    const where = ["1=1"];
    const params = [];

    if (party_type) {
      where.push("party_type = ?");
      params.push(party_type);
    }
    if (Number.isFinite(party_id) && party_id > 0) {
      where.push("party_id = ?");
      params.push(party_id);
    }
    if (source_type) {
      where.push("source_type = ?");
      params.push(source_type);
    }
    if (entry_type) {
      where.push("entry_type = ?");
      params.push(entry_type);
    }
    if (fromDate) {
      where.push("created_at >= ?");
      params.push(fromDate);
    }
    if (toDate) {
      where.push("created_at <= ?");
      params.push(toDate);
    }

    // ONLY DUE: positive amounts only (fees/taxes owed)
    // If you want to be stricter: also filter entry_type IN ('PLATFORM_FEE_DUE','TAX_DUE')
    if (only_due) {
      where.push("amount_cents > 0");
      where.push("entry_type IN ('PLATFORM_FEE_DUE','TAX_DUE')");
    }

    const [[cnt]] = await conn.query(
      `SELECT COUNT(*) AS total FROM settlement_ledger WHERE ${where.join(" AND ")}`,
      params
    );

    const [rows] = await conn.query(
      `
      SELECT
        entry_id, party_type, party_id,
        source_type, source_id,
        entry_type, amount_cents, currency,
        note, created_at
      FROM settlement_ledger
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      meta: {
        total_due_settlements: Number(cnt?.total || 0),
        limit,
        offset,
        only_due,
      },
      settlements_data: rows.map((r) => {
        const amt = Number(r.amount_cents || 0);
        return {
          entry_id: r.entry_id,
          party_type: r.party_type,
          party_id: Number(r.party_id),
          source_type: r.source_type,
          source_id: r.source_id,
          entry_type: r.entry_type,
          amount_cents: amt,
          amount_nu: centsToNuNum(amt),
          currency: r.currency || "BTN",
          note: r.note || null,
          created_at: r.created_at,
        };
      }),
    });
  } catch (e) {
    console.error("[getAllSettlements]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}

// GET: due totals grouped by driver (sum of PLATFORM_FEE_DUE + TAX_DUE)
// Query:
//   ?from=2026-01-01&to=2026-01-31&limit=50&offset=0
//   ?party_id=12  (optional filter)
export async function getDueSettlementsGroupedByDriver(req, res) {
  const limit = clampInt(req.query.limit, 50, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 10_000_000);

  const party_id =
    req.query.party_id != null && String(req.query.party_id).trim() !== ""
      ? Number(req.query.party_id)
      : null;

  const fromDate = parseDate(req.query.from);
  const toDate = parseDate(req.query.to);

  let conn;
  try {
    conn = await mysqlPool.getConnection();

    const where = [
      "l.party_type = 'DRIVER'",
      "l.amount_cents > 0",
      "l.entry_type IN ('PLATFORM_FEE_DUE','TAX_DUE')",
    ];
    const params = [];

    if (Number.isFinite(party_id) && party_id > 0) {
      where.push("l.party_id = ?");
      params.push(party_id);
    }
    if (fromDate) {
      where.push("l.created_at >= ?");
      params.push(fromDate);
    }
    if (toDate) {
      where.push("l.created_at <= ?");
      params.push(toDate);
    }

    const [[cnt]] = await conn.query(
      `
      SELECT COUNT(DISTINCT l.party_id) AS total_drivers
      FROM settlement_ledger l
      WHERE ${where.join(" AND ")}
      `,
      params
    );

    const [rows] = await conn.query(
      `
      SELECT
        l.party_id AS driver_id,
        d.user_id AS user_id,
        SUM(CASE WHEN l.entry_type='PLATFORM_FEE_DUE' THEN l.amount_cents ELSE 0 END) AS platform_fee_due_cents,
        SUM(CASE WHEN l.entry_type='TAX_DUE' THEN l.amount_cents ELSE 0 END) AS tax_due_cents,
        SUM(l.amount_cents) AS total_due_cents,
        MAX(l.created_at) AS last_due_at
      FROM settlement_ledger l
      LEFT JOIN drivers d ON d.driver_id = l.party_id
      WHERE ${where.join(" AND ")}
      GROUP BY l.party_id, d.user_id
      ORDER BY total_due_cents DESC, last_due_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      meta: {
        total_drivers: Number(cnt?.total_drivers || 0),
        limit,
        offset,
        from: fromDate ? fromDate.toISOString() : null,
        to: toDate ? toDate.toISOString() : null,
      },
      data: rows.map((r) => {
        const pf = Number(r.platform_fee_due_cents || 0);
        const tax = Number(r.tax_due_cents || 0);
        const total = Number(r.total_due_cents || 0);

        return {
          user_id: r.user_id != null ? Number(r.user_id) : null,
          driver_id: Number(r.driver_id),
          platform_fee_due_cents: pf,
          platform_fee_due_nu: centsToNuNum(pf),
          tax_due_cents: tax,
          tax_due_nu: centsToNuNum(tax),
          total_due_cents: total,
          total_due_nu: centsToNuNum(total),
          last_due_at: r.last_due_at,
        };
      }),
    });
  } catch (e) {
    console.error("[getDueSettlementsGroupedByDriver]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}



/* ---------------- GET all settled settlements (ledger) ---------------- */
export async function getAllSettledSettlements(req, res) {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 10_000_000);

  const party_type = req.query.party_type
    ? String(req.query.party_type).toUpperCase()
    : null;

  const party_id =
    req.query.party_id != null && String(req.query.party_id).trim() !== ""
      ? Number(req.query.party_id)
      : null;

  const fromDate = parseDate(req.query.from);
  const toDate = parseDate(req.query.to);

  let conn;
  try {
    conn = await mysqlPool.getConnection();

    const where = [
      "1=1",
      // ✅ settled = payment entries
      "source_type = 'PAYMENT'",
      "entry_type IN ('WALLET_PAYMENT','MANUAL_PAYMENT')",
      "amount_cents < 0",
    ];
    const params = [];

    if (party_type) {
      where.push("party_type = ?");
      params.push(party_type);
    }
    if (Number.isFinite(party_id) && party_id > 0) {
      where.push("party_id = ?");
      params.push(party_id);
    }
    if (fromDate) {
      where.push("created_at >= ?");
      params.push(fromDate);
    }
    if (toDate) {
      where.push("created_at <= ?");
      params.push(toDate);
    }

    const [[cnt]] = await conn.query(
      `SELECT COUNT(*) AS total FROM settlement_ledger WHERE ${where.join(" AND ")}`,
      params
    );

    const [rows] = await conn.query(
      `
      SELECT
        entry_id, party_type, party_id,
        source_type, source_id,
        entry_type, amount_cents, currency,
        note, created_at
      FROM settlement_ledger
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      meta: {
        total_settlements: Number(cnt?.total || 0),
        limit,
        offset,
        type: "SETTLED",
        from: fromDate ? fromDate.toISOString() : null,
        to: toDate ? toDate.toISOString() : null,
      },
      settlements_data: rows.map((r) => {
        const amt = Number(r.amount_cents || 0);
        return {
          entry_id: r.entry_id,
          party_type: r.party_type,
          party_id: Number(r.party_id),
          source_type: r.source_type,
          source_id: r.source_id,
          entry_type: r.entry_type,
          amount_cents: amt,
          amount_nu: centsToNuNum(amt),
          currency: r.currency || "BTN",
          note: r.note || null,
          created_at: r.created_at,
        };
      }),
    });
  } catch (e) {
    console.error("[getAllSettledSettlements]", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  } finally {
    try {
      conn?.release();
    } catch {}
  }
}



