// config/redis.js
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL, {
  retryStrategy(times) {
    // 1s, 2s, 4s, ... up to 30s
    const delay = Math.min(times * 1000 * 2, 30000);
    console.warn(`Redis reconnect in ${delay}ms (attempt ${times})`);
    return delay;
  },
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

// -------- Heartbeat to keep the connection "active" --------
// This helps when some firewall/NAT drops "idle" TCP connections.
setInterval(() => {
  redis.ping().catch(() => {
    // ignore errors here, reconnectStrategy will handle real disconnects
  });
}, 30000); // every 30 seconds

redis.on("connect", () => console.log("Redis connected"));
redis.on("ready", () => console.log("Redis ready"));
redis.on("reconnecting", () => console.log("Redis reconnecting..."));
redis.on("close", () => console.log("Redis connection closed"));
redis.on("error", (err) => {
  if (err.code === "ECONNRESET") {
    console.warn(
      "Redis connection reset by peer (ECONNRESET) – will reconnect."
    );
    return;
  }
  console.error("Redis error:", err);
});

module.exports = redis;
