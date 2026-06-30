// src/middleware/admin.js

/**
 * Middleware to ensure the user is an admin.
 * Must be used after authentication middleware (e.g., authenticateToken).
 */
export const isAdmin = (req, res, next) => {
  // Check if user exists (set by previous auth middleware)
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
  }

  // Check admin status – adjust according to your user object
  const isUserAdmin = req.user.role === 'admin' || req.user.isAdmin === true;

  if (!isUserAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Admin privileges required.',
    });
  }

  next();
};