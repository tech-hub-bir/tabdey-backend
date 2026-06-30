// utils/time.js
/**
 * Convert potential JS Date into a Bhutan local time string.
 * If value is already a string (because of dateStrings: true), return as-is.
 */
function toThimphuString(val) {
  if (!val) return val;
  if (typeof val === "string") return val; // already "YYYY-MM-DD HH:mm:ss"
  if (val instanceof Date) {
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Thimphu",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(val); // "YYYY-MM-DD, HH:MM:SS"
    return s.replace(",", "");
  }
  return val;
}

module.exports = { toThimphuString };
