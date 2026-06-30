// src/services/pricing/rulesEngine.js
import { withConn, qConn } from "../../db/mysql.js";

/* ---------------- helpers ---------------- */
const safeStr = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};

const bpToRate = (bp) => Number(bp || 0) / 10000;
const roundInt = (n) => Math.round(Number(n || 0));
const calcPercentCents = (baseCents, bp) =>
  roundInt(Number(baseCents || 0) * bpToRate(bp));

const centsToNu = (cents) => Number((Number(cents || 0) / 100).toFixed(2));

export const nowSqlUtc = (dt = new Date()) => {
  const pad = (x) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(
    dt.getUTCDate(),
  )} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(
    dt.getUTCSeconds(),
  )}`;
};

/* ---------------- matchers ---------------- */
async function pickPlatformFeeRule(
  conn,
  { country_code, city_id, service_type, trip_type, channel, at },
) {
  const cc = safeStr(country_code);
  const city = safeStr(city_id);
  const svc = safeStr(service_type);
  const trip = safeStr(trip_type);
  const ch = safeStr(channel);

  console.log("Trip Type:", trip);

  const rows = await qConn(
    conn,
    `
    SELECT
      rule_id,
      country_code, city_id, service_type, trip_type, channel,
      fee_type, fee_percent_bp, fee_fixed_cents, min_cents, max_cents,
      apply_on,
      priority, is_active, starts_at, ends_at,
      (
        (country_code IS NOT NULL) +
        (city_id IS NOT NULL) +
        (service_type IS NOT NULL) +
        (trip_type IS NOT NULL) +
        (channel IS NOT NULL)
      ) AS specificity
    FROM platform_fee_rules
    WHERE is_active = 1
      AND starts_at <= ?
      AND (ends_at IS NULL OR ends_at > ?)
      AND (country_code IS NULL OR country_code = ?)
      AND (city_id IS NULL OR city_id = ?)
      AND (service_type IS NULL OR service_type = ?)
      AND (trip_type IS NULL OR trip_type = ?)
      AND (channel IS NULL OR channel = ?)
    ORDER BY specificity DESC, priority ASC, starts_at DESC, rule_id DESC
    LIMIT 1
    `,
    [at, at, cc, city, svc, trip, ch],
  );

  return rows[0] || null;
}

async function pickTaxRule(conn, { country_code, city_id, service_type, at }) {
  const cc = safeStr(country_code);
  const city = safeStr(city_id);
  const svc = safeStr(service_type);

  // Bhutan GST is 5% => rate_percent_bp = 500
  // taxable_base = platform_fee
  const rows = await qConn(
    conn,
    `
    SELECT
      tax_rule_id,
      country_code, city_id, service_type,
      tax_type,
      rate_percent_bp,
      tax_inclusive,
      taxable_base,
      priority, is_active, starts_at, ends_at,
      (
        (country_code IS NOT NULL) +
        (city_id IS NOT NULL) +
        (service_type IS NOT NULL)
      ) AS specificity
    FROM tax_rules
    WHERE is_active = 1
      AND starts_at <= ?
      AND (ends_at IS NULL OR ends_at > ?)
      AND tax_type = 'GST'
      AND taxable_base = 'platform_fee'
      AND (country_code IS NULL OR country_code = ?)
      AND (city_id IS NULL OR city_id = ?)
      AND (service_type IS NULL OR service_type = ?)
    ORDER BY specificity DESC, priority ASC, starts_at DESC, tax_rule_id DESC
    LIMIT 1
    `,
    [at, at, cc, city, svc],
  );

  return rows[0] || null;
}

/* ---------------- computations ---------------- */
function computePlatformFeeCents(rule, amounts) {
  if (!rule) {
    return { platform_fee_cents: 0, fee_breakdown: null };
  }

  const apply_on = rule.apply_on || "subtotal";

  const baseCents =
    apply_on === "fare_after_discounts"
      ? Number(
          amounts.fare_after_discounts_cents ?? amounts.subtotal_cents ?? 0,
        )
      : apply_on === "driver_take_home_base"
        ? Number(amounts.driver_take_home_base_cents ?? 0)
        : Number(amounts.subtotal_cents ?? 0);

  const fee_type = rule.fee_type;
  const percentBp = toInt(rule.fee_percent_bp, 0);
  const fixedCents = toInt(rule.fee_fixed_cents, 0);

  let raw = 0;
  let percentPart = 0;
  let fixedPart = 0;

  if (fee_type === "percent") {
    percentPart = calcPercentCents(baseCents, percentBp);
    raw = percentPart;
  } else if (fee_type === "fixed") {
    fixedPart = fixedCents;
    raw = fixedPart;
  } else if (fee_type === "mixed") {
    percentPart = calcPercentCents(baseCents, percentBp);
    fixedPart = fixedCents;
    raw = percentPart + fixedPart;
  } else {
    raw = 0;
  }

  const minCents = toInt(rule.min_cents, 0);
  const maxCents = toInt(rule.max_cents, 0);

  let finalFee = raw;
  if (minCents > 0) finalFee = Math.max(finalFee, minCents);
  if (maxCents > 0) finalFee = Math.min(finalFee, maxCents);

  return {
    platform_fee_cents: roundInt(finalFee),
    fee_breakdown: {
      apply_on,
      base_cents: roundInt(baseCents),
      fee_type,
      fee_percent_bp: percentBp,
      fee_fixed_cents: fixedCents,
      raw_fee_cents: roundInt(raw),
      min_cents: minCents,
      max_cents: maxCents,
      percent_part_cents: roundInt(percentPart),
      fixed_part_cents: roundInt(fixedPart),
    },
  };
}

function computeGstCents(taxRule, platformFeeCents) {
  if (!taxRule) return { gst_cents: 0, gst_breakdown: null };

  const rateBp = toInt(taxRule.rate_percent_bp, 0);
  const inclusive = toInt(taxRule.tax_inclusive, 0);

  let gst = 0;
  if (!inclusive) {
    gst = calcPercentCents(platformFeeCents, rateBp);
  } else {
    // embedded tax: gross - gross/(1+rate)
    const gross = Number(platformFeeCents || 0);
    const rate = bpToRate(rateBp);
    gst = roundInt(gross - gross / (1 + rate));
  }

  return {
    gst_cents: roundInt(gst),
    gst_breakdown: {
      tax_rule_id: taxRule.tax_rule_id,
      rate_percent_bp: rateBp,
      tax_inclusive: inclusive,
      taxable_base: taxRule.taxable_base,
      taxable_amount_cents: roundInt(platformFeeCents),
    },
  };
}

/* ---------------- fare table lookup ---------------- */
async function lookupFareFromTable(conn, { trip_category, from_location, to_location, trip_type }) {
  if (trip_category === "inter_city") {
    const rows = await qConn(
      conn,
      `SELECT reserve_fare, share_fare
       FROM inter_city_fares
       WHERE LOWER(from_city) = LOWER(?) AND LOWER(to_city) = LOWER(?)
       LIMIT 1`,
      [from_location, to_location],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const isPool = String(trip_type || "").toLowerCase() === "pool";
    const fareNu = isPool ? Number(row.share_fare) : Number(row.reserve_fare);
    return {
      subtotal_cents: Math.round(fareNu * 100),
      is_share_allowed: null, // inter-city doesn't restrict sharing
    };
  } else if (trip_category === "intra_city") {
    const rows = await qConn(
      conn,
      `SELECT reserve_fare, share_fare, is_share
       FROM intra_city_fares
       WHERE LOWER(from_zone) = LOWER(?) AND LOWER(to_zone) = LOWER(?)
       LIMIT 1`,
      [from_location, to_location],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const isPool = String(trip_type || "").toLowerCase() === "pool";
    const fareNu = isPool ? Number(row.share_fare) : Number(row.reserve_fare);
    return {
      subtotal_cents: Math.round(fareNu * 100),
      is_share_allowed: Boolean(row.is_share),
    };
  }
  return null;
}

/* ---------------- public API ---------------- */
async function validateAndComputeDiscount(
  conn,
  offerCode,
  userId,
  serviceType,
  subtotalCents,
) {
  // First check if it's a user voucher (only if userId provided)
  if (userId) {
    const [voucher] = await qConn(
      conn,
      `
      SELECT id, discount_type, discount_value, applicable_ride_type, is_used, expiry_date
      FROM user_vouchers
      WHERE voucher_code = ? AND user_id = ? AND is_used = FALSE AND expiry_date >= NOW()
      LIMIT 1
      `,
      [offerCode, userId],
    );

    if (voucher) {
      // Check ride type applicability
      if (
        voucher.applicable_ride_type &&
        voucher.applicable_ride_type !== serviceType
      ) {
        throw new Error(
          `This voucher is only valid for ${voucher.applicable_ride_type} rides`,
        );
      }

      let discountCents = 0;
      if (voucher.discount_type === "percentage") {
        discountCents = Math.round(
          subtotalCents * (voucher.discount_value / 100),
        );
      } else {
        discountCents = Math.round(voucher.discount_value * 100);
      }

      return {
        discountCents,
        offerDetails: {
          type: "voucher",
          id: voucher.id,
          code: offerCode,
          discount_type: voucher.discount_type,
          discount_value: voucher.discount_value,
          title: "Voucher applied",
        },
      };
    }
    // No voucher found – fall through to global offers
  }

  // If not a voucher (or no userId), look for a global offer with this promoCode
  const [offer] = await qConn(
    conn,
    `
    SELECT id, title, promoCode, discount_type, discount_value,
           max_uses_per_user, max_uses_total, current_uses_total,
           expiryDate, applicable_ride_type
    FROM offers
    WHERE promoCode = ? AND active = 1 AND startDate <= NOW() AND expiryDate >= NOW()
    LIMIT 1
    `,
    [offerCode],
  );

  if (!offer) {
    throw new Error("Invalid or expired offer code");
  }

  // Check ride type applicability
  if (
    offer.applicable_ride_type &&
    offer.applicable_ride_type !== serviceType
  ) {
    throw new Error(
      `This offer is only valid for ${offer.applicable_ride_type} rides`,
    );
  }

  // Check usage limits if userId is provided
  if (userId && offer.max_uses_per_user !== null) {
    const rows = await qConn(
      conn,
      `SELECT COUNT(*) as count FROM offer_redemptions WHERE offer_id = ? AND user_id = ?`,
      [offer.id, userId],
    );
    const count = rows[0]?.count || 0;
    if (count >= offer.max_uses_per_user) {
      throw new Error("You have already used this offer the maximum number of times");
    }
  }

  if (
    offer.max_uses_total !== null &&
    offer.current_uses_total >= offer.max_uses_total
  ) {
    throw new Error("This offer has expired (fully redeemed)");
  }

  let discountCents = 0;
  if (offer.discount_type === "percentage") {
    discountCents = Math.round(subtotalCents * (offer.discount_value / 100));
  } else {
    discountCents = Math.round(offer.discount_value * 100);
  }

  return {
    discountCents,
    offerDetails: {
      type: "offer",
      id: offer.id,
      code: offerCode,
      title: offer.title,
      discount_type: offer.discount_type,
      discount_value: offer.discount_value,
    },
  };
}

export async function computePlatformFeeAndGST(input) {
  const at = safeStr(input.at) || nowSqlUtc(new Date());
  const { offer_code, user_id, service_type } = input;
  const trip_category  = safeStr(input.trip_category)  || null;
  const from_location  = safeStr(input.from_location)  || null;
  const to_location    = safeStr(input.to_location)    || null;

  return await withConn(async (conn) => {
    // Resolve subtotal: fare table lookup takes priority over caller-supplied cents
    let subtotal_cents = toInt(input.subtotal_cents, 0);
    let is_share_allowed = null;

    if (trip_category) {
      const fareRow = await lookupFareFromTable(conn, {
        trip_category,
        from_location,
        to_location,
        trip_type: input.trip_type,
      });
      if (!fareRow) {
        const err = new Error(
          `No fare found for ${trip_category} route: ${from_location} → ${to_location}`,
        );
        err.status = 404;
        throw err;
      }
      subtotal_cents    = fareRow.subtotal_cents;
      is_share_allowed  = fareRow.is_share_allowed;
    }

    let discountCents = 0;
    let appliedOffer = null;

    // Validate and apply offer if provided
    if (offer_code) {
      try {
        const result = await validateAndComputeDiscount(
          conn,
          offer_code,
          user_id,
          service_type,
          subtotal_cents,
        );
        discountCents = result.discountCents;
        appliedOffer = result.offerDetails;
      } catch (err) {
        // If offer is invalid, we can either ignore it (proceed without discount) or throw.
        // For a quote, we probably want to return an error so the frontend can inform the user.
        console.log(err);
        throw new Error(err);
      }
    }

    const discountedSubtotalCents = Math.max(subtotal_cents - discountCents, 0);

    // Match fee rule (using discounted subtotal as base)
    const feeRule = await pickPlatformFeeRule(conn, {
      country_code: input.country_code,
      city_id: input.city_id,
      service_type: input.service_type,
      trip_type: input.trip_type,
      channel: input.channel,
      at,
    });

    // Compute platform fee based on discounted subtotal
    const feeRes = computePlatformFeeCents(feeRule, {
      subtotal_cents: discountedSubtotalCents, // use discounted subtotal
      fare_after_discounts_cents: input.fare_after_discounts_cents,
      driver_take_home_base_cents: input.driver_take_home_base_cents,
    });

    // Match GST rule
    const taxRule = await pickTaxRule(conn, {
      country_code: input.country_code,
      city_id: input.city_id,
      service_type: input.service_type,
      at,
    });

    // Compute GST on platform fee
    const gstRes = computeGstCents(taxRule, feeRes.platform_fee_cents);

    const platform_fee_cents = feeRes.platform_fee_cents;
    const gst_cents = gstRes.gst_cents;

    // Totals based on discounted subtotal
    const total_payable_cents =
      discountedSubtotalCents + platform_fee_cents + gst_cents;
    const driver_payout_cents = Math.max(discountedSubtotalCents, 0); // driver gets the discounted amount

    // Nu conversions
    const subtotal_nu = centsToNu(subtotal_cents);
    const discounted_subtotal_nu = centsToNu(discountedSubtotalCents);
    const discount_nu = centsToNu(discountCents);
    const platform_fee_nu = centsToNu(platform_fee_cents);
    const gst_nu = centsToNu(gst_cents);
    const total_payable_nu = centsToNu(total_payable_cents);
    const driver_payout_nu = centsToNu(driver_payout_cents);

    return {
      at,
      input: {
        country_code: input.country_code ?? null,
        city_id: input.city_id ?? null,
        service_type: input.service_type ?? null,
        trip_type: input.trip_type ?? null,
        channel: input.channel ?? null,
        subtotal_cents,
        subtotal_nu,
        offer_code: offer_code ?? null,
        user_id: user_id ?? null,
        fare_after_discounts_cents:
          input.fare_after_discounts_cents == null
            ? null
            : toInt(input.fare_after_discounts_cents, 0),
        driver_take_home_base_cents:
          input.driver_take_home_base_cents == null
            ? null
            : toInt(input.driver_take_home_base_cents, 0),
      },

      applied_offer: appliedOffer, // added for frontend

      discount: {
        discount_cents: discountCents,
        discount_nu,
        discounted_subtotal_cents: discountedSubtotalCents,
        discounted_subtotal_nu,
      },

      matched_rules: {
        platform_fee_rule: feeRule,
        tax_rule: taxRule,
      },

      amounts: {
        platform_fee_cents,
        platform_fee_nu,
        gst_cents,
        gst_nu,
        total_payable_cents,
        total_payable_nu,
        driver_payout_cents,
        driver_payout_nu,
      },

      receipt: [
        { label: "Original subtotal", cents: subtotal_cents, nu: subtotal_nu },
        ...(discountCents > 0
          ? [{ label: "Discount", cents: -discountCents, nu: -discount_nu }]
          : []),
        {
          label: "Subtotal after discount",
          cents: discountedSubtotalCents,
          nu: discounted_subtotal_nu,
        },
        {
          label: "Platform fee",
          cents: platform_fee_cents,
          nu: platform_fee_nu,
        },
        { label: "GST", cents: gst_cents, nu: gst_nu },
        {
          label: "Total payable",
          cents: total_payable_cents,
          nu: total_payable_nu,
        },
      ],

      fee_breakdown: feeRes.fee_breakdown,
      gst_breakdown: gstRes.gst_breakdown,

      ...(trip_category != null && {
        trip_category,
        from_location,
        to_location,
        is_share_allowed,
      }),
    };
  });
}
