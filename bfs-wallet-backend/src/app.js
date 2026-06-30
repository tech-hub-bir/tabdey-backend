const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const paymentRoutes = require("./routes/paymentRoutes");
const onlinePaymentRoutes = require("./routes/onlinePaymentRoutes");
const rmaLogRoutes = require("./routes/rmaLogRoutes");
const withdrawalsRoutes = require("./routes/withdrawals.routes.js");
const debugRoutes = require("./routes/debugRoutes");

const app = express();

app.use(helmet());

app.use(cors({
  origin: [
    'https://admin.tabdey.com', 'https://organizer.tabdey.com', 'https://status.tabdey.com',
    process.env.CORS_ORIGIN,
  ].filter(Boolean),
  credentials: true,
}));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.get("/", (req, res) => {
  res.json({ ok: true, message: "BFS wallet backend up" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
});

app.use("/api/wallet/topup", paymentRoutes);
app.use("/api/payment", onlinePaymentRoutes);
app.use("/api/rma", rmaLogRoutes);
app.use("/api", withdrawalsRoutes);
app.use("/api", debugRoutes);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || "Internal server error",
  });
});

module.exports = app;
