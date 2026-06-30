// src/routes/offerRoutes.js
import express from 'express';
import {
  getOffers,
  getOfferByIdHandler,
  getUserVouchersHandler,
  getUserPointsHandler
} from '../controllers/offerController.js';

const router = express.Router();

// GET /api/offers?category=for_you&userId=123&city=Thimphu
router.get('/', getOffers);

// GET /api/offers/:id
router.get('/:id', getOfferByIdHandler);

// GET /api/offers/user/vouchers?userId=123
router.get('/user/vouchers', getUserVouchersHandler);

// GET /api/offers/user/points?userId=123
router.get('/user/points', getUserPointsHandler);

export default router;