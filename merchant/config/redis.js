// config/redis.js
const Redis = require("ioredis");

let redis;

/**
 * Singleton Redis client.
 * Uses REDIS_URL=redis://:password@host:6379[/db]
 */
function getRedis() {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL missing in environment");
    }

    redis = new Redis(url, {
      maxRetriesPerRequest: null,
    });

    redis.on("connect", () => {
      console.log(
        "✅ Redis connected:",
        redis.options.host,
        redis.options.port
      );
    });

    redis.on("error", (err) => {
      console.error("❌ Redis error:", err?.message || err);
    });
  }
  return redis;
}

module.exports = { getRedis };
