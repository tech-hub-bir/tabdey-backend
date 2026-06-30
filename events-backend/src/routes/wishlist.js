const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const wishlistController = require('../controllers/wishlist');

router.post('/toggle', requireAuth, wishlistController.toggle);
router.get('/', requireAuth, wishlistController.getWishlist);

module.exports = router;
