const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const c = require('../controllers/payments');

router.post('/bank/init',               requireAuth, c.initBankPayment);
router.post('/bank/account-enquiry',    requireAuth, c.accountEnquiry);
router.post('/bank/verify',             requireAuth, c.verifyOtp);
router.get('/bank/status/:orderNo',     requireAuth, c.checkStatus);

module.exports = router;
