const { prisma } = require("../lib/prisma");
const moment = require("moment-timezone");
const axios = require("axios");

const ADMIN_WALLET_ID = process.env.ADMIN_WALLET_ID;
const ID_SERVICE_URL = process.env.ID_SERVICE_URL;

const nowBT = () => moment.tz("Asia/Thimphu").toDate();

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toBizId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("business_id must be a positive integer");
  }
  return n;
}

function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function toOwnerType(v) {
  const s = norm(v);
  if (!s) return null;
  if (s !== "food" && s !== "mart") {
    throw new Error("owner_type must be either 'food' or 'mart'");
  }
  return s;
}

function toDateOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error("Invalid date format");
  }
  return d;
}

function serializeBanner(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    business_id: Number(row.business_id),
    title: row.title,
    description: row.description,
    banner_image: row.banner_image,
    is_active: Number(row.is_active),
    start_date: row.start_date,
    end_date: row.end_date,
    owner_type: row.owner_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function assertBusinessExists(business_id) {
  const bid = toBizId(business_id);

  const row = await prisma.merchant_business_details.findUnique({
    where: { business_id: bid },
    select: {
      business_id: true,
      business_name: true,
    },
  });

  if (!row) {
    throw new Error(`business_id ${bid} does not exist`);
  }

  return row;
}

/* ---------- ID API helpers ---------- */

async function getJournalCodeViaApi() {
  const { data } = await axios.post(`${ID_SERVICE_URL}/ids/journal`, {});

  if (!data?.ok || !data.code) {
    throw new Error("Failed to get journal_code from ID service");
  }

  return data.code;
}

async function getTwoTxnIdsViaApi() {
  const { data } = await axios.post(`${ID_SERVICE_URL}/ids/transaction`, {
    count: 2,
  });

  if (!data?.ok || !Array.isArray(data.data) || data.data.length < 2) {
    throw new Error("Failed to get transaction_ids from ID service");
  }

  return {
    dr: data.data[0],
    cr: data.data[1],
  };
}

/* ---------- helpers ---------- */

function buildDateCoverageSet(startDate, endDate) {
  const set = new Set();

  if (!startDate || !endDate) return set;

  let s = moment(startDate).startOf("day");
  const e = moment(endDate).startOf("day");

  if (!s.isValid() || !e.isValid() || e.isBefore(s)) return set;

  while (!s.isAfter(e)) {
    set.add(s.format("YYYY-MM-DD"));
    s = s.add(1, "day");
  }

  return set;
}

function computeAdditionalDays(oldStart, oldEnd, newStart, newEnd) {
  const prevDays = buildDateCoverageSet(oldStart, oldEnd);

  if (!newStart || !newEnd) return 0;

  let added = 0;
  let s = moment(newStart).startOf("day");
  const e = moment(newEnd).startOf("day");

  if (!s.isValid() || !e.isValid() || e.isBefore(s)) return 0;

  while (!s.isAfter(e)) {
    const key = s.format("YYYY-MM-DD");
    if (!prevDays.has(key)) added++;
    s = s.add(1, "day");
  }

  return added;
}

/* ---------- AUTO-DEACTIVATION SWEEP ---------- */

async function sweepExpiredBanners() {
  const todayBT = moment.tz("Asia/Thimphu").startOf("day").toDate();

  await prisma.business_banners.updateMany({
    where: {
      is_active: 1,
      end_date: {
        not: null,
        lte: todayBT,
      },
    },
    data: {
      is_active: 0,
      updated_at: nowBT(),
    },
  });
}

/* ---------- base price ---------- */

async function getBannerBasePrice() {
  try {
    const row = await prisma.banners_base_prices.findFirst({
      orderBy: {
        banner_price_id: "asc",
      },
      select: {
        amount_per_day: true,
      },
    });

    if (!row) {
      return {
        success: false,
        message: "Banner base price not found.",
      };
    }

    const amount = Number(row.amount_per_day);

    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        success: false,
        message: "Invalid banner base price.",
      };
    }

    return {
      success: true,
      amount_per_day: amount,
    };
  } catch (error) {
    console.error("getBannerBasePrice error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch banner base price.",
    };
  }
}

/* ---------- create banner + wallet charge ---------- */

async function createBannerWithWalletCharge({ banner, payer_user_id, amount }) {
  try {
    const bid = toBizId(banner.business_id);
    const biz = await assertBusinessExists(bid);

    const payerUserId = Number(payer_user_id);
    if (!Number.isInteger(payerUserId) || payerUserId <= 0) {
      return {
        success: false,
        message: "user_id must be a positive integer",
      };
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return {
        success: false,
        message: "Invalid total_amount",
      };
    }

    const img = toStrOrNull(banner.banner_image);
    if (!img) {
      return {
        success: false,
        message: "banner_image is required",
      };
    }

    const ownerType = toOwnerType(banner.owner_type);
    if (!ownerType) {
      return {
        success: false,
        message: "owner_type is required and must be 'food' or 'mart'",
      };
    }

    const journal_code = await getJournalCodeViaApi();
    const { dr, cr } = await getTwoTxnIdsViaApi();

    const out = await prisma.$transaction(async (tx) => {
      const payer = await tx.wallets.findFirst({
        where: { user_id: payerUserId },
      });

      if (!payer) {
        throw new Error(`No wallet found for user_id ${payerUserId}`);
      }

      const admin = await tx.wallets.findFirst({
        where: { wallet_id: ADMIN_WALLET_ID },
      });

      if (!admin) {
        throw new Error(`Admin wallet ${ADMIN_WALLET_ID} not found`);
      }

      if (payer.status !== "ACTIVE") {
        throw new Error("Payer wallet is not ACTIVE");
      }

      if (admin.status !== "ACTIVE") {
        throw new Error("Admin wallet is not ACTIVE");
      }

      if (Number(payer.amount) < amt) {
        throw new Error("Insufficient wallet balance");
      }

      const createdBanner = await tx.business_banners.create({
        data: {
          business_id: bid,
          title: toStrOrNull(banner.title),
          description: toStrOrNull(banner.description),
          banner_image: img,
          is_active: Number(banner.is_active) ? 1 : 0,
          start_date: toDateOrNull(banner.start_date),
          end_date: toDateOrNull(banner.end_date),
          owner_type: ownerType,
          created_at: nowBT(),
          updated_at: nowBT(),
        },
      });

      await tx.wallets.update({
        where: { id: payer.id },
        data: {
          amount: {
            decrement: amt,
          },
        },
      });

      await tx.wallets.update({
        where: { id: admin.id },
        data: {
          amount: {
            increment: amt,
          },
        },
      });

      const businessName =
        biz.business_name || `business_id=${biz.business_id}`;
      const note = `Banner Fee from ${businessName} (${ownerType})`;
      const now = nowBT();

      await tx.wallet_transactions.create({
        data: {
          transaction_id: dr,
          journal_code,
          tnx_from: payer.wallet_id,
          tnx_to: admin.wallet_id,
          amount: amt,
          remark: "DR",
          note,
          created_at: now,
          updated_at: now,
        },
      });

      await tx.wallet_transactions.create({
        data: {
          transaction_id: cr,
          journal_code,
          tnx_from: payer.wallet_id,
          tnx_to: admin.wallet_id,
          amount: amt,
          remark: "CR",
          note,
          created_at: now,
          updated_at: now,
        },
      });

      return {
        banner: createdBanner,
        payment: {
          journal_code,
          debited_from_wallet: payer.wallet_id,
          credited_to_wallet: admin.wallet_id,
          amount: amt,
          debit_txn_id: dr,
          credit_txn_id: cr,
        },
      };
    });

    await sweepExpiredBanners();

    return {
      success: true,
      data: serializeBanner(out.banner),
      payment: out.payment,
    };
  } catch (error) {
    console.error("createBannerWithWalletCharge error:", error);
    return {
      success: false,
      message: error.message || "Failed to create banner with wallet charge",
    };
  }
}

/* ---------- get one ---------- */

async function getBannerById(id) {
  try {
    await sweepExpiredBanners();

    const row = await prisma.business_banners.findUnique({
      where: { id: Number(id) },
    });

    if (!row) {
      return {
        success: false,
        message: `Banner id ${id} not found.`,
      };
    }

    return {
      success: true,
      data: serializeBanner(row),
    };
  } catch (error) {
    console.error("getBannerById error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch banner.",
    };
  }
}

/* ---------- list banners ---------- */

async function listBanners({ business_id, active_only, owner_type } = {}) {
  try {
    await sweepExpiredBanners();

    const where = {};

    if (
      business_id !== undefined &&
      business_id !== null &&
      business_id !== ""
    ) {
      const bid = toBizId(business_id);
      await assertBusinessExists(bid);
      where.business_id = bid;
    }

    if (owner_type) {
      where.owner_type = toOwnerType(owner_type);
    }

    const activeOnly =
      String(active_only).toLowerCase() === "true" || Number(active_only) === 1;

    if (activeOnly) {
      const todayBT = moment.tz("Asia/Thimphu").startOf("day").toDate();

      where.is_active = 1;
      where.AND = [
        {
          OR: [{ start_date: null }, { start_date: { lte: todayBT } }],
        },
        {
          OR: [{ end_date: null }, { end_date: { gte: todayBT } }],
        },
      ];
    }

    const rows = await prisma.business_banners.findMany({
      where,
      orderBy: {
        created_at: "desc",
      },
    });

    return {
      success: true,
      data: rows.map(serializeBanner),
    };
  } catch (error) {
    console.error("listBanners error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch banners.",
      data: [],
    };
  }
}

/* ---------- list business banners ---------- */

async function listAllBannersForBusiness(business_id, owner_type) {
  try {
    await sweepExpiredBanners();

    const bid = toBizId(business_id);

    const where = {
      business_id: bid,
    };

    if (owner_type) {
      where.owner_type = toOwnerType(owner_type);
    }

    const rows = await prisma.business_banners.findMany({
      where,
      orderBy: {
        created_at: "desc",
      },
    });

    return {
      success: true,
      data: rows.map(serializeBanner),
    };
  } catch (error) {
    console.error("listAllBannersForBusiness error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch business banners.",
      data: [],
    };
  }
}

/* ---------- list active food/mart ---------- */

async function listActiveByKind(owner_type, business_id) {
  try {
    await sweepExpiredBanners();

    const todayBT = moment.tz("Asia/Thimphu").startOf("day").toDate();

    const where = {
      is_active: 1,
      owner_type: toOwnerType(owner_type),
      AND: [
        {
          OR: [{ start_date: null }, { start_date: { lte: todayBT } }],
        },
        {
          OR: [{ end_date: null }, { end_date: { gte: todayBT } }],
        },
      ],
    };

    if (
      business_id !== undefined &&
      business_id !== null &&
      business_id !== ""
    ) {
      where.business_id = toBizId(business_id);
    }

    const rows = await prisma.business_banners.findMany({
      where,
      orderBy: {
        created_at: "desc",
      },
    });

    return {
      success: true,
      data: rows.map(serializeBanner),
    };
  } catch (error) {
    console.error("listActiveByKind error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch active banners.",
      data: [],
    };
  }
}

/* ---------- update banner ---------- */

async function updateBanner(id, fields, opts = {}) {
  try {
    await sweepExpiredBanners();

    const bannerId = Number(id);
    if (!Number.isInteger(bannerId) || bannerId <= 0) {
      return {
        success: false,
        message: "Invalid banner id",
      };
    }

    const current = await prisma.business_banners.findUnique({
      where: { id: bannerId },
    });

    if (!current) {
      return {
        success: false,
        message: `Banner id ${id} not found.`,
      };
    }

    const wantsDateChange =
      Object.prototype.hasOwnProperty.call(fields, "start_date") ||
      Object.prototype.hasOwnProperty.call(fields, "end_date") ||
      Object.prototype.hasOwnProperty.call(fields, "is_active");

    const hasWalletContext =
      opts &&
      opts.payer_user_id !== undefined &&
      (opts.total_amount !== undefined || opts.auto_price === true);

    const data = {};

    if ("business_id" in fields) {
      const bid = toBizId(fields.business_id);
      await assertBusinessExists(bid);
      data.business_id = bid;
    }

    if ("title" in fields) {
      data.title = toStrOrNull(fields.title);
    }

    if ("description" in fields) {
      data.description = toStrOrNull(fields.description);
    }

    if ("banner_image" in fields) {
      data.banner_image = toStrOrNull(fields.banner_image);
    }

    if ("is_active" in fields) {
      data.is_active = Number(fields.is_active) ? 1 : 0;
    }

    if ("start_date" in fields) {
      data.start_date = toDateOrNull(fields.start_date);
    }

    if ("end_date" in fields) {
      data.end_date = toDateOrNull(fields.end_date);
    }

    if ("owner_type" in fields) {
      data.owner_type = toOwnerType(fields.owner_type);
    }

    if (!Object.keys(data).length) {
      return {
        success: true,
        message: "No changes.",
        data: serializeBanner(current),
      };
    }

    data.updated_at = nowBT();

    if (!wantsDateChange || !hasWalletContext) {
      const updated = await prisma.business_banners.update({
        where: { id: bannerId },
        data,
      });

      return {
        success: true,
        message: "Banner updated successfully.",
        data: serializeBanner(updated),
      };
    }

    const payerUserId = Number(opts.payer_user_id);
    if (!Number.isInteger(payerUserId) || payerUserId <= 0) {
      return {
        success: false,
        message: "user_id must be a positive integer",
      };
    }

    const explicitAmount =
      opts.total_amount !== undefined ? Number(opts.total_amount) : null;

    const useAuto = opts.auto_price === true;

    let chargeAmount = null;
    let pricingInfo = null;

    if (explicitAmount !== null) {
      if (!Number.isFinite(explicitAmount) || explicitAmount <= 0) {
        return {
          success: false,
          message: "total_amount must be a positive number.",
        };
      }

      chargeAmount = explicitAmount;
      pricingInfo = { mode: "explicit" };
    } else if (useAuto) {
      const basePrice = await getBannerBasePrice();

      if (!basePrice.success) {
        return basePrice;
      }

      const perDay = Number(basePrice.amount_per_day);

      const newStart = Object.prototype.hasOwnProperty.call(
        fields,
        "start_date",
      )
        ? toDateOrNull(fields.start_date)
        : current.start_date;

      const newEnd = Object.prototype.hasOwnProperty.call(fields, "end_date")
        ? toDateOrNull(fields.end_date)
        : current.end_date;

      const additionalDays = computeAdditionalDays(
        current.start_date,
        current.end_date,
        newStart,
        newEnd,
      );

      const computed = additionalDays * perDay;

      if (computed <= 0) {
        const updated = await prisma.business_banners.update({
          where: { id: bannerId },
          data,
        });

        return {
          success: true,
          message: "Banner updated (no additional charge).",
          data: serializeBanner(updated),
          payment: null,
          pricing: {
            mode: "auto",
            additional_days: additionalDays,
            base_amount_per_day: perDay,
            computed_charge: 0,
          },
        };
      }

      chargeAmount = computed;
      pricingInfo = {
        mode: "auto",
        additional_days: additionalDays,
        base_amount_per_day: perDay,
        computed_charge: computed,
      };
    } else {
      return {
        success: false,
        message:
          "Provide total_amount or set auto_price=true for date-change wallet charge.",
      };
    }

    const journal_code = await getJournalCodeViaApi();
    const { dr, cr } = await getTwoTxnIdsViaApi();

    const out = await prisma.$transaction(async (tx) => {
      const payer = await tx.wallets.findFirst({
        where: { user_id: payerUserId },
      });

      if (!payer) {
        throw new Error(`No wallet found for user_id ${payerUserId}`);
      }

      const admin = await tx.wallets.findFirst({
        where: { wallet_id: ADMIN_WALLET_ID },
      });

      if (!admin) {
        throw new Error(`Admin wallet ${ADMIN_WALLET_ID} not found`);
      }

      if (payer.status !== "ACTIVE") {
        throw new Error("Payer wallet is not ACTIVE");
      }

      if (admin.status !== "ACTIVE") {
        throw new Error("Admin wallet is not ACTIVE");
      }

      if (Number(payer.amount) < chargeAmount) {
        throw new Error("Insufficient wallet balance");
      }

      const updatedBanner = await tx.business_banners.update({
        where: { id: bannerId },
        data,
      });

      await tx.wallets.update({
        where: { id: payer.id },
        data: {
          amount: {
            decrement: chargeAmount,
          },
        },
      });

      await tx.wallets.update({
        where: { id: admin.id },
        data: {
          amount: {
            increment: chargeAmount,
          },
        },
      });

      const biz = await tx.merchant_business_details.findUnique({
        where: { business_id: current.business_id },
        select: {
          business_id: true,
          business_name: true,
        },
      });

      const businessName =
        biz?.business_name || `business_id=${current.business_id}`;

      const finalOwnerType =
        fields.owner_type !== undefined
          ? toOwnerType(fields.owner_type)
          : current.owner_type;

      const note = `Banner Fee from ${businessName} (${finalOwnerType})`;
      const now = nowBT();

      await tx.wallet_transactions.create({
        data: {
          transaction_id: dr,
          journal_code,
          tnx_from: payer.wallet_id,
          tnx_to: admin.wallet_id,
          amount: chargeAmount,
          remark: "DR",
          note,
          created_at: now,
          updated_at: now,
        },
      });

      await tx.wallet_transactions.create({
        data: {
          transaction_id: cr,
          journal_code,
          tnx_from: payer.wallet_id,
          tnx_to: admin.wallet_id,
          amount: chargeAmount,
          remark: "CR",
          note,
          created_at: now,
          updated_at: now,
        },
      });

      return {
        banner: updatedBanner,
        payment: {
          journal_code,
          debited_from_wallet: payer.wallet_id,
          credited_to_wallet: admin.wallet_id,
          amount: chargeAmount,
          debit_txn_id: dr,
          credit_txn_id: cr,
        },
      };
    });

    return {
      success: true,
      message: "Banner updated and wallet charged successfully.",
      data: serializeBanner(out.banner),
      payment: out.payment,
      pricing: pricingInfo,
    };
  } catch (error) {
    console.error("updateBanner error:", error);
    return {
      success: false,
      message: error.message || "Failed to update banner.",
    };
  }
}

/* ---------- delete ---------- */

async function deleteBanner(id) {
  try {
    const bannerId = Number(id);

    const current = await prisma.business_banners.findUnique({
      where: { id: bannerId },
      select: {
        id: true,
        banner_image: true,
      },
    });

    if (!current) {
      return {
        success: false,
        message: `Banner id ${id} not found.`,
      };
    }

    await prisma.business_banners.delete({
      where: { id: bannerId },
    });

    return {
      success: true,
      message: "Banner deleted successfully.",
      old_image: current.banner_image || null,
    };
  } catch (error) {
    console.error("deleteBanner error:", error);
    return {
      success: false,
      message: error.message || "Failed to delete banner.",
    };
  }
}

module.exports = {
  sweepExpiredBanners,
  createBannerWithWalletCharge,
  getBannerById,
  listBanners,
  listAllBannersForBusiness,
  listActiveByKind,
  updateBanner,
  deleteBanner,
  getBannerBasePrice,
};
