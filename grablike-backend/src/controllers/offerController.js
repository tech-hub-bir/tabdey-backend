// src/controllers/offerController.js
import * as offerService from '../services/offerService.js';
import { findUserById } from '../models/userModel.js';
import { getRedis } from '../matching/redis.js';

export const getOffers = async (req, res) => {
  try {
    const { category, userId, city } = req.query;

    let offers;
    if (userId && city) {
      offers = await offerService.getPersonalisedOffers(userId, city);
    } else if (category) {
      offers = await offerService.getOffersByCategory(category);
    } else {
      offers = await offerService.getAllOffers();
    }

    res.status(200).json({ success: true, data: offers });
  } catch (error) {
    console.error('Error fetching offers:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getOfferByIdHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const offer = await offerService.getOfferById(id);
    if (!offer) {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(200).json({ success: true, data: offer });
  } catch (error) {
    console.error('Error fetching offer:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getUserVouchersHandler = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }
    const vouchers = await offerService.getUserVouchers(userId);
    res.status(200).json({ success: true, data: vouchers });
  } catch (error) {
    console.error('Error fetching user vouchers:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};

export const getUserPointsHandler = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }
    const user = await findUserById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.status(200).json({ success: true, data: { points: user.points || 0 } });
  } catch (error) {
    console.error('Error fetching user points:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
};



// ------------- Admin functions --------------
export const listOffers = async (req, res) => {
  try {
    const { limit = 50, offset = 0, active, category, search } = req.query;
    const filters = {};
    if (active !== undefined) filters.active = active === 'true';
    if (category) filters.category = category;
    if (search) filters.search = search;

    const offers = await offerService.getAllOffersAdmin(filters, Number(limit), Number(offset));
    res.json({ success: true, data: offers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getOffer = async (req, res) => {
  try {
    const { id } = req.params;
    const offer = await offerService.getOfferByIdAdmin(id);
    res.json({ success: true, data: offer });
  } catch (error) {
    if (error.message === 'Offer not found') {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

export const createOffer = async (req, res) => {
  const redis = getRedis();
  try {
    const offerData = { ...req.body };

    // Required fields validation
    if (!offerData.title || !offerData.sub || !offerData.expiryDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: title, sub, expiryDate' 
      });
    }

    // Set defaults and ensure no undefined values
    const sanitized = {
      title: offerData.title,
      sub: offerData.sub,
      icon: offerData.icon || null,
      cta: offerData.cta || null,
      imageUrl: offerData.imageUrl || null,
      tint: offerData.tint || null,
      category: offerData.category || 'for_you',
      promoCode: offerData.promoCode || null,
      deepLink: offerData.deepLink || null,
      startDate: offerData.startDate || new Date().toISOString().slice(0, 19).replace('T', ' '),
      expiryDate: offerData.expiryDate,
      active: offerData.active !== undefined ? offerData.active : true,
      for_all: offerData.for_all !== undefined ? offerData.for_all : false,
      // Handle JSON fields
      applicableTiers: offerData.applicableTiers ? 
        (typeof offerData.applicableTiers === 'string' ? offerData.applicableTiers : JSON.stringify(offerData.applicableTiers)) 
        : null,
      applicableLocations: offerData.applicableLocations ? 
        (typeof offerData.applicableLocations === 'string' ? offerData.applicableLocations : JSON.stringify(offerData.applicableLocations)) 
        : null,
      user_segment: offerData.user_segment ? 
        (typeof offerData.user_segment === 'string' ? offerData.user_segment : JSON.stringify(offerData.user_segment)) 
        : null,
      user_id: offerData.user_id || null,
      max_uses_per_user: offerData.max_uses_per_user !== undefined ? offerData.max_uses_per_user : null,
      max_uses_total: offerData.max_uses_total !== undefined ? offerData.max_uses_total : null,
      discount_type: offerData.discount_type || 'percentage',
      discount_value: offerData.discount_value !== undefined ? offerData.discount_value : 0,
      applicable_ride_type: offerData.applicable_ride_type || null,
    };

    const id = await offerService.createNewOffer(sanitized);
     // Invalidate Redis cache for all offers
    try {
      const cacheKey = 'offers:all';
      await redis.del(cacheKey); // assuming redisClient is available
      // Optionally, you can also delete other related cache keys (e.g., 'offers:active', 'offers:user:*')
    } catch (cacheError) {
      // Log cache error but don't fail the request
      console.error('Failed to invalidate Redis cache:', cacheError);
    }
    res.status(201).json({ success: true, data: { id } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

export const updateOffer = async (req, res) => {
  const redis = getRedis();
  try {
    const { id } = req.params;
    const offerData = req.body;

    // Helper to convert undefined to null, and stringify JSON fields
    const sanitizeField = (value) => (value === undefined ? null : value);
    const sanitizeJSON = (value) => {
      if (value === undefined) return null;
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    };

    const sanitized = {
      title: sanitizeField(offerData.title),
      sub: sanitizeField(offerData.sub),
      icon: sanitizeField(offerData.icon),
      cta: sanitizeField(offerData.cta),
      imageUrl: sanitizeField(offerData.imageUrl),
      tint: sanitizeField(offerData.tint),
      category: sanitizeField(offerData.category),
      promoCode: sanitizeField(offerData.promoCode),
      deepLink: sanitizeField(offerData.deepLink),
      startDate: sanitizeField(offerData.startDate),
      expiryDate: sanitizeField(offerData.expiryDate),
      active: sanitizeField(offerData.active),
      for_all: sanitizeField(offerData.for_all),
      applicableTiers: sanitizeJSON(offerData.applicableTiers),
      applicableLocations: sanitizeJSON(offerData.applicableLocations),
      user_segment: sanitizeJSON(offerData.user_segment),
      user_id: sanitizeField(offerData.user_id),
      max_uses_per_user: sanitizeField(offerData.max_uses_per_user),
      max_uses_total: sanitizeField(offerData.max_uses_total),
      discount_type: sanitizeField(offerData.discount_type),
      discount_value: sanitizeField(offerData.discount_value),
      applicable_ride_type: sanitizeField(offerData.applicable_ride_type),
    };

    await offerService.updateExistingOffer(id, sanitized);
    try {
        const cacheKey = 'offers:all';
        await redis.del(cacheKey); // assuming redisClient is available
        // Optionally, you can also delete other related cache keys (e.g., 'offers:active', 'offers:user:*')
      } catch (cacheError) {
        // Log cache error but don't fail the request
        console.error('Failed to invalidate Redis cache:', cacheError);
      }

    res.json({ success: true });
  } catch (error) {
    if (error.message === 'Offer not found') {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(400).json({ success: false, error: error.message });
  }
};

export const deleteOffer = async (req, res) => {
  const redis = getRedis();
  try {
    const { id } = req.params;
    await offerService.removeOffer(id);
    // delete from Redis cache
    await redis.del(`offers:all`);
    res.json({ success: true });
  } catch (error) {
    if (error.message === 'Offer not found') {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

export const toggleActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body; // boolean
    if (typeof active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'active must be a boolean' });
    }
    await offerService.setOfferActive(id, active);
    res.json({ success: true });
  } catch (error) {
    if (error.message === 'Offer not found') {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

export const listRedemptions = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const redemptions = await offerService.getRedemptionsForOffer(id, Number(limit), Number(offset));
    res.json({ success: true, data: redemptions });
  } catch (error) {
    if (error.message === 'Offer not found') {
      return res.status(404).json({ success: false, error: 'Offer not found' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};