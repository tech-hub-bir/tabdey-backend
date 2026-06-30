const jwt = require('jsonwebtoken');

// Superapp tokens use `user_id`; events-module tokens use `id` — normalise both
function normaliseUser(decoded) {
  return {
    ...decoded,
    id: decoded.id ?? decoded.user_id,
    name: decoded.name ?? decoded.user_name,
  };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.user = normaliseUser(decoded);
    console.log('[auth] Token valid — user:', req.user.id, req.user.email);
    next();
  } catch (err) {
    console.log('[auth] Token invalid —', err.message);
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      req.user = normaliseUser(decoded);
      console.log('[auth] Token valid (optional) — user:', req.user.id, req.user.email);
    } catch (err) {
      console.log('[auth] Token invalid (optional) —', err.message);
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
