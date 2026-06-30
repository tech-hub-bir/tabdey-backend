const router = require('express').Router();
const { requireAuth, optionalAuth } = require('../middleware/auth');
const c = require('../controllers/screenings');

// Nested under events
router.get('/:eventId/screenings', optionalAuth, c.listScreenings);

// Standalone screening routes
router.get('/:id',             optionalAuth, c.getScreening);
router.get('/:id/seats',       optionalAuth, c.getSeats);
router.post('/:id/seats/hold', requireAuth,  c.holdSeats);
router.delete('/:id/seats/hold', requireAuth, c.releaseHold);

module.exports = router;
