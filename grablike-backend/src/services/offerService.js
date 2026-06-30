// src/services/offerService.js
import { getRedis } from '../matching/redis.js';
import {
  findAllActiveOffers,
  findOffersByCategory,
  findPersonalisedOffers,
  findOfferById,
  findUserVouchers,
  insertUserVoucher,
  markVoucherUsed,
  countUserRedemptionsForOffer,
  insertOfferRedemption,
  incrementOfferTotalUses,
  findAllOffersForAdmin,
  findOfferByIdForAdmin,
  createOffer,
  updateOffer,
  deleteOffer,
  toggleOfferActive,
  getOfferRedemptions
} from '../models/offerModel.js';
import { findUserById } from '../models/userModel.js';

// ---------- Global offers (cached) ----------
export const getAllOffers = async () => {
  const cacheKey = 'offers:all';
  const redis = getRedis();

  const cached = await redis.get(cacheKey);

  console.log('Checking cache for all offers:', cached );
  if (cached) return JSON.parse(cached);

  const offers = await findAllActiveOffers();
  console.log('Fetched offers from DB:', offers, offers.length);
  if (offers.length) await redis.setex(cacheKey, 300, JSON.stringify(offers));
  return offers;
};

// ---------- Category‑based offers (cached per category) ----------
export const getOffersByCategory = async (category) => {
  const cacheKey = `offers:category:${category}`;
  const redis = getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const offers = await findOffersByCategory(category);
  if (offers.length) await redis.setex(cacheKey, 300, JSON.stringify(offers));
  return offers;
};

// ---------- Personalised offers (cached per user+city) ----------
export const getPersonalisedOffers = async (userId, city) => {
  const cacheKey = `offers:personal:${userId}:${city}`;
  const redis = getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const user = await findUserById(userId);
  if (!user) return [];

  const userTier = user.tier || 'bronze';
  const userSegment = user.segment || 'regular';

  const offers = await findPersonalisedOffers({ userTier, userSegment, userId, city });
  if (offers.length) await redis.setex(cacheKey, 300, JSON.stringify(offers));
  return offers;
};

// ---------- Single offer by ID (cached) ----------
export const getOfferById = async (id) => {
  const cacheKey = `offer:${id}`;
  const redis = getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const offer = await findOfferById(id);
  if (offer) await redis.setex(cacheKey, 300, JSON.stringify(offer));
  return offer;
};

// ---------- User vouchers (cached) ----------
export const getUserVouchers = async (userId) => {
  const cacheKey = `user:vouchers:${userId}`;
  const redis = getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const vouchers = await findUserVouchers(userId);
  if (vouchers.length) await redis.setex(cacheKey, 300, JSON.stringify(vouchers));
  return vouchers;
};

// ---------- Award a points‑based voucher ----------
export const awardPointsVoucher = async (userId, threshold) => {
  const user = await findUserById(userId);
  if (!user) return;

  // Avoid awarding multiple times for same threshold
  const existing = await findUserVouchers(userId);
  const already = existing.some(v => v.title.includes(`${threshold} points`));
  if (already) return;

  const voucherCode = `POINTS${threshold}_${userId}_${Date.now()}`;
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 30); // valid 30 days

  await insertUserVoucher({
    userId,
    voucherCode,
    title: `🎉 You reached ${threshold} points!`,
    description: `Get 15% off your next Premium ride.`,
    discountType: 'percentage',
    discountValue: 15.00,
    applicableRideType: 'Premium',
    expiryDate: expiry,
  });

  // Invalidate user vouchers cache
  const redis = getRedis();
  await redis.del(`user:vouchers:${userId}`);
};

// ---------- Validate and apply an offer during booking ----------
export const validateAndApplyOffer = async (userId, offerCode, rideId, rideType, subtotal) => {
  // First, check if it's a user voucher
  const vouchers = await findUserVouchers(userId);
  const voucher = vouchers.find(v => v.code === offerCode);
  if (voucher) {
    // Apply voucher discount
    let discount = 0;
    if (voucher.discount_type === 'percentage') {
      discount = (subtotal * voucher.discount_value) / 100;
    } else {
      discount = voucher.discount_value;
    }
    await markVoucherUsed(offerCode, userId);
    // Invalidate cache
    const redis = getRedis();
    await redis.del(`user:vouchers:${userId}`);
    return { discount, source: 'voucher' };
  }

  // If not a voucher, look for an offer with this promoCode
  const offer = await findOfferByPromoCode(offerCode); // need to add this function
  if (!offer) throw new Error('Invalid offer code');

  // Check usage limits
  if (offer.max_uses_per_user !== null) {
    const userUses = await countUserRedemptionsForOffer(offer.id, userId);
    if (userUses >= offer.max_uses_per_user) {
      throw new Error('You have already used this offer the maximum number of times');
    }
  }
  if (offer.max_uses_total !== null && offer.current_uses_total >= offer.max_uses_total) {
    throw new Error('This offer has expired (fully redeemed)');
  }

  // Check if ride type matches (optional)
  // (You could add an applicable_ride_type column to offers if needed)

  // Record redemption
  await insertOfferRedemption(offer.id, userId, rideId);
  await incrementOfferTotalUses(offer.id);

  // Invalidate cache for this offer
  const redis = getRedis();
  await redis.del(`offer:${offer.id}`);

  // For simplicity, assume discount is percentage from offer title
  // In reality, you might store discount details in the offer table.
  // Here we return a fixed discount value (you can improve)
  return { discount: subtotal * 0.2, source: 'offer' }; // 20% off example
};

// Helper to find offer by promoCode (add to model if needed)
async function findOfferByPromoCode(code) {
  const sql = `
    SELECT id, title, promoCode, max_uses_per_user, max_uses_total, current_uses_total
    FROM offers
    WHERE promoCode = ? AND active = 1 AND startDate <= NOW() AND expiryDate >= NOW()
    LIMIT 1
  `;
  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [code]);
    return rows.length ? rows[0] : null;
  });
}



// ------------ Admin functions to create/update offers ------------
export const getAllOffersAdmin = async (filters, limit, offset) => {
  return findAllOffersForAdmin({ limit, offset, filters });
};

export const getOfferByIdAdmin = async (id) => {
  const offer = await findOfferByIdForAdmin(id);
  if (!offer) throw new Error('Offer not found');
  return offer;
};

export const createNewOffer = async (offerData) => {
  // Basic validation
  if (!offerData.title || !offerData.sub || !offerData.expiryDate) {
    throw new Error('Missing required fields: title, sub, expiryDate');
  }
  // Ensure dates are proper
  if (new Date(offerData.startDate) > new Date(offerData.expiryDate)) {
    throw new Error('Start date must be before expiry date');
  }
  const id = await createOffer(offerData);
  // Invalidate relevant caches
  const redis = getRedis();
  await redis.del('offers:all');
  await redis.del('offers:category:for_you');
  // Also could delete category-specific keys
  return id;
};

export const updateExistingOffer = async (id, offerData) => {
  const existing = await findOfferByIdForAdmin(id);
  if (!existing) throw new Error('Offer not found');
  await updateOffer(id, offerData);
  // Invalidate caches
  const redis = getRedis();
  await redis.del('offers:all');
  await redis.del(`offer:${id}`);
  await redis.del('offers:category:for_you');
  // If category changed, delete old category cache too
  if (offerData.category && offerData.category !== existing.category) {
    await redis.del(`offers:category:${existing.category}`);
  }
};

export const removeOffer = async (id) => {
  const existing = await findOfferByIdForAdmin(id);
  console.log("Existing offer before deletion: ", existing);
  if (!existing) throw new Error('Offer not found');
  await deleteOffer(id);
  console.log("Offer deleted: ", id);
  // Invalidate caches
  const redis = getRedis();
  await redis.del('offers:all');
  await redis.del(`offer:${id}`);
  await redis.del(`offers:category:${existing.category}`);
};

export const setOfferActive = async (id, active) => {
  const existing = await findOfferByIdForAdmin(id);
  if (!existing) throw new Error('Offer not found');
  await toggleOfferActive(id, active);
  const redis = getRedis();
  await redis.del('offers:all');
  await redis.del(`offer:${id}`);
  await redis.del(`offers:category:${existing.category}`);
};

export const getRedemptionsForOffer = async (offerId, limit, offset) => {
  const offer = await findOfferByIdForAdmin(offerId);
  if (!offer) throw new Error('Offer not found');
  return getOfferRedemptions(offerId, { limit, offset });
};
