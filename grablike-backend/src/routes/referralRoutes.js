// src/routes/referralRoutes.js
import express from "express";
import crypto from "crypto";
import { withConn } from "../db/mysql.js";
import { sendPushToTokens } from "../services/push.js";
import { getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";

/* ── Constants ── */
const WALLETS_TBL      = "wallets";
const WALLET_TXN_TBL   = "wallet_transactions";
const REF_CODES_TBL    = "user_referral_codes";
const REFERRALS_TBL    = "referrals";
const CREDIT_AMOUNT    = 50;   // Nu. credited to both parties
const CODE_PREFIX      = "TAB";
const CODE_CHARS       = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/I/1 ambiguity

const WALLET_IDS_ENDPOINT = (
  process.env.WALLET_IDS_ENDPOINT || "https://backend.tabdhey.bt/wallet/ids/both"
).trim();

/* ── Helpers ── */
const nowIso  = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const rand    = () => Math.random().toString(36).slice(2);
const genTxId = () => `TNX${Date.now()}${rand().toUpperCase()}`;
const genJrn  = () => `JRN${rand().toUpperCase()}${rand().toUpperCase()}`;

async function fetchTxIds() {
  try {
    const res = await fetch(WALLET_IDS_ENDPOINT, { method: "POST" });
    if (!res.ok) throw new Error("ids endpoint not ok");
    const json = await res.json();
    const ids = json?.data?.transaction_ids;
    const jr  = json?.data?.journal_code;
    if (Array.isArray(ids) && ids.length >= 2 && jr) {
      return { journal: String(jr), tx1: String(ids[0]), tx2: String(ids[1]) };
    }
  } catch {}
  return { journal: genJrn(), tx1: genTxId(), tx2: genTxId() };
}

/* Generate a unique TAB-XXXXXX referral code */
function generateRawCode() {
  const bytes = crypto.randomBytes(6);
  let suffix = "";
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${CODE_PREFIX}-${suffix}`;
}

/* Get or create a referral code for the given user_id */
async function getOrCreateCode(conn, userId) {
  const [[existing]] = await conn.query(
    `SELECT code FROM ${REF_CODES_TBL} WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (existing) return existing.code;

  // Generate a unique code with collision retry
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateRawCode();
    const [[clash]] = await conn.query(
      `SELECT 1 FROM ${REF_CODES_TBL} WHERE code = ? LIMIT 1`,
      [candidate]
    );
    if (!clash) { code = candidate; break; }
  }
  if (!code) throw new Error("Could not generate unique referral code");

  await conn.execute(
    `INSERT INTO ${REF_CODES_TBL} (user_id, code) VALUES (?, ?)`,
    [userId, code]
  );
  return code;
}

/* Credit Nu. CREDIT_AMOUNT to a single user's wallet — platform grant, no debit */
async function platformCreditWallet(conn, userId, note) {
  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  if (!w?.wallet_id) return { ok: false, reason: "wallet_not_found" };

  const walletId = w.wallet_id;
  const ids      = await fetchTxIds();
  const ts       = nowIso();
  const noteStr  = JSON.stringify({ reason: "REFERRAL_CREDIT", ...note });

  await conn.execute(
    `UPDATE ${WALLETS_TBL} SET amount = amount + ? WHERE wallet_id = ?`,
    [CREDIT_AMOUNT, walletId]
  );
  // CR entry — tnx_from NULL because it is a platform grant
  await conn.execute(
    `INSERT INTO ${WALLET_TXN_TBL}
       (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'CR', ?, ?, ?)`,
    [ids.tx1, ids.journal, walletId, CREDIT_AMOUNT, noteStr, ts, ts]
  );

  return { ok: true, wallet_id: walletId, journal: ids.journal };
}

/* ─────────────────────────────────────────────────────────────
   creditReferral — called by rides.js after a trip completes.
   Finds a pending referral for this passenger, credits both
   wallets, marks the referral credited.
   Always resolves (never throws) — ride completion must not fail.
───────────────────────────────────────────────────────────── */
export async function creditReferral(conn, passengerUserId) {
  try {
    const [[ref]] = await conn.query(
      `SELECT id, referrer_id, referee_id, amount
         FROM ${REFERRALS_TBL}
        WHERE referee_id = ? AND status = 'pending'
        LIMIT 1 FOR UPDATE`,
      [passengerUserId]
    );
    if (!ref) return; // no pending referral for this user

    const note = { referral_id: ref.id, referee_id: ref.referee_id, referrer_id: ref.referrer_id };

    // Credit referee (the new user who just completed their first ride)
    await platformCreditWallet(conn, ref.referee_id, { ...note, role: "referee" });

    // Credit referrer (the friend who shared the code)
    await platformCreditWallet(conn, ref.referrer_id, { ...note, role: "referrer" });

    // Mark credited
    await conn.execute(
      `UPDATE ${REFERRALS_TBL}
          SET status = 'credited', credited_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [ref.id]
    );

    // Push notification to referrer — silent fail
    getPushTokensByUserIds([ref.referrer_id])
      .then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "You earned Nu. 50! 🎉",
            body:  "Your referred friend completed their first ride. Credits added to your wallet.",
            data:  { type: "referral_credited" },
          }).catch(() => {});
        }
      })
      .catch(() => {});
  } catch (err) {
    // Log but do not re-throw — ride completion must succeed regardless
    console.error("[creditReferral] error:", err?.message || err);
  }
}

/* ── Router ── */
export function makeReferralRouter(mysqlPool) {
  const router = express.Router();

  /* ── Ensure tables exist on startup ── */
  withConn(async (conn) => {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${REF_CODES_TBL} (
        user_id    BIGINT UNSIGNED NOT NULL,
        code       VARCHAR(32)     NOT NULL,
        created_at DATETIME        NOT NULL DEFAULT UTC_TIMESTAMP(),
        PRIMARY KEY (user_id),
        UNIQUE KEY uq_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ${REFERRALS_TBL} (
        id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        referral_code VARCHAR(32)     NOT NULL,
        referrer_id   BIGINT UNSIGNED NOT NULL,
        referee_id    BIGINT UNSIGNED NOT NULL,
        status        ENUM('pending','credited','expired') NOT NULL DEFAULT 'pending',
        amount        INT UNSIGNED    NOT NULL DEFAULT ${CREDIT_AMOUNT},
        credited_at   DATETIME        NULL,
        created_at    DATETIME        NOT NULL DEFAULT UTC_TIMESTAMP(),
        UNIQUE KEY uq_referee  (referee_id),
        KEY idx_referrer (referrer_id),
        KEY idx_code     (referral_code),
        KEY idx_status   (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }).catch((e) => console.error("[referrals] table init error:", e?.message));

  /* ────────────────────────────────────────────────────────
     GET /api/referrals/my-code?userId=123
     Returns (or generates) the caller's referral code + stats.
     Auth: requireAuth (userId also accepted as query fallback).
  ──────────────────────────────────────────────────────── */
  router.get("/my-code", async (req, res) => {
    const userId = Number(req.query.userId);
    if (!userId || !Number.isFinite(userId)) {
      return res.status(400).json({ ok: false, message: "userId query param required" });
    }
    try {
      const result = await withConn(async (conn) => {
        const code = await getOrCreateCode(conn, userId);

        // Stats: how many referrals credited / pending + total earned
        const [[stats]] = await conn.query(
          `SELECT
             COUNT(*)                                  AS invited,
             SUM(CASE WHEN status='credited' THEN amount ELSE 0 END) AS earned
           FROM ${REFERRALS_TBL}
           WHERE referrer_id = ?`,
          [userId]
        );

        return {
          code,
          stats: {
            invited: Number(stats?.invited  ?? 0),
            earned:  Number(stats?.earned   ?? 0),
          },
        };
      });

      return res.json({ ok: true, ...result });
    } catch (e) {
      console.error("[GET /referrals/my-code]", e?.message);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  /* ────────────────────────────────────────────────────────
     GET /api/referrals/history
     Returns all referrals where the caller is the referrer,
     joined with the referee's name and status.
     Auth: requireAuth
  ──────────────────────────────────────────────────────── */
  router.get("/history", async (req, res) => {
    const userId = Number(req.query.userId);
    if (!userId || !Number.isFinite(userId)) {
      return res.status(400).json({ ok: false, message: "userId query param required" });
    }
    try {
      const rows = await withConn(async (conn) => {
        const [data] = await conn.query(
          `SELECT
             r.id,
             r.status,
             r.amount,
             r.credited_at,
             r.created_at,
             u.user_name AS name
           FROM ${REFERRALS_TBL} r
           LEFT JOIN users u ON u.user_id = r.referee_id
           WHERE r.referrer_id = ?
           ORDER BY r.created_at DESC
           LIMIT 50`,
          [userId]
        );
        return data;
      });

      return res.json({ ok: true, data: rows });
    } catch (e) {
      console.error("[GET /referrals/history]", e?.message);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  /* ────────────────────────────────────────────────────────
     POST /api/referrals/apply
     Body: { referral_code: string, user_id: number }
     Called by OTP.js after successful registration.
     No auth header at this point (user not yet logged in).

     Rules:
       - Code must exist
       - Referee must not already have a referral (UNIQUE constraint)
       - Referrer cannot refer themselves
  ──────────────────────────────────────────────────────── */
  router.post("/apply", async (req, res) => {
    const { referral_code, user_id } = req.body || {};

    if (!referral_code || !user_id) {
      return res.status(400).json({ ok: false, message: "referral_code and user_id required" });
    }

    const code     = String(referral_code).trim().toUpperCase();
    const refereeId = Number(user_id);

    if (!Number.isFinite(refereeId) || refereeId <= 0) {
      return res.status(400).json({ ok: false, message: "Invalid user_id" });
    }

    try {
      const result = await withConn(async (conn) => {
        // 1. Find the referrer who owns this code
        const [[codeRow]] = await conn.query(
          `SELECT user_id FROM ${REF_CODES_TBL} WHERE code = ? LIMIT 1`,
          [code]
        );
        if (!codeRow) {
          return { status: 404, body: { ok: false, message: "Invalid referral code" } };
        }

        const referrerId = Number(codeRow.user_id);

        // 2. Prevent self-referral
        if (referrerId === refereeId) {
          return { status: 400, body: { ok: false, message: "Cannot use your own referral code" } };
        }

        // 3. Check the referee hasn't already used a code (UNIQUE KEY uq_referee)
        const [[existing]] = await conn.query(
          `SELECT id FROM ${REFERRALS_TBL} WHERE referee_id = ? LIMIT 1`,
          [refereeId]
        );
        if (existing) {
          return { status: 409, body: { ok: false, message: "Referral code already applied" } };
        }

        // 4. Insert pending referral record
        await conn.execute(
          `INSERT INTO ${REFERRALS_TBL} (referral_code, referrer_id, referee_id) VALUES (?, ?, ?)`,
          [code, referrerId, refereeId]
        );

        return { status: 200, body: { ok: true, message: "Referral applied. Credits will land after your first ride." } };
      });

      return res.status(result.status).json(result.body);
    } catch (e) {
      // Duplicate entry from race condition → treat as already applied
      if (e?.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ ok: false, message: "Referral code already applied" });
      }
      console.error("[POST /referrals/apply]", e?.message);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  });

  return router;
}
