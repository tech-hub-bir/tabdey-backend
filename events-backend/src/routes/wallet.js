const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const walletApi = require('../services/walletApi');

// GET /wallet/balance
router.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const data = await walletApi.getWalletByUser(req.user.id);
    res.json({
      success: true,
      data: {
        wallet_id: data.data.wallet_id,
        balance: parseFloat(data.data.amount),
        status: data.data.status,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /wallet/transactions
router.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const { limit, cursor, start, end, direction } = req.query;
    const data = await walletApi.getUserTransactions(req.user.id, { limit, cursor, start, end, direction });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
