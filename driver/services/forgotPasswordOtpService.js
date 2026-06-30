const redisClient = require("../models/redisClient");

class ForgotPasswordOtpService {
  /**
   * Generate 6-digit OTP
   * @returns {string} 6-digit OTP
   */
  static generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // ========== SMS OTP Methods ==========

  /**
   * Store SMS OTP
   * @param {string} phone - Phone number
   * @param {string} otp - OTP code
   * @param {number} expiry - Expiry in seconds (default: 300)
   * @returns {Promise<void>}
   */
  static async storeSmsOtp(phone, otp, expiry = 300) {
    const otpKey = `fp_sms_otp:${phone}`;
    await redisClient.set(otpKey, otp, { ex: expiry });
  }

  /**
   * Get stored SMS OTP
   * @param {string} phone - Phone number
   * @returns {Promise<string|null>} Stored OTP or null
   */
  static async getSmsOtp(phone) {
    const otpKey = `fp_sms_otp:${phone}`;
    return await redisClient.get(otpKey);
  }

  /**
   * Delete SMS OTP
   * @param {string} phone - Phone number
   * @returns {Promise<void>}
   */
  static async deleteSmsOtp(phone) {
    const otpKey = `fp_sms_otp:${phone}`;
    await redisClient.del(otpKey);
  }

  /**
   * Store SMS verified flag
   * @param {string} phone - Phone number
   * @param {number} expiry - Expiry in seconds (default: 900)
   * @returns {Promise<void>}
   */
  static async storeSmsVerifiedFlag(phone, expiry = 900) {
    const verifiedKey = `fp_sms_verified:${phone}`;
    await redisClient.set(verifiedKey, "true", { ex: expiry });
  }

  /**
   * Get SMS verified flag
   * @param {string} phone - Phone number
   * @returns {Promise<string|null>} Verified flag or null
   */
  static async getSmsVerifiedFlag(phone) {
    const verifiedKey = `fp_sms_verified:${phone}`;
    return await redisClient.get(verifiedKey);
  }

  /**
   * Delete SMS verified flag
   * @param {string} phone - Phone number
   * @returns {Promise<void>}
   */
  static async deleteSmsVerifiedFlag(phone) {
    const verifiedKey = `fp_sms_verified:${phone}`;
    await redisClient.del(verifiedKey);
  }

  /**
   * Check SMS rate limit
   * @param {string} phone - Phone number
   * @param {number} cooldownSeconds - Cooldown in seconds (default: 30)
   * @returns {Promise<boolean>} True if rate limited
   */
  static async checkSmsRateLimit(phone, cooldownSeconds = 30) {
    const rlKey = `fp_sms_rl:${phone}`;
    const exists = await redisClient.get(rlKey);
    return !!exists;
  }

  /**
   * Set SMS rate limit
   * @param {string} phone - Phone number
   * @param {number} cooldownSeconds - Cooldown in seconds (default: 30)
   * @returns {Promise<void>}
   */
  static async setSmsRateLimit(phone, cooldownSeconds = 30) {
    const rlKey = `fp_sms_rl:${phone}`;
    await redisClient.set(rlKey, "1", { ex: cooldownSeconds });
  }

  // ========== Email OTP Methods ==========

  /**
   * Store email OTP
   * @param {string} email - Email address
   * @param {string} otp - OTP code
   * @param {number} expiry - Expiry in seconds (default: 300)
   * @returns {Promise<void>}
   */
  static async storeEmailOtp(email, otp, expiry = 300) {
    const otpKey = `fp_email_otp:${email}`;
    await redisClient.set(otpKey, otp, { ex: expiry });
  }

  /**
   * Get stored email OTP
   * @param {string} email - Email address
   * @returns {Promise<string|null>} Stored OTP or null
   */
  static async getEmailOtp(email) {
    const otpKey = `fp_email_otp:${email}`;
    return await redisClient.get(otpKey);
  }

  /**
   * Delete email OTP
   * @param {string} email - Email address
   * @returns {Promise<void>}
   */
  static async deleteEmailOtp(email) {
    const otpKey = `fp_email_otp:${email}`;
    await redisClient.del(otpKey);
  }

  /**
   * Store email verified flag
   * @param {string} email - Email address
   * @param {number} expiry - Expiry in seconds (default: 900)
   * @returns {Promise<void>}
   */
  static async storeEmailVerifiedFlag(email, expiry = 900) {
    const verifiedKey = `fp_email_verified:${email}`;
    await redisClient.set(verifiedKey, "true", { ex: expiry });
  }

  /**
   * Get email verified flag
   * @param {string} email - Email address
   * @returns {Promise<string|null>} Verified flag or null
   */
  static async getEmailVerifiedFlag(email) {
    const verifiedKey = `fp_email_verified:${email}`;
    return await redisClient.get(verifiedKey);
  }

  /**
   * Delete email verified flag
   * @param {string} email - Email address
   * @returns {Promise<void>}
   */
  static async deleteEmailVerifiedFlag(email) {
    const verifiedKey = `fp_email_verified:${email}`;
    await redisClient.del(verifiedKey);
  }

  /**
   * Check email rate limit
   * @param {string} email - Email address
   * @param {number} cooldownSeconds - Cooldown in seconds (default: 30)
   * @returns {Promise<boolean>} True if rate limited
   */
  static async checkEmailRateLimit(email, cooldownSeconds = 30) {
    const rlKey = `fp_email_rl:${email}`;
    const exists = await redisClient.get(rlKey);
    return !!exists;
  }

  /**
   * Set email rate limit
   * @param {string} email - Email address
   * @param {number} cooldownSeconds - Cooldown in seconds (default: 30)
   * @returns {Promise<void>}
   */
  static async setEmailRateLimit(email, cooldownSeconds = 30) {
    const rlKey = `fp_email_rl:${email}`;
    await redisClient.set(rlKey, "1", { ex: cooldownSeconds });
  }
}

module.exports = ForgotPasswordOtpService;
