const router = require('express').Router();
const { requireAuth, optionalAuth } = require('../middleware/auth');
const eventsController = require('../controllers/events');
const reviewsController = require('../controllers/reviews');

router.get('/',    optionalAuth, eventsController.listEvents);
router.get('/live', optionalAuth, eventsController.getLiveEvent);
router.get('/:id', optionalAuth, eventsController.getEvent);

// Reviews
router.get('/:id/reviews',                       optionalAuth, reviewsController.getReviews);
router.post('/:id/reviews',                      requireAuth,  reviewsController.submitReview);
router.delete('/:id/reviews',                    requireAuth,  reviewsController.deleteReview);
router.post('/:id/reviews/:reviewId/helpful',    requireAuth,  reviewsController.toggleHelpful);

module.exports = router;
