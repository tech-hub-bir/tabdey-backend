// models/transactionHistoryModel.js
const { prisma } = require("../lib/prisma");

// TD######## only
const WALLET_RE = /^TD\d{8}$/i;

const isValidWalletId = (id) => WALLET_RE.test(String(id || "").trim());

function encodeCursor(created_at, id) {
  const ts =
    created_at instanceof Date
      ? created_at.toISOString()
      : new Date(created_at).toISOString();

  return Buffer.from(`${ts}|${String(id)}`).toString("base64");
}

function decodeCursor(cursor) {
  try {
    const [ts, idStr] = Buffer.from(String(cursor), "base64")
      .toString("utf8")
      .split("|");

    const d = new Date(ts);

    if (!Number.isFinite(d.getTime()) || !idStr) {
      return null;
    }

    return {
      ts: d,
      id: BigInt(idStr),
    };
  } catch {
    return null;
  }
}

function cleanLimit(v, fallback, max) {
  return Math.min(Math.max(Number(v) || fallback, 1), max);
}

function validDateOrNull(v) {
  if (!v) return null;

  const d = new Date(v);

  if (!Number.isFinite(d.getTime())) return null;

  return d;
}

function buildCommonWhere({ start, end, journal, q }) {
  const AND = [];

  const startDate = validDateOrNull(start);
  const endDate = validDateOrNull(end);

  if (startDate) {
    AND.push({
      created_at: {
        gte: startDate,
      },
    });
  }

  if (endDate) {
    AND.push({
      created_at: {
        lte: endDate,
      },
    });
  }

  if (journal) {
    AND.push({
      journal_code: String(journal).trim(),
    });
  }

  if (q) {
    const s = String(q).trim();

    if (s) {
      AND.push({
        OR: [
          {
            transaction_id: s,
          },
          {
            note: {
              contains: s,
            },
          },
          {
            tnx_from: s,
          },
          {
            tnx_to: s,
          },
        ],
      });
    }
  }

  return AND;
}

function buildCursorWhere(cursor) {
  if (!cursor) return null;

  const c = decodeCursor(cursor);

  if (!c) return null;

  return {
    OR: [
      {
        created_at: {
          lt: c.ts,
        },
      },
      {
        AND: [
          {
            created_at: c.ts,
          },
          {
            id: {
              lt: c.id,
            },
          },
        ],
      },
    ],
  };
}

function normalizeTxnRow(row) {
  if (!row) return row;

  return {
    ...row,
    id: typeof row.id === "bigint" ? row.id.toString() : row.id,
    amount:
      row.amount &&
      typeof row.amount === "object" &&
      typeof row.amount.toString === "function"
        ? Number(row.amount.toString())
        : Number(row.amount || 0),
  };
}

/**
 * Wallet-specific transaction matching.
 *
 * Old SQL used:
 * wt.actual_wallet_id = ?
 *
 * Prisma-safe equivalent:
 * - DR row belongs to sender wallet: remark='DR' AND tnx_from=wallet_id
 * - CR row belongs to receiver wallet: remark='CR' AND tnx_to=wallet_id
 */
function walletOwnershipWhere(wallet_id, direction = null) {
  const wid = String(wallet_id || "").trim();

  if (direction === "DR") {
    return {
      remark: "DR",
      tnx_from: wid,
    };
  }

  if (direction === "CR") {
    return {
      remark: "CR",
      tnx_to: wid,
    };
  }

  return {
    OR: [
      {
        remark: "DR",
        tnx_from: wid,
      },
      {
        remark: "CR",
        tnx_to: wid,
      },
    ],
  };
}

async function listByWallet(
  wallet_id,
  {
    limit = 50,
    cursor = null,
    start = null,
    end = null,
    direction = null,
    journal = null,
    q = null,
  } = {},
) {
  const wid = String(wallet_id || "").trim();

  if (!isValidWalletId(wid)) {
    return {
      rows: [],
      next_cursor: null,
    };
  }

  const lim = cleanLimit(limit, 50, 200);

  const AND = [
    ...buildCommonWhere({
      start,
      end,
      journal,
      q,
    }),
    walletOwnershipWhere(wid, direction),
  ];

  const cursorWhere = buildCursorWhere(cursor);

  if (cursorWhere) {
    AND.push(cursorWhere);
  }

  const rows = await prisma.wallet_transactions.findMany({
    where: {
      AND,
    },
    select: {
      id: true,
      transaction_id: true,
      journal_code: true,
      tnx_from: true,
      tnx_to: true,
      amount: true,
      remark: true,
      note: true,
      created_at: true,
    },
    orderBy: [
      {
        created_at: "desc",
      },
      {
        id: "desc",
      },
    ],
    take: lim + 1,
  });

  const normalized = rows.map(normalizeTxnRow);

  let next_cursor = null;

  if (normalized.length > lim) {
    const last = normalized[lim - 1];
    next_cursor = encodeCursor(last.created_at, last.id);
    normalized.length = lim;
  }

  return {
    rows: normalized,
    next_cursor,
  };
}

async function listByUser(user_id, opts = {}) {
  const uid = Number(user_id);

  if (!Number.isFinite(uid) || uid <= 0) {
    return {
      rows: [],
      next_cursor: null,
      wallet_id: null,
    };
  }

  const wallet = await prisma.wallets.findFirst({
    where: {
      user_id: uid,
    },
    select: {
      wallet_id: true,
    },
  });

  if (!wallet) {
    return {
      rows: [],
      next_cursor: null,
      wallet_id: null,
    };
  }

  const wallet_id = wallet.wallet_id;

  if (!isValidWalletId(wallet_id)) {
    return {
      rows: [],
      next_cursor: null,
      wallet_id,
    };
  }

  const result = await listByWallet(wallet_id, opts);

  return {
    ...result,
    wallet_id,
  };
}

async function listAll({
  limit = 100,
  cursor = null,
  start = null,
  end = null,
  journal = null,
  q = null,
} = {}) {
  const lim = cleanLimit(limit, 100, 300);

  const AND = buildCommonWhere({
    start,
    end,
    journal,
    q,
  });

  const cursorWhere = buildCursorWhere(cursor);

  if (cursorWhere) {
    AND.push(cursorWhere);
  }

  const rows = await prisma.wallet_transactions.findMany({
    where: AND.length
      ? {
          AND,
        }
      : {},
    select: {
      id: true,
      transaction_id: true,
      journal_code: true,
      tnx_from: true,
      tnx_to: true,
      amount: true,
      remark: true,
      note: true,
      created_at: true,
    },
    orderBy: [
      {
        created_at: "desc",
      },
      {
        id: "desc",
      },
    ],
    take: lim + 1,
  });

  const normalized = rows.map(normalizeTxnRow);

  let next_cursor = null;

  if (normalized.length > lim) {
    const last = normalized[lim - 1];
    next_cursor = encodeCursor(last.created_at, last.id);
    normalized.length = lim;
  }

  return {
    rows: normalized,
    next_cursor,
  };
}

module.exports = {
  listByWallet,
  listByUser,
  listAll,
  isValidWalletId,
};