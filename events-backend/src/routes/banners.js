const router = require('express').Router();
const { getBanners } = require('../controllers/banners');

router.get('/', getBanners);

module.exports = router;
