const router = require('express').Router({ mergeParams: true });
const { requireAuth, optionalAuth } = require('../middleware/auth');
const seatsController = require('../controllers/seats');

router.get('/halls',         optionalAuth, seatsController.getHalls);
router.get('/seats',         optionalAuth, seatsController.getSeats);
router.post('/seats/hold',   requireAuth,  seatsController.holdSeats);
router.delete('/seats/hold', requireAuth,  seatsController.releaseHold);

module.exports = router;
