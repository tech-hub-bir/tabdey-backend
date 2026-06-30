const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

const eventsCtrl      = require('../controllers/admin/events');
const tiersCtrl       = require('../controllers/admin/tiers');
const screeningsCtrl  = require('../controllers/admin/screenings');
const hallsCtrl       = require('../controllers/admin/halls');
const bookingsCtrl    = require('../controllers/admin/bookings');
const revenueCtrl     = require('../controllers/admin/revenue');
const bannersCtrl     = require('../controllers/admin/banners');
const reviewsCtrl     = require('../controllers/admin/reviews');
const organizersCtrl    = require('../controllers/admin/organizers');
const revenueShareCtrl  = require('../controllers/admin/revenueShare');

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/events',              eventsCtrl.listEvents);
router.post('/events',             eventsCtrl.createEvent);
router.patch('/events/:id',        eventsCtrl.updateEvent);
router.delete('/events/:id',       eventsCtrl.deleteEvent);
router.patch('/events/:id/live',   eventsCtrl.toggleLive);

// ── Ticket Tiers ──────────────────────────────────────────────────────────────
router.post('/events/:eventId/tiers',  tiersCtrl.createTier);
router.patch('/tiers/:tierId',         tiersCtrl.updateTier);
router.delete('/tiers/:tierId',        tiersCtrl.deleteTier);

// ── Screenings ────────────────────────────────────────────────────────────────
router.post('/events/:eventId/screenings',  screeningsCtrl.createScreening);
router.patch('/screenings/:id/cancel',      screeningsCtrl.cancelScreening);

// ── Halls & Seats ─────────────────────────────────────────────────────────────
router.get('/halls',               hallsCtrl.listHalls);
router.post('/halls',              hallsCtrl.createHall);
router.get('/halls/:id/seats',     hallsCtrl.listSeats);
router.post('/halls/:id/seats',    hallsCtrl.createSeats);
router.delete('/halls/:id/seats',  hallsCtrl.deleteRowSeats);

// ── Bookings ──────────────────────────────────────────────────────────────────
router.get('/bookings',            bookingsCtrl.listBookings);
router.get('/bookings/:id',        bookingsCtrl.getBooking);
router.delete('/bookings/:id',     bookingsCtrl.deleteBooking);

// ── Revenue ───────────────────────────────────────────────────────────────────
router.get('/revenue/summary',              revenueCtrl.getSummary);
router.get('/revenue/export',               revenueCtrl.exportRevenue);
router.get('/revenue/events/:id',           revenueCtrl.getEventRevenue);
router.get('/revenue/events/:id/export',    revenueCtrl.exportEventRevenue);
router.get('/revenue/payment-sessions',     revenueCtrl.getPaymentSessions);

// ── Banners ───────────────────────────────────────────────────────────────────
router.get('/banners',             bannersCtrl.listBanners);
router.post('/banners',            bannersCtrl.createBanner);
router.patch('/banners/:id',       bannersCtrl.updateBanner);
router.delete('/banners/:id',      bannersCtrl.deleteBanner);

// ── Reviews ───────────────────────────────────────────────────────────────────
router.get('/events/:eventId/reviews',  reviewsCtrl.listReviews);
router.delete('/reviews/:reviewId',     reviewsCtrl.deleteReview);

// ── Organizers ────────────────────────────────────────────────────────────────
router.get('/organizers',                             organizersCtrl.listOrganizers);
router.post('/organizers',                            organizersCtrl.createOrganizer);
router.delete('/organizers/:id',                      organizersCtrl.deleteOrganizer);
router.get('/organizers/:id/revenue',                 organizersCtrl.getOrganizerRevenue);
router.get('/organizers/:id/wallet',                  organizersCtrl.getOrganizerWallet);
router.get('/organizers/:id/wallet/transactions',     organizersCtrl.getOrganizerWalletTransactions);
router.get('/organizers/:id/revenue-share',           revenueShareCtrl.getRevenueShare);
router.put('/organizers/:id/revenue-share',           revenueShareCtrl.upsertRevenueShare);

module.exports = router;
