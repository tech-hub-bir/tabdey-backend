// realtime/index.js
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("events");
const db = require("../config/db"); // ✅ needed for DB INSERTS

let io = null;
const events = new EventEmitter();
events.setMaxListeners(0);

/* ------------ room helpers ------------ */
const roomUser = (id) => `user:${id}`;
const roomBusiness = (bid) => `business:${bid}`;

/* ------------ presence ------------ */
function isBusinessOnline(business_id) {
  if (!io) return false;
  const set = io.sockets.adapter.rooms.get(roomBusiness(business_id));
  return !!(set && set.size > 0);
}

/* ------------ attach server ------------ */
async function attachRealtime(server) {
  io = new Server(server, {
    transports: ["websocket"],
    cors: { origin: true, credentials: true },
    path: "/socket.io",
  });

  const DEV_NOAUTH = true;

  io.use((socket, next) => {
    try {
      if (DEV_NOAUTH) {
        const devUserId = Number(socket.handshake.auth?.devUserId || 0);
        const devRole = String(socket.handshake.auth?.devRole || "");
        if (devUserId && (devRole === "user" || devRole === "merchant")) {
          socket.user = { user_id: devUserId, role: devRole };
          return next();
        }
        return next(new Error("dev no-auth: provide devUserId & devRole"));
      }
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers["x-access-token"];
      if (!token) return next(new Error("no token"));
      const p = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      socket.user = { user_id: p.user_id, role: p.role };
      next();
    } catch {
      next(new Error("auth failed"));
    }
  });

  io.on("connection", async (socket) => {
    const { user_id, role } = socket.user || {};
    if (!user_id) return socket.disconnect(true);

    // user room
    socket.join(roomUser(user_id));

    // merchants join business rooms
    if (role === "merchant") {
      const auth = socket.handshake.auth || {};
      let bids = [];
      if (Array.isArray(auth.business_ids))
        bids = auth.business_ids.map(Number);
      else if (auth.business_id != null) bids = [Number(auth.business_id)];
      // backward compat, if old clients still send "merchantId"
      else if (auth.merchantId != null) bids = [Number(auth.merchantId)];

      bids = bids.filter((b) => Number.isFinite(b) && b > 0);
      bids.forEach((bid) => socket.join(roomBusiness(bid)));

      socket.on("business:notify:delivered", () => {}); // placeholder
    }

    // optional per-order room
    socket.on("order:join", ({ orderId }) => {
      if (orderId) socket.join(`order:${orderId}`);
    });
  });
}

/* ------------ NOTIFY: insert row + emit ------------ */
/**
 * Inserts a row into `order_notification` (business_id keyed) and emits.
 * Required fields: business_id, user_id, order_id, type, title, body_preview
 */
async function insertAndEmitNotification({
  business_id,
  user_id,
  order_id,
  title,
  body_preview,
  type = "order:create",
  totals = null,
}) {
  if (
    !business_id ||
    !user_id ||
    !order_id ||
    !type ||
    !title ||
    !body_preview
  ) {
    throw new Error("insertAndEmitNotification: missing required fields");
  }

  const notification_id = randomUUID();

  // ✅ DB INSERT
  await db.query(
    `
    INSERT INTO order_notification
      (notification_id, order_id, business_id, user_id, type, title, body_preview)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
    `,
    [notification_id, order_id, business_id, user_id, type, title, body_preview]
  );

  // Emit (non-critical)
  try {
    const room = roomBusiness(business_id);
    const listening = io?.sockets?.adapter?.rooms?.get(room)?.size > 0;
    if (listening) {
      io.to(room).emit("notify", {
        id: notification_id,
        type,
        orderId: order_id,
        business_id,
        createdAt: Date.now(),
        data: {
          title,
          body: body_preview,
          totals: totals
            ? {
                items_subtotal: totals.items_subtotal ?? null,
                platform_fee_total: totals.platform_fee_total ?? null,
                delivery_fee_total: totals.delivery_fee_total ?? null,
                discount_amount: totals.discount_amount ?? null,
                total_amount: totals.total_amount ?? null,
              }
            : null,
        },
      });
    }
  } catch (e) {
    console.warn("[notify emit warn]", e?.message);
  }

  return { notification_id };
}

/* ------------ STATUS BROADCAST ------------ */
function broadcastOrderStatusToMany({
  order_id,
  user_id,
  business_ids = [],
  status,
}) {
  const ev = {
    id: randomUUID(),
    type: "order:status",
    orderId: order_id,
    createdAt: Date.now(),
    data: { status },
  };

  // per-order room
  io?.to?.(`order:${order_id}`)?.emit?.("order:status", ev);

  // user room
  if (io && user_id) {
    const set = io.sockets.adapter.rooms.get(roomUser(user_id));
    if (set?.size) io.to(roomUser(user_id)).emit("order:status", ev);
  }

  // business rooms
  if (io) {
    const bids = Array.isArray(business_ids) ? business_ids : [business_ids];
    for (const bid of bids) {
      const set = io.sockets.adapter.rooms.get(roomBusiness(bid));
      if (set?.size) io.to(roomBusiness(bid)).emit("order:status", ev);
    }
  }
}

module.exports = {
  attachRealtime,
  insertAndEmitNotification, // ✅ writes to DB now
  broadcastOrderStatusToMany,
  events,
  // exporting helpers for tests if needed
  roomUser,
  roomBusiness,
  isBusinessOnline,
};
