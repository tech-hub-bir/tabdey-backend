const redis = require("./redisClient");

class OtpModel {
  /**
   * Store OTP in Redis
   * @param {string} email - User email
   * @param {string} otp - OTP code
   * @param {number} expiry - Expiry time in seconds (default: 300)
   * @returns {Promise<void>}
   */
  static async storeOtp(email, otp, expiry = 300) {
    try {
      await redis.set(`otp:${email}`, otp, { ex: expiry });
    } catch (error) {
      console.error("Error storing OTP:", error);
      throw error;
    }
  }

  /**
   * Get stored OTP from Redis
   * @param {string} email - User email
   * @returns {Promise<string|null>} Stored OTP or null
   */
  static async getOtp(email) {
    try {
      const otp = await redis.get(`otp:${email}`);
      return otp;
    } catch (error) {
      console.error("Error getting OTP:", error);
      throw error;
    }
  }

  /**
   * Delete OTP from Redis
   * @param {string} email - User email
   * @returns {Promise<void>}
   */
  static async deleteOtp(email) {
    try {
      await redis.del(`otp:${email}`);
    } catch (error) {
      console.error("Error deleting OTP:", error);
      throw error;
    }
  }

  /**
   * Store verification flag
   * @param {string} email - User email
   * @param {number} expiry - Expiry time in seconds (default: 900)
   * @returns {Promise<void>}
   */
  static async storeVerifiedFlag(email, expiry = 900) {
    try {
      await redis.set(`verified:${email}`, "true", { ex: expiry });
    } catch (error) {
      console.error("Error storing verified flag:", error);
      throw error;
    }
  }

  /**
   * Get verification flag
   * @param {string} email - User email
   * @returns {Promise<string|null>} Verification flag or null
   */
  static async getVerifiedFlag(email) {
    try {
      const flag = await redis.get(`verified:${email}`);
      return flag;
    } catch (error) {
      console.error("Error getting verified flag:", error);
      throw error;
    }
  }

  /**
   * Delete verification flag
   * @param {string} email - User email
   * @returns {Promise<void>}
   */
  static async deleteVerifiedFlag(email) {
    try {
      await redis.del(`verified:${email}`);
    } catch (error) {
      console.error("Error deleting verified flag:", error);
      throw error;
    }
  }

  /**
   * Generate OTP
   * @returns {string} 6-digit OTP
   */
  static generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}

module.exports = OtpModel;
