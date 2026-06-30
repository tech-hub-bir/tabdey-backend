const { prisma } = require("../lib/prisma.js");

class UserModel {
  /**
   * Check if user exists by email
   * @param {string} email - Normalized email address
   * @returns {Promise<object|null>} User object or null
   */
  static async findUserByEmail(email) {
    try {
      const user = await prisma.users.findFirst({
        where: { email: email },
        select: { user_id: true, user_name: true, email: true, role: true },
      });
      return user;
    } catch (error) {
      console.error("Error finding user by email:", error);
      throw error;
    }
  }

  /**
   * Create a new user
   * @param {object} userData - User data to insert
   * @returns {Promise<object>} Created user
   */
  static async createUser(userData) {
    try {
      const newUser = await prisma.users.create({
        data: userData,
        select: { user_id: true, user_name: true, email: true },
      });
      return newUser;
    } catch (error) {
      console.error("Error creating user:", error);
      throw error;
    }
  }

  /**
   * Update user by email
   * @param {string} email - User email
   * @param {object} updateData - Data to update
   * @returns {Promise<object>} Updated user
   */
  static async updateUserByEmail(email, updateData) {
    try {
      const updatedUser = await prisma.users.update({
        where: { email: email },
        data: updateData,
        select: { user_id: true, user_name: true, email: true },
      });
      return updatedUser;
    } catch (error) {
      console.error("Error updating user:", error);
      throw error;
    }
  }

  /**
   * Get user by ID
   * @param {number} userId - User ID
   * @returns {Promise<object|null>} User object or null
   */
  static async findUserById(userId) {
    try {
      const user = await prisma.users.findUnique({
        where: { user_id: userId },
        select: {
          user_id: true,
          user_name: true,
          email: true,
          phone: true,
          role: true,
          is_verified: true,
          is_active: true,
        },
      });
      return user;
    } catch (error) {
      console.error("Error finding user by ID:", error);
      throw error;
    }
  }

  // ========== NEW METHODS FOR FORGOT PASSWORD ==========

  /**
   * Find user by phone with multiple candidate formats
   * @param {string} inputPhone - Raw phone input
   * @returns {Promise<object|null>} User object or null
   */
  static async findUserByPhoneCandidates(inputPhone) {
    try {
      const candidates = this.buildLookupCandidates(inputPhone);
      if (!candidates.length) return null;

      for (const candidate of candidates) {
        const found = await prisma.users.findFirst({
          where: { phone: candidate },
          select: { user_id: true, role: true, phone: true, user_name: true },
        });

        if (found) return found;
      }

      return null;
    } catch (error) {
      console.error("Error finding user by phone candidates:", error);
      throw error;
    }
  }

  /**
   * Find user and get gateway phone number
   * @param {string} inputPhone - Raw phone input
   * @returns {Promise<object>} { user, gatewayPhone }
   */
  static async findUserWithGatewayPhone(inputPhone) {
    try {
      const user = await this.findUserByPhoneCandidates(inputPhone);

      if (!user) return { user: null, gatewayPhone: null };

      const candidates = this.buildLookupCandidates(inputPhone);
      const stored = user.phone || "";
      const gatewayPhone =
        this.normalizeForGateway(stored) ||
        this.normalizeForGateway(candidates[0]);

      return { user, gatewayPhone };
    } catch (error) {
      console.error("Error finding user with gateway phone:", error);
      throw error;
    }
  }

  /**
   * Update user password by ID
   * @param {number} userId - User ID
   * @param {string} hashedPassword - New hashed password
   * @returns {Promise<object>} Updated user
   */
  static async updatePasswordById(userId, hashedPassword) {
    try {
      const updatedUser = await prisma.users.update({
        where: { user_id: userId },
        data: { password_hash: hashedPassword },
      });
      return updatedUser;
    } catch (error) {
      console.error("Error updating password by ID:", error);
      throw error;
    }
  }

  /**
   * Update user password by email
   * @param {string} email - User email
   * @param {string} hashedPassword - New hashed password
   * @returns {Promise<object>} Updated user
   */
  static async updatePasswordByEmail(email, hashedPassword) {
    try {
      const updatedUser = await prisma.users.update({
        where: { email: email },
        data: { password_hash: hashedPassword },
      });
      return updatedUser;
    } catch (error) {
      console.error("Error updating password by email:", error);
      throw error;
    }
  }

  /**
   * Build lookup candidates for phone numbers
   * @param {string} input - Raw phone input
   * @returns {Array} Array of phone candidates
   */
  static buildLookupCandidates(input) {
    const raw = String(input || "").trim();
    if (!raw) return [];

    const digits = raw.replace(/[^\d]/g, "");
    const candidates = new Set();

    candidates.add(raw);
    if (digits) candidates.add(digits);
    if (digits.length === 8) candidates.add(`975${digits}`);

    return Array.from(candidates).filter(Boolean);
  }

  /**
   * Normalize phone for gateway
   * @param {string} phoneFromDbOrMatch - Phone from DB or match
   * @returns {string|null} Normalized phone
   */
  static normalizeForGateway(phoneFromDbOrMatch) {
    const raw = String(phoneFromDbOrMatch || "").trim();
    const digits = raw.replace(/[^\d]/g, "");

    if (digits.length === 8) return `975${digits}`;
    if (digits.length === 11 && digits.startsWith("975")) return digits;

    return null;
  }
}

module.exports = UserModel;
