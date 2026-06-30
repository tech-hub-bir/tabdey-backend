// src/routes/admin/offerRoutes.js
import express from 'express';
import { isAdmin } from '../../middleware/admin.js';         // admin check
import * as adminOfferController from '../../controllers/offerController.js'; // admin controller

const router = express.Router();

// All admin routes require authentication + admin privileges
// router.use(authenticateToken, isAdmin);

// GET /admin/offers?active=true&category=for_you&search=premium
router.get('/', adminOfferController.listOffers);

// POST /admin/offers
router.post('/', adminOfferController.createOffer);

// GET /admin/offers/:id
router.get('/:id', adminOfferController.getOffer);

// PUT /admin/offers/:id
router.put('/:id', adminOfferController.updateOffer);

// DELETE /admin/offers/:id
router.delete('/:id', adminOfferController.deleteOffer);

// PATCH /admin/offers/:id/toggle  (body: { active: true/false })
router.patch('/:id/toggle', adminOfferController.toggleActive);

// GET /admin/offers/:id/redemptions?limit=50&offset=0
router.get('/:id/redemptions', adminOfferController.listRedemptions);

export default router;