/**
 * Normalize email address - trim and convert to lowercase
 * @param {string} email - Email address to normalize
 * @returns {string} Normalized email
 */
const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if email is valid
 */
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

module.exports = {
  normalizeEmail,
  isValidEmail,
};
