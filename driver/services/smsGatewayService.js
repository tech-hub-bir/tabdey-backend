/* ---------------- fetch (Node 18+ has global fetch) ---------------- */
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

class SmsGatewayService {
  constructor() {
    this.SMS_URL = process.env.SMS_URL;
    this.SMS_MASTER_KEY = (process.env.SMS_MASTER_KEY || "").trim();
    this.SMS_FROM = process.env.SMS_FROM?.trim() || "";
  }

  /**
   * Send SMS via gateway
   * @param {object} params - { to, text, from }
   * @returns {Promise<string>} Gateway response
   */
  async sendSms({ to, text, from }) {
    if (!this.SMS_MASTER_KEY) {
      throw new Error("SMS_MASTER_KEY missing in .env");
    }

    if (!this.SMS_URL) {
      throw new Error("SMS_URL missing in .env");
    }

    const resp = await fetchFn(this.SMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.SMS_MASTER_KEY,
      },
      body: JSON.stringify({ to, text, from }),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
    }

    return bodyText;
  }

  /**
   * Send password reset OTP SMS
   * @param {string} phone - Phone number
   * @param {string} otp - OTP code
   * @returns {Promise<string>} Gateway response
   */
  async sendPasswordResetOtp(phone, otp) {
    const text =
      `Password reset code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    return await this.sendSms({
      to: phone,
      text,
      from: this.SMS_FROM,
    });
  }

  /**
   * Send registration OTP SMS
   * @param {string} phone - Phone number
   * @param {string} otp - OTP code
   * @returns {Promise<string>} Gateway response
   */
  async sendRegistrationOtp(phone, otp) {
    const text =
      `Registration Verification code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    return await this.sendSms({
      to: phone,
      text,
      from: this.SMS_FROM,
    });
  }

  /**
   * Send custom SMS
   * @param {string} phone - Phone number
   * @param {string} message - Custom message
   * @returns {Promise<string>} Gateway response
   */
  async sendCustomSms(phone, message) {
    return await this.sendSms({
      to: phone,
      text: message,
      from: this.SMS_FROM,
    });
  }
}

// Export singleton instance
module.exports = new SmsGatewayService();
