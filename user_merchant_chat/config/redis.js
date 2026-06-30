const Redis = require("ioredis");

function ts() {
  return new Date().toISOString();
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("connect", () => log("[redis] connected"));
redis.on("ready", () => log("[redis] ready"));
redis.on("reconnecting", () => log("[redis] reconnecting"));
redis.on("error", (e) => log("[redis] error:", e.message));

module.exports = redis;
