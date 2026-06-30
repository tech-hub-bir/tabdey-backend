const { getRedis } = require("../config/redis");

class CacheService {
  constructor() {
    this.redis = null;
    this.defaultTTL = 300; // 5 minutes
  }

  async getRedis() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this.redis;
  }

  async get(key) {
    try {
      const redis = await this.getRedis();
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error("Cache get error:", error.message);
      return null;
    }
  }

  async set(key, data, ttl = this.defaultTTL) {
    try {
      const redis = await this.getRedis();
      await redis.setex(key, ttl, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Cache set error:", error.message);
      return false;
    }
  }

  async del(key) {
    try {
      const redis = await this.getRedis();
      await redis.del(key);
      return true;
    } catch (error) {
      console.error("Cache del error:", error.message);
      return false;
    }
  }

  async clearPattern(pattern) {
    try {
      const redis = await this.getRedis();
      const keys = await redis.keys(pattern);
      if (keys.length) {
        await redis.del(keys);
        console.log(`🗑️ Cleared ${keys.length} cache keys matching: ${pattern}`);
      }
      return true;
    } catch (error) {
      console.error("Cache clearPattern error:", error.message);
      return false;
    }
  }
}

module.exports = new CacheService();