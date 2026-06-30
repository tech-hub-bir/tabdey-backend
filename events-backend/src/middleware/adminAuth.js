const { requireAuth } = require('./auth');

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!['admin', 'super admin', 'organizer', 'finance'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden: insufficient role' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
