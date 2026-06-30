// routes/appRatingRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const authUser = require("../middleware/auth");

const {
  createAppRatingController,
  listAppRatingsController,
  getAppRatingByIdController,
  updateAppRatingController,
  deleteAppRatingController,
  getAppRatingSummaryController,

  listReportedCommentsController,
  listReportedRepliesController,
  ignoreReportController,
  deleteReportedCommentController,
  deleteReportedReplyController,
} = require("../controllers/appRatingController");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const readLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 180,
  message: "Too many requests. Please slow down.",
});

const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

const reportLimiter = makeLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 200, // admin actions; tune down if needed
  message: "Too many report actions. Please try again later.",
});

const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

const validateReportIdParam = (req, res, next) => {
  const id = Number(req.params.report_id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid report_id" });
};

// Create new app rating
router.post("/", writeLimiter, createAppRatingController);

// List ratings
router.get("/", listAppRatingsController);

// Summary stats
router.get("/summary", getAppRatingSummaryController);

// Reports (admin)
router.get("/reports/comments", authUser, listReportedCommentsController);
router.get("/reports/replies", authUser, listReportedRepliesController);

router.post(
  "/reports/:report_id/ignore",
  authUser,
  reportLimiter,
  validateReportIdParam,
  ignoreReportController,
);

router.delete(
  "/reports/:report_id/comment",
  authUser,
  reportLimiter,
  validateReportIdParam,
  deleteReportedCommentController,
);

router.delete(
  "/reports/:report_id/reply",
  authUser,
  reportLimiter,
  validateReportIdParam,
  deleteReportedReplyController,
);

// Get single rating
router.get("/:id", validateIdParam, getAppRatingByIdController);

// Update rating (admin)
router.put(
  "/:id",
  authUser,
  writeLimiter,
  validateIdParam,
  updateAppRatingController,
);

// Delete rating (admin)
router.delete(
  "/:id",
  authUser,
  writeLimiter,
  validateIdParam,
  deleteAppRatingController,
);

module.exports = router;
