const { transporter, from, isConfigured } = require("../config/mailer");

class EmailService {
  /**
   * Check if email service is configured
   * @returns {boolean}
   */
  static isConfigured() {
    return isConfigured && transporter && from;
  }

  /**
   * Send registration OTP email
   * @param {string} to - Recipient email
   * @param {string} otp - OTP code
   * @param {string} userName - User name (default: "Valued User")
   * @returns {Promise<object>} Email info
   */
  static async sendRegistrationOtp(to, otp, userName = "Valued User") {
    const disclaimer =
      "Disclaimer: Please do NOT share this OTP or your password with anyone. " +
      "TàbDey will never ask for your OTP, password, or T-PIN. " +
      "If you did not request this OTP, please ignore this email.";

    const subject = "Your OTP for Registration";

    const text =
      `Dear ${userName},\n\n` +
      `Welcome to TàbDey!\n\n` +
      `Your OTP is:\n\n` +
      `${otp}\n\n` +
      `This OTP is valid for 5 minutes and can only be used once.\n\n` +
      `${disclaimer}\n\n` +
      `Everything at your door step!\n` +
      `TàbDey`;

    const html =
      `<p>Dear ${userName},</p>` +
      `<p>Welcome to <b>TàbDey</b>!</p>` +
      `<p>Your OTP is:</p>` +
      `<h2 style="letter-spacing:4px;">${otp}</h2>` +
      `<p>This OTP is valid for <b>5 minutes</b> and can only be used once.</p>` +
      `<hr />` +
      `<p style="font-size:12px;color:#777;">${disclaimer}</p>` +
      `<p><b>Everything at your door step!</b><br/>TàbDey</p>`;

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });

    return info;
  }
}

module.exports = EmailService;
