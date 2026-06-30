import express from "express";
import { getPushTokensByDriverIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

/* ========= Reuse your existing env + tables ========= */
const WALLET_TBL = "wallet_transactions";
const WALLETS_TBL = "wallets";
const DE_TBL = "driver_earnings";
const PBE_TBL = "ride_booking_earnings";
const RIDES_TBL = "rides";
const RBOOK_TBL = "ride_bookings";
const RTIPS_TBL = "ride_tips"; // ✅ NEW: ride_tips table

/* External ID service used in your driver.js */
const WALLET_IDS_ENDPOINT = (
  process.env.WALLET_IDS_ENDPOINT || "https://backend.tabdhey.bt/wallet/ids/both"
).trim();

/* ========= Socket room helpers (match your driver.js) ========= */
const driverRoom = (driverId) => `driver:${driverId}`;
const passengerRoom = (passengerId) => `passenger:${passengerId}`;
const rideRoom = (rideId) => `ride:${rideId}`;

/* ========= Small utils ========= */
const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const rand = () => Math.random().toString(36).slice(2);
const genTxnId = () => `TNX${Date.now()}${rand().toUpperCase()}`;
const genJournal = () => `JRN${rand().toUpperCase()}${rand().toUpperCase()}`;

async function fetchIdsForJournal() {
  try {
    const res = await fetch(WALLET_IDS_ENDPOINT, { method: "POST" });
    if (!res.ok) throw new Error("ids endpoint not ok");
    const json = await res.json();
    const ids = json?.data?.transaction_ids;
    const jr = json?.data?.journal_code;
    if (Array.isArray(ids) && ids.length >= 2 && jr) {
      return { journal: String(jr), tx1: String(ids[0]), tx2: String(ids[1]) };
    }
  } catch {}
  return { journal: genJournal(), tx1: genTxnId(), tx2: genTxnId() };
}

/* ========= Idempotency (generic) =========
   CREATE TABLE IF NOT EXISTS idempotency_keys (
     idem_key     VARCHAR(255) PRIMARY KEY,
     purpose      VARCHAR(64) NOT NULL,
     ride_id      BIGINT UNSIGNED NULL,
     booking_id   BIGINT UNSIGNED NULL,
     passenger_id BIGINT UNSIGNED NULL,
     amount_cents INT UNSIGNED NOT NULL,
     journal_code VARCHAR(64) NULL,
     created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
*/
async function ensureIdem(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      idem_key     VARCHAR(255) PRIMARY KEY,
      purpose      VARCHAR(64) NOT NULL,
      ride_id      BIGINT UNSIGNED NULL,
      booking_id   BIGINT UNSIGNED NULL,
      passenger_id BIGINT UNSIGNED NULL,
      amount_cents INT UNSIGNED NOT NULL,
      journal_code VARCHAR(64) NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/* ========= Wallet helpers (use wallets.amount; no ledger recompute) ========= */
async function lockWalletRow(conn, wallet_id) {
  const [rows] = await conn.query(
    `SELECT wallet_id, user_id, amount FROM ${WALLETS_TBL} WHERE wallet_id=? FOR UPDATE`,
    [wallet_id]
  );
  return rows?.[0] || null;
}

async function getDriverUserAndWallet(conn, driverId) {
  const [[row]] = await conn.query(
    `SELECT d.user_id FROM drivers d WHERE d.driver_id=? LIMIT 1`,
    [driverId]
  );
  const user_id = row?.user_id ? Number(row.user_id) : null;
  if (!user_id) return { user_id: null, wallet_id: null };
  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id=? LIMIT 1`,
    [user_id]
  );
  return { user_id, wallet_id: w?.wallet_id || null };
}

async function getPassengerWalletByUser(conn, passengerUserId) {
  const [[w]] = await conn.query(
    `SELECT wallet_id FROM ${WALLETS_TBL} WHERE user_id=? LIMIT 1`,
    [passengerUserId]
  );
  return w?.wallet_id || null;
}

/* ========= The core transfer used for TIP =========
   Debits passenger by amount, credits driver by same amount.
*/
async function tipTransfer(conn, { from_wallet, to_wallet, amount_nu, meta }) {
  if (!(Number(amount_nu) > 0)) return { ok: false, reason: "zero_amount" };
  if (!from_wallet || !to_wallet) return { ok: false, reason: "bad_wallet" };

  const fromRow = await lockWalletRow(conn, from_wallet);
  const toRow = await lockWalletRow(conn, to_wallet);
  if (!fromRow || !toRow) {
    return {
      ok: false,
      reason: "wallet_not_found",
      missing: { from: !fromRow, to: !toRow },
    };
  }

  const amt = Number(amount_nu);
  if (Number(fromRow.amount) < amt) {
    return {
      ok: false,
      reason: "insufficient_funds",
      need: amt,
      have: Number(fromRow.amount),
    };
  }

  // Update balances
  await conn.execute(
    `UPDATE ${WALLETS_TBL} SET amount = amount - ? WHERE wallet_id=?`,
    [amt, from_wallet]
  );
  await conn.execute(
    `UPDATE ${WALLETS_TBL} SET amount = amount + ? WHERE wallet_id=?`,
    [amt, to_wallet]
  );

  // Journal rows (same journal_code)
  const ids = await fetchIdsForJournal();
  const created_at = nowIso();
  const noteJson = JSON.stringify({ reason: "TIP", ...meta });

  const rows = [
    // Passenger DR
    {
      transaction_id: ids.tx1,
      journal_code: ids.journal,
      tnx_from: from_wallet,
      tnx_to: to_wallet,
      amount: amt,
      remark: "DR",
      note: noteJson,
    },
    // Driver CR
    {
      transaction_id: ids.tx2,
      journal_code: ids.journal,
      tnx_from: from_wallet,
      tnx_to: to_wallet,
      amount: amt,
      remark: "CR",
      note: noteJson,
    },
  ];

  for (const r of rows) {
    await conn.execute(
      `INSERT INTO ${WALLET_TBL}
        (transaction_id, journal_code, tnx_from, tnx_to, amount, remark, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        r.transaction_id,
        r.journal_code,
        r.tnx_from,
        r.tnx_to,
        r.amount,
        r.remark,
        r.note,
        created_at,
        created_at,
      ]
    );
  }

  return {
    ok: true,
    journal_code: ids.journal,
    tx_dr: ids.tx1,
    tx_cr: ids.tx2,
  };
}

/* ========= Router ========= */
export default function tipsRouter(mysqlPool, io) {
  const router = express.Router();

  // POST /tips/ride/:ride_id
  // body: { passenger_user_id, amount_nu, booking_id?, idem_key?, currency? }
  router.post("/ride/:ride_id", async (req, res) => {
    const ride_id = Number(req.params.ride_id);
    const {
      passenger_user_id,
      amount_nu,
      booking_id: rawBk,
      idem_key, // body key
      currency = "BTN",
    } = req.body || {};

    // also support Idempotency-Key header
    const headerIdem = req.get("Idempotency-Key");
    const idemKey =
      (idem_key || headerIdem || "").toString().trim().slice(0, 255) || null;

    if (
      !Number.isFinite(ride_id) ||
      !(Number(amount_nu) > 0) ||
      !passenger_user_id
    ) {
      return res.status(400).json({
        success: false,
        message: "ride_id, passenger_user_id, amount_nu required",
      });
    }
    const booking_id = rawBk != null ? Number(rawBk) : null;

    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();

      const tip_cents = Math.round(Number(amount_nu) * 100);

      // Idempotency
      await ensureIdem(conn);
      if (idemKey) {
        try {
          await conn.execute(
            `INSERT INTO idempotency_keys (idem_key, purpose, ride_id, booking_id, passenger_id, amount_cents)
             VALUES (?,?,?,?,?,?)`,
            [idemKey, "TIP", ride_id, booking_id, passenger_user_id, tip_cents]
          );
        } catch (e) {
          // duplicate key -> already processed
          const [[ex]] = await conn.query(
            `SELECT journal_code FROM idempotency_keys WHERE idem_key=? LIMIT 1`,
            [idemKey]
          );

          // try to fetch existing ride_tips row too (if any)
          const [[tipRow]] = await conn.query(
            `SELECT tip_id, ride_id, driver_id, passenger_id, booking_id,
                    amount_cents, currency, status, created_at, updated_at
               FROM ${RTIPS_TBL}
              WHERE idempotency_key = ?
              LIMIT 1`,
            [idemKey]
          );

          await conn.commit();
          return res.json({
            success: true,
            idempotent: true,
            journal_code: ex?.journal_code || null,
            tip: tipRow
              ? {
                  tip_id: Number(tipRow.tip_id),
                  ride_id: Number(tipRow.ride_id),
                  driver_id: Number(tipRow.driver_id),
                  passenger_id: Number(tipRow.passenger_id),
                  booking_id: tipRow.booking_id
                    ? Number(tipRow.booking_id)
                    : null,
                  amount_nu: Number(tipRow.amount_cents) / 100,
                  amount_cents: Number(tipRow.amount_cents),
                  currency: tipRow.currency,
                  status: tipRow.status,
                  created_at: tipRow.created_at,
                  updated_at: tipRow.updated_at,
                }
              : null,
          });
        }
      }

      // Read ride (lock minimally)
      const [[ride]] = await conn.query(
        `SELECT ride_id, driver_id, passenger_id, trip_type, status, currency
           FROM ${RIDES_TBL}
          WHERE ride_id = ?
          FOR UPDATE`,
        [ride_id]
      );
      if (!ride) {
        await conn.rollback();
        return res
          .status(404)
          .json({ success: false, message: "Ride not found" });
      }
      const driver_id = Number(ride.driver_id || 0);
      const passenger_id = Number(ride.passenger_id || 0);
      if (!driver_id) {
        await conn.rollback();
        return res
          .status(400)
          .json({ success: false, message: "Ride has no driver assigned" });
      }
      if (!passenger_id) {
        await conn.rollback();
        return res
          .status(400)
          .json({ success: false, message: "Ride has no passenger attached" });
      }

      // Validate booking if provided
      if (booking_id) {
        const [[bk]] = await conn.query(
          `SELECT booking_id, passenger_id FROM ${RBOOK_TBL} WHERE booking_id=? AND ride_id=? LIMIT 1`,
          [booking_id, ride_id]
        );
        if (!bk) {
          await conn.rollback();
          return res.status(404).json({
            success: false,
            message: "Booking not found for this ride",
          });
        }
      }

      // Wallets
      const { wallet_id: driver_wallet } = await getDriverUserAndWallet(
        conn,
        driver_id
      );
      const passenger_wallet = await getPassengerWalletByUser(
        conn,
        passenger_user_id
      );
      if (!driver_wallet || !passenger_wallet) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Missing wallet(s) for driver or passenger",
        });
      }

      // Transfer
      const transfer = await tipTransfer(conn, {
        from_wallet: passenger_wallet,
        to_wallet: driver_wallet,
        amount_nu: Number(amount_nu),
        meta: { ride_id, booking_id, driver_id, passenger_id },
      });
      if (!transfer.ok) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: transfer.reason || "transfer_failed",
          transfer,
        });
      }

      // Accrue in earnings (cents)
      if (booking_id) {
        await conn.execute(
          `INSERT INTO ${PBE_TBL}
             (booking_id, driver_id, base_cents, time_cents, tips_cents, platform_fee_cents, tax_cents, currency, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             tips_cents = tips_cents + VALUES(tips_cents),
             updated_at = NOW()`,
          [
            booking_id,
            driver_id,
            0,
            0,
            tip_cents,
            0,
            0,
            currency || ride.currency || "BTN",
          ]
        );
      } else {
        await conn.execute(
          `INSERT INTO ${DE_TBL}
             (ride_id, driver_id, base_fare_cents, time_cents, tips_cents, currency, created_at, updated_at)
           VALUES (?,?,?,?,?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             tips_cents = tips_cents + VALUES(tips_cents),
             updated_at = NOW()`,
          [
            ride_id,
            driver_id,
            0,
            0,
            tip_cents,
            currency || ride.currency || "BTN",
          ]
        );
      }

      // Save journal_code on idem row (if used)
      if (idemKey) {
        await conn.execute(
          `UPDATE idempotency_keys SET journal_code=? WHERE idem_key=?`,
          [transfer.journal_code || null, idemKey]
        );
      }

      // ✅ Insert into ride_tips table
      const tipCurrency = (currency || ride.currency || "BTN")
        .toUpperCase()
        .slice(0, 3);

      const [tipRes] = await conn.execute(
        `INSERT INTO ${RTIPS_TBL}
           (ride_id, driver_id, passenger_id, booking_id,
            amount_cents, currency, idempotency_key, status)
         VALUES (?,?,?,?,?,?,?, 'captured')`,
        [
          ride_id,
          driver_id,
          passenger_id,
          booking_id,
          tip_cents,
          tipCurrency,
          idemKey ? idemKey.slice(0, 64) : null,
        ]
      );
      const tip_id = tipRes.insertId;

      await conn.commit();

      // Push to driver: tip received
      getPushTokensByDriverIds([driver_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "You Got a Tip!",
            body: `You received a Nu ${Number(amount_nu).toFixed(2)} tip. Thank you!`,
            data: { type: "tip_received", ride_id: String(ride_id), amount_nu: Number(amount_nu) },
          }).catch(() => {});
        }
      }).catch(() => {});

      // Socket notifies (best-effort)
      try {
        io.to(rideRoom(String(ride_id))).emit("tipAdded", {
          ride_id: String(ride_id),
          driver_id: String(driver_id),
          passenger_id: String(passenger_id),
          booking_id: booking_id ? String(booking_id) : null,
          amount_nu: Number(amount_nu),
          journal_code: transfer.journal_code,
          tip_id,
        });
        io.to(driverRoom(String(driver_id))).emit("tipAdded", {
          ride_id: String(ride_id),
          amount_nu: Number(amount_nu),
          journal_code: transfer.journal_code,
          tip_id,
        });
        io.to(passengerRoom(String(passenger_user_id))).emit("tipAdded", {
          ride_id: String(ride_id),
          amount_nu: Number(amount_nu),
          journal_code: transfer.journal_code,
          tip_id,
        });
      } catch {}

      return res.json({
        success: true,
        data: {
          tip_id,
          ride_id,
          driver_id,
          passenger_id,
          booking_id,
          amount_nu: Number(amount_nu),
          amount_cents: tip_cents,
          currency: tipCurrency,
          journal_code: transfer.journal_code,
          transactions: {
            passenger_dr: transfer.tx_dr,
            driver_cr: transfer.tx_cr,
          },
        },
      });
    } catch (e) {
      try {
        await conn.rollback();
      } catch {}
      console.error("[tips] error:", e?.message || e);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      try {
        conn.release();
      } catch {}
    }
  });

  return router;
}
