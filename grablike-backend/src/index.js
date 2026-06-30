// src/index.js
import "dotenv/config.js"; // if this fails, change to: import "dotenv/config";
import path from "node:path"; // ⬅️ for static /uploads
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import mongoose from "mongoose";
import { startScheduledRidesWorker } from "./workers/scheduledRidesWorker.js";
import scheduledRoutes from "./routes/scheduledRides.routes.js";
import offerRoutes from './routes/offerRoutes.js';
import adminOfferRoutes from './routes/admin/offerRoutes.js';
import { makeReferralRouter } from "./routes/referralRoutes.js";

import matchRoutes from "./routes/match.routes.js";
import { makeDbOfferAdapter } from "./matching/dbOfferAdapter.js";

import { mysqlPool } from "./db/mysql.js";
import { initDriverSocket } from "./sockets/driver.js";
import { driverJobsRouter } from "./routes/driverJobs.js";
import { earningsRouter } from "./routes/earnings.js";
import { ratingsRouter } from "./routes/ratings.js";
import { ridesTypesRouter } from "./routes/rideTypes.js";

// ⬇️ matching (unchanged)
import { makeMatchingRouter } from "./routes/matching.js";
import { makeOfferAdapter } from "./services/offerAdapter.js";
import { configureMatcher } from "./matching/matcher.js";
import nearbyDriversApi from "./routes/nearbyDriversApi.js";
import makePassengerNearbyDriversRouter from "./routes/passengerNearbyDrivers.js";
import makeProfileImageRouter from "./routes/profileImage.js";
import locationsRouter from "./routes/locations.js";
import places from "./routes/places.js";
import makeDriverLookupRouter from "./routes/driverLookup.js";
import currentRidesRouter from "./routes/currentRides.js";
import tipsRouter from "./routes/tipsRouter.js";
import userDetailsLookup from "./routes/userDetails.js";
import rideGroupRoutes from "./routes/rideGroup.routes.js";
import guestWaypointsRouter from "./routes/guestWaypoints.routes.js";

// ⬇️ chat upload/list routes
import { makeChatUploadRouter } from "../src/routes/chatUpload.js";
import { makeChatListRouter } from "../src/routes/chatList.js";
import agoraRouter from "./routes/agora.js";
import driverDeliveryRoutes from "./routes/driverDelivery.js";
import  {getDeliveryRideId}  from "./routes/getDeliveryRideId.js";
import { getBatchAndRideId } from "./routes/getBatchId&RideId.js";


// tax and platform rules
import taxRulesRoutes from "./routes/taxRules.routes.js";
import platformFeeRulesRoutes from "./routes/platformFeeRules.route.js";
import pricingRoutes from "./routes/pricing.route.js";
import faresRoutes from "./routes/fares.route.js";
// finance routes
import financeRoutes from "./routes/finance.routes.js";
import refundRoutes from "./routes/refund.routes.js";
import driverSettlementRoutes from "./routes/drivers.settlement.routes.js";

import makeCustomerLookupRouter from "./routes/customerLookUp.js";
import makeMerchantLookupRouter from "./routes/merchantLookUp.js";

const app = express();

/* ============================= Middlewares ============================= */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

app.use(express.json({ limit: "10mb" })); // ✅ allow bigger payloads (chat/meta)

/** serve /uploads/* (for chat images & other assets) */
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(UPLOAD_ROOT));

/* ============================== Health ================================ */
app.get("/", (_req, res) => res.json({ ok: true }));

/* =============================== Routes =============================== */
app.use("/api/driver/jobs", driverJobsRouter(mysqlPool));
app.use("/api/driver", earningsRouter(mysqlPool));
app.use("/api", ratingsRouter(mysqlPool));
app.use("/api", nearbyDriversApi(mysqlPool));
app.use("/api", makePassengerNearbyDriversRouter(mysqlPool));
app.use("/api", makeProfileImageRouter());
app.use("/api", ridesTypesRouter);
app.use("/api/rides/locations", locationsRouter);
app.use("/api/places", places);
app.use("/api", makeDriverLookupRouter(mysqlPool));
app.use("/api", makeCustomerLookupRouter(mysqlPool));
app.use("/api", makeMerchantLookupRouter(mysqlPool));
app.use("/api/tips", tipsRouter(mysqlPool));
app.use("/api", userDetailsLookup(mysqlPool));
app.use("/driver/delivery", driverDeliveryRoutes);
app.use("/api/settlements", driverSettlementRoutes);
app.use("/api", rideGroupRoutes);
app.use("/api", guestWaypointsRouter(mysqlPool));
app.use('/api/offers', offerRoutes);
app.use('/admin/offers', adminOfferRoutes);
app.use('/api/referrals', makeReferralRouter(mysqlPool));


// tax and platform fee rules routes
app.use("/tax-rules", taxRulesRoutes);
app.use("/platform-fee-rules", platformFeeRulesRoutes);
app.use("/pricing", pricingRoutes);
app.use("/fares", faresRoutes);

// finance routes
app.use("/finance", financeRoutes);
app.use("/finance", refundRoutes);


app.use("/api/batch-ride", getBatchAndRideId());



// chat upload route
app.use("/chat", makeChatUploadRouter("/uploads"));
app.use("/api/agora", agoraRouter);

/* ========================= HTTP + Socket.IO =========================== */
const server = http.createServer(app);

// ✅ Smooth + stable Socket.IO config for mobile networks
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false,
  },

  // ✅ IMPORTANT: do not force websocket only; allow fallback
  transports: ["websocket", "polling"],

  // ✅ prevent "ping timeout" when server is busy (Node event-loop stalls)
  pingInterval: 25000,
  pingTimeout: 60000,

  // ✅ reduce CPU & latency spikes (especially on high-frequency events)
  perMessageDeflate: false,

  // ✅ if you send images/chat payloads through socket, avoid buffer errors
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB
});

// Optional: hydrate socket identity from handshake
// This won't override existing values.
io.use((socket, next) => {
  const a = socket.handshake.auth || socket.handshake.query || {};

  try {
    if (!socket.data.role && (a.role === "driver" || a.role === "passenger" || a.role === "merchant")) {
      socket.data.role = a.role;
    }
    if (socket.data.driver_id == null && a.driver_id != null) {
      socket.data.driver_id = String(a.driver_id);
    }
    if (socket.data.passenger_id == null && a.passenger_id != null) {
      socket.data.passenger_id = String(a.passenger_id);
    }
    if (socket.data.merchant_id == null && a.merchant_id != null) {
      socket.data.merchant_id = String(a.merchant_id);
    }
  } catch {}

  next();
});

// matcher setup (unchanged)
const adapter = {
  ...makeOfferAdapter(mysqlPool),       // your existing logic (if any)
  ...makeDbOfferAdapter({ mysqlPool }), // adds DB offer-state writes
};
configureMatcher(adapter);

// Make io accessible in controllers via req.app.get("io")
app.set("io", io);

// Attach sockets
initDriverSocket(io, mysqlPool);

// Mount routers that need `io` AFTER io is created
app.use("/rides/match", makeMatchingRouter(io, mysqlPool));
app.use("/rides", currentRidesRouter(mysqlPool));
app.use("/api", makeChatListRouter(mysqlPool));
app.use("/api/delivery", getDeliveryRideId);
app.use("/api/scheduled-rides", scheduledRoutes);

/* ============================ Mongo events ============================ */
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error", (err) =>
  console.error("❌ MongoDB connection error:", err)
);
mongoose.connection.on("disconnected", () =>
  console.warn("⚠ MongoDB disconnected")
);


/* ======================== Scheduled Rides Worker ====================== */
startScheduledRidesWorker({ io, mysqlPool, pollMs: 5000, batchSize: 25 });

/* ============================ MySQL check ============================= */
async function testMySQLConnection() {
  try {
    const conn = await mysqlPool.getConnection();
    await conn.ping();
    console.log("✅ MySQL connected");
    conn.release();
  } catch (err) {
    console.error("❌ MySQL connection failed:", err);
    process.exit(1);
  }
}

/* ============================== Startup =============================== */
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // For Mongoose v7+, these options are not required; harmless if left.
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    await testMySQLConnection();

    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`HTTP+WS listening on http://localhost:${PORT}`);
    });

    // Optional: graceful shutdown
    const shutdown = async (sig) => {
      console.log(`\n${sig} received — shutting down...`);
      try {
        await mongoose.disconnect();
      } catch {}
      try {
        server.close();
      } catch {}
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

startServer();
