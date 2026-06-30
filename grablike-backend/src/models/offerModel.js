// src/models/offerModel.js
import { withConn, qConn, execConn } from '../db/mysql.js';

// ---------- Global offers ----------
export const findAllActiveOffers = async () => {
  const sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint,
      deepLink, promoCode, startDate, expiryDate
    FROM offers
    WHERE active = 1
      AND startDate <= NOW()
      AND expiryDate >= NOW()
    ORDER BY createdAt DESC
    LIMIT 10
  `;
  console.log('Running SQL:', sql);
  const result = await withConn(async (conn) => qConn(conn, sql));
  console.log('Rows returned:', result.length);
  console.log('Rows:', JSON.stringify(result, null, 2));
  return result;
};

// ---------- Category‑based offers ----------
export const findOffersByCategory = async (category) => {
  const sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint,
      deepLink, promoCode, startDate, expiryDate
    FROM offers
    WHERE active = 1
      AND startDate <= NOW()
      AND expiryDate >= NOW()
      AND category = ?
    ORDER BY createdAt DESC
    LIMIT 20
  `;
  return withConn(async (conn) => qConn(conn, sql, [category]));
};

// ---------- Personalised offers (with targeting) ----------
export const findPersonalisedOffers = async ({
  userTier,
  userSegment,
  userId,
  city,
}) => {
  const sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint,
      deepLink, promoCode, startDate, expiryDate,
      max_uses_per_user, max_uses_total, current_uses_total
    FROM offers
    WHERE active = 1
      AND startDate <= NOW()
      AND expiryDate >= NOW()
      AND (
        for_all = TRUE
        OR JSON_CONTAINS(applicableTiers, ?)
        OR JSON_CONTAINS(user_segment, ?)
        OR user_id = ?
      )
      AND (applicableLocations = '[]' OR JSON_CONTAINS(applicableLocations, ?))
    ORDER BY createdAt DESC
    LIMIT 10
  `;
  return withConn(async (conn) =>
    qConn(conn, sql, [
      JSON.stringify(userTier),
      JSON.stringify(userSegment),
      userId,
      JSON.stringify(city),
    ])
  );
};

// ---------- Single offer by ID ----------
export const findOfferById = async (id) => {
  const sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint,
      deepLink, promoCode, startDate, expiryDate,
      max_uses_per_user, max_uses_total, current_uses_total
    FROM offers
    WHERE id = ? AND active = 1 AND startDate <= NOW() AND expiryDate >= NOW()
    LIMIT 1
  `;
  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [id]);
    return rows.length ? rows[0] : null;
  });
};

// ---------- User vouchers ----------
export const findUserVouchers = async (userId) => {
  const sql = `
    SELECT 
      id, voucher_code AS code, title, description,
      discount_type, discount_value, applicable_ride_type,
      expiry_date AS expiryDate, is_used
    FROM user_vouchers
    WHERE user_id = ? AND is_used = FALSE AND expiry_date >= NOW()
    ORDER BY created_at DESC
  `;
  return withConn(async (conn) => qConn(conn, sql, [userId]));
};

// ---------- Mark voucher as used ----------
export const markVoucherUsed = async (voucherCode, userId) => {
  const sql = `
    UPDATE user_vouchers
    SET is_used = TRUE
    WHERE voucher_code = ? AND user_id = ? AND is_used = FALSE
  `;
  return withConn(async (conn) => execConn(conn, sql, [voucherCode, userId]));
};

// ---------- Insert a new user voucher (e.g., from points) ----------
export const insertUserVoucher = async ({
  userId,
  voucherCode,
  title,
  description,
  discountType,
  discountValue,
  applicableRideType,
  expiryDate,
}) => {
  const sql = `
    INSERT INTO user_vouchers
      (user_id, voucher_code, title, description, discount_type, discount_value, applicable_ride_type, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  return withConn(async (conn) =>
    execConn(conn, sql, [
      userId,
      voucherCode,
      title,
      description,
      discountType,
      discountValue,
      applicableRideType,
      expiryDate,
    ])
  );
};

// ---------- Offer redemption tracking ----------
export const countUserRedemptionsForOffer = async (offerId, userId) => {
  const sql = `
    SELECT COUNT(*) AS count
    FROM offer_redemptions
    WHERE offer_id = ? AND user_id = ?
  `;
  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [offerId, userId]);
    return rows[0]?.count || 0;
  });
};

export const insertOfferRedemption = async (offerId, userId, rideId) => {
  const sql = `
    INSERT INTO offer_redemptions (offer_id, user_id, ride_id)
    VALUES (?, ?, ?)
  `;
  return withConn(async (conn) => execConn(conn, sql, [offerId, userId, rideId]));
};

export const incrementOfferTotalUses = async (offerId) => {
  const sql = `
    UPDATE offers
    SET current_uses_total = current_uses_total + 1
    WHERE id = ?
  `;
  return withConn(async (conn) => execConn(conn, sql, [offerId]));
};


// ---------- Admin functions ----------

export const findAllOffersForAdmin = async ({ limit = 50, offset = 0, filters = {} }) => {
  let sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint, category, promoCode,
      deepLink, startDate, expiryDate, active, for_all,
      applicableTiers, applicableLocations, user_segment, user_id,
      max_uses_per_user, max_uses_total, current_uses_total,
      discount_type, discount_value, applicable_ride_type,
      createdAt, updatedAt
    FROM offers
    WHERE 1=1
  `;
  const params = [];

  if (filters.active !== undefined) {
    sql += ` AND active = ?`;
    params.push(filters.active ? 1 : 0);
  }
  if (filters.category) {
    sql += ` AND category = ?`;
    params.push(filters.category);
  }
  if (filters.search) {
    sql += ` AND (title LIKE ? OR promoCode LIKE ?)`;
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  sql += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return withConn(async (conn) => qConn(conn, sql, params));
};

export const findOfferByIdForAdmin = async (id) => {
  const sql = `
    SELECT 
      id, title, sub, icon, cta, imageUrl, tint, category, promoCode,
      deepLink, startDate, expiryDate, active, for_all,
      applicableTiers, applicableLocations, user_segment, user_id,
      max_uses_per_user, max_uses_total, current_uses_total,
      discount_type, discount_value, applicable_ride_type,
      createdAt, updatedAt
    FROM offers
    WHERE id = ?
    LIMIT 1
  `;
  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [id]);
    return rows.length ? rows[0] : null;
  });
};

export const createOffer = async (offerData) => {
  const {
    title, sub, icon, cta, imageUrl, tint, category, promoCode, //imageUrl, tint
    deepLink, startDate, expiryDate, active, for_all,
    applicableTiers, applicableLocations, user_segment, user_id,
    max_uses_per_user, max_uses_total,
    discount_type, discount_value, applicable_ride_type,
  } = offerData;

  const sql = `
    INSERT INTO offers (
      title, sub, icon, cta, imageUrl, tint, category, promoCode,
      deepLink, startDate, expiryDate, active, for_all,
      applicableTiers, applicableLocations, user_segment, user_id,
      max_uses_per_user, max_uses_total,
      discount_type, discount_value, applicable_ride_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  return withConn(async (conn) => {
    const result = await execConn(conn, sql, [
      title, sub, icon, cta, imageUrl, tint, category, promoCode,
      deepLink, startDate, expiryDate, active, for_all,
      applicableTiers, applicableLocations, user_segment, user_id,
      max_uses_per_user, max_uses_total,
      discount_type, discount_value, applicable_ride_type,
    ]);
    return result.insertId;
  });
};

export const updateOffer = async (id, offerData) => {
  const {
    title, sub, icon, cta, imageUrl, tint, category, promoCode,
    deepLink, startDate, expiryDate, active, for_all,
    applicableTiers, applicableLocations, user_segment, user_id,
    max_uses_per_user, max_uses_total,
    discount_type, discount_value, applicable_ride_type,
  } = offerData;

  const sql = `
    UPDATE offers
    SET
      title = ?, sub = ?, icon = ?, cta = ?, imageUrl = ?, tint = ?,
      category = ?, promoCode = ?, deepLink = ?, startDate = ?, expiryDate = ?,
      active = ?, for_all = ?, applicableTiers = ?, applicableLocations = ?,
      user_segment = ?, user_id = ?, max_uses_per_user = ?, max_uses_total = ?,
      discount_type = ?, discount_value = ?, applicable_ride_type = ?
    WHERE id = ?
  `;

  return withConn(async (conn) => {
    await execConn(conn, sql, [
      title, sub, icon, cta, imageUrl, tint, category, promoCode,
      deepLink, startDate, expiryDate, active, for_all,
      applicableTiers, applicableLocations, user_segment, user_id,
      max_uses_per_user, max_uses_total,
      discount_type, discount_value, applicable_ride_type,
      id,
    ]);
  });
};

export const deleteOffer = async (id) => {
  // Hard delete: permanently remove the row
  const sql = `DELETE FROM offers WHERE id = ?`;
  return withConn(async (conn) => execConn(conn, sql, [id]));
};

export const toggleOfferActive = async (id, active) => {
  const sql = `UPDATE offers SET active = ? WHERE id = ?`;
  return withConn(async (conn) => execConn(conn, sql, [active ? 1 : 0, id]));
};

export const getOfferRedemptions = async (offerId, { limit = 50, offset = 0 }) => {
  const sql = `
    SELECT 
      or.id, or.user_id, or.ride_id, or.redeemed_at,
      u.name as user_name, u.email as user_email
    FROM offer_redemptions or
    LEFT JOIN users u ON or.user_id = u.id
    WHERE or.offer_id = ?
    ORDER BY or.redeemed_at DESC
    LIMIT ? OFFSET ?
  `;
  return withConn(async (conn) => qConn(conn, sql, [offerId, limit, offset]));
};