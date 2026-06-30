// models/walletModel.js
const { prisma } = require("../lib/prisma");

/**
 * Wallet ID format:
 *  - "TD" + 8 random digits
 *  - Example: TD12345678
 * Must be UNIQUE.
 */

function randDigits(len = 8) {
  let out = "";
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function makeWalletId(prefix = "TD") {
  return `${prefix}${randDigits(8)}`;
}

function isWalletId(v) {
  return /^TD\d{8}$/i.test(String(v || "").trim());
}

function toNumberIfDecimal(v) {
  if (v == null) return v;

  if (typeof v === "bigint") return Number(v);

  if (
    typeof v === "object" &&
    typeof v.toString === "function" &&
    v.constructor?.name === "Decimal"
  ) {
    return Number(v.toString());
  }

  return v;
}

function normalizeWallet(row) {
  if (!row) return null;

  return {
    ...row,
    id: toNumberIfDecimal(row.id),
    user_id: toNumberIfDecimal(row.user_id),
    amount: toNumberIfDecimal(row.amount),
  };
}

async function userExists(tx, user_id) {
  const uid = Number(user_id);

  if (!Number.isInteger(uid) || uid <= 0) return false;

  const user = await tx.users.findUnique({
    where: {
      user_id: uid,
    },
    select: {
      user_id: true,
    },
  });

  return !!user;
}

async function walletIdExists(tx, wallet_id) {
  const wallet = await tx.wallets.findUnique({
    where: {
      wallet_id,
    },
    select: {
      wallet_id: true,
    },
  });

  return !!wallet;
}

async function generateUniqueWalletId(tx, prefix = "TD", maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const candidate = makeWalletId(prefix);
    const exists = await walletIdExists(tx, candidate);

    if (!exists) return candidate;
  }

  throw new Error("Failed to generate unique wallet_id. Please retry.");
}

async function createWallet({ user_id, status = "ACTIVE" }) {
  const uid = Number(user_id);
  const st = String(status || "ACTIVE").trim().toUpperCase();

  return await prisma.$transaction(async (tx) => {
    if (!(await userExists(tx, uid))) {
      return { error: "USER_NOT_FOUND" };
    }

    const existing = await tx.wallets.findFirst({
      where: {
        user_id: uid,
      },
    });

    if (existing) {
      return {
        error: "WALLET_EXISTS",
        wallet: normalizeWallet(existing),
      };
    }

    let created = null;

    for (let attempt = 0; attempt < 50; attempt++) {
      const wallet_id = await generateUniqueWalletId(tx, "TD", 10);

      try {
        created = await tx.wallets.create({
          data: {
            wallet_id,
            user_id: uid,
            amount: 0,
            status: st,
          },
        });

        break;
      } catch (err) {
        if (
          err?.code === "P2002" ||
          String(err?.message || "").toLowerCase().includes("unique")
        ) {
          continue;
        }

        throw err;
      }
    }

    if (!created) {
      throw new Error(
        "Could not allocate unique wallet_id after multiple attempts.",
      );
    }

    return normalizeWallet(created);
  });
}

async function getWallet({ key }) {
  const k = String(key || "").trim();

  if (!k) return null;

  const byWalletId = isWalletId(k);

  const wallet = byWalletId
    ? await prisma.wallets.findUnique({
        where: {
          wallet_id: k,
        },
      })
    : await prisma.wallets.findUnique({
        where: {
          id: Number(k),
        },
      });

  return normalizeWallet(wallet);
}

async function getWalletByUserId(user_id) {
  const uid = Number(user_id);

  if (!Number.isInteger(uid) || uid <= 0) return null;

  const wallet = await prisma.wallets.findFirst({
    where: {
      user_id: uid,
    },
  });

  return normalizeWallet(wallet);
}

async function listWallets({ limit = 50, offset = 0, status = null }) {
  const take = Math.min(Number(limit) || 50, 200);
  const skip = Number(offset) || 0;

  const where = {};

  if (status) {
    where.status = String(status).trim().toUpperCase();
  }

  const rows = await prisma.wallets.findMany({
    where,
    orderBy: {
      id: "desc",
    },
    take,
    skip,
  });

  return rows.map(normalizeWallet);
}

async function updateWalletStatus({ key, status }) {
  const k = String(key || "").trim();
  const st = String(status || "").trim().toUpperCase();

  if (!k) return null;

  const existing = isWalletId(k)
    ? await prisma.wallets.findUnique({
        where: {
          wallet_id: k,
        },
        select: {
          id: true,
        },
      })
    : await prisma.wallets.findUnique({
        where: {
          id: Number(k),
        },
        select: {
          id: true,
        },
      });

  if (!existing) return null;

  const updated = await prisma.wallets.update({
    where: {
      id: Number(existing.id),
    },
    data: {
      status: st,
    },
  });

  return normalizeWallet(updated);
}

async function deleteWallet({ key }) {
  const k = String(key || "").trim();

  if (!k) {
    return { ok: false, code: "NOT_FOUND" };
  }

  return await prisma.$transaction(async (tx) => {
    const wallet = isWalletId(k)
      ? await tx.wallets.findUnique({
          where: {
            wallet_id: k,
          },
          select: {
            id: true,
            wallet_id: true,
          },
        })
      : await tx.wallets.findUnique({
          where: {
            id: Number(k),
          },
          select: {
            id: true,
            wallet_id: true,
          },
        });

    if (!wallet) {
      return {
        ok: false,
        code: "NOT_FOUND",
      };
    }

    const txnCount = await tx.wallet_transactions.count({
      where: {
        OR: [
          {
            tnx_from: wallet.wallet_id,
          },
          {
            tnx_to: wallet.wallet_id,
          },
        ],
      },
    });

    if (txnCount > 0) {
      return {
        ok: false,
        code: "HAS_TRANSACTIONS",
      };
    }

    await tx.wallets.delete({
      where: {
        id: Number(wallet.id),
      },
    });

    return {
      ok: true,
    };
  });
}

/**
 * Set / update encrypted T-PIN for a wallet
 */
async function setWalletTPin({ key, t_pin_hash }) {
  const k = String(key || "").trim();

  if (!k) return null;

  const existing = isWalletId(k)
    ? await prisma.wallets.findUnique({
        where: {
          wallet_id: k,
        },
        select: {
          id: true,
        },
      })
    : await prisma.wallets.findUnique({
        where: {
          id: Number(k),
        },
        select: {
          id: true,
        },
      });

  if (!existing) return null;

  const updated = await prisma.wallets.update({
    where: {
      id: Number(existing.id),
    },
    data: {
      t_pin: t_pin_hash,
    },
  });

  return normalizeWallet(updated);
}

module.exports = {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
  setWalletTPin,
};