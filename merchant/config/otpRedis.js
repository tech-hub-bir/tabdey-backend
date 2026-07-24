const { Redis } = require("@upstash/redis");

// The driver service verifies OTPs and writes "verified_sms:{phone}" /
// "verified:{email}" flags into this same Upstash Redis (see
// driver/models/redisClient.js). Merchant's main Redis (config/redis.js) is a
// separate self-hosted instance used only for caching, so OTP-flag lookups
// need this dedicated client pointed at Upstash to actually see what driver
// wrote.
const otpRedis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = otpRedis;
