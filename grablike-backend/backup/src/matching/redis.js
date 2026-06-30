// src/matching/redis.js
import Redis from "ioredis";

let client;

export function getRedis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });

    client.on("connect", () => {
      console.log("✅ Redis connected");
    });

    client.on("error", (err) => {
      console.error("❌ Redis error:", err);
    });

    client.on("close", () => {
      console.warn("⚠ Redis connection closed");
    });
  }
  return client;
}

export default { getRedis };
