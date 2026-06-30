const { Redis } = require("@upstash/redis");

const redisClient = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Optional: Test connection
(async () => {
  try {
    await redisClient.set("healthcheck", "ok", { ex: 5 });
    console.log("✅ Upstash Redis is connected and working!");
  } catch (err) {
    console.error("❌ Redis connection failed:", err);
  }
})();

module.exports = redisClient;
