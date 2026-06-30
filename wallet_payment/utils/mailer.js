// utils/mailer.js
const nodemailer = require("nodemailer");

function maskWalletId(walletId) {
  const id = String(walletId || "");
  if (!id.startsWith("NET") || id.length < 5) return id;

  const prefix = "NET";
  const last2 = id.slice(-2);
  const maskedMiddle = "*".repeat(id.length - prefix.length - 2);
  return prefix + maskedMiddle + last2; // NET*****23
}

const host = String(process.env.SMTP_HOST || "").trim();
const port = Number(String(process.env.SMTP_PORT || "587").trim());
const user = String(process.env.SMTP_USER || "").trim();
const pass = String(process.env.SMTP_PASS || "").trim();
const from =
  (process.env.SMTP_FROM && String(process.env.SMTP_FROM).trim()) ||
  (user ? `No-Reply <${user}>` : "");

const isConfigured = Boolean(host && port && user && pass);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 SSL, 587 STARTTLS
      auth: { user, pass },
      requireTLS: port === 587,
      // keep same working behavior (helps in some server TLS setups)
      tls: { rejectUnauthorized: false, servername: host },
      logger: false,
      debug: false,
    })
  : null;

async function sendOtpEmail({ to, otp, userName, walletId, ttlMinutes = 5 }) {
  if (!isConfigured || !transporter) {
    throw new Error(
      "SMTP not configured. Check SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS"
    );
  }

  const email = String(to || "")
    .trim()
    .toLowerCase();
  if (!email) throw new Error("Recipient email is required");

  const name = String(userName || "Valued User").trim();
  const maskedWallet = maskWalletId(walletId);

  const otpStr = String(otp || "").trim();
  if (!otpStr) throw new Error("OTP is required");

  const disclaimer =
    "Disclaimer: Please do NOT share this OTP or your T-PIN with anyone. " +
    "Tab Dhey will never ask for your OTP, T-PIN, or password. " +
    "If you did not request a T-PIN reset, please ignore this email immediately.";

  const subject = "Your OTP for Wallet T-PIN Reset";

  const text = `
Dear ${name},

We received a request to reset the T-PIN for your wallet (${maskedWallet}).

Your OTP is: ${otpStr}

This OTP is valid for ${ttlMinutes} minutes and can only be used once.

${disclaimer}

Best Regards,
TàbDey
`.trim();

  const html = `
<p>Dear ${name},</p>
<p>We received a request to reset the T-PIN for your wallet: <b>${maskedWallet}</b>.</p>
<p>Your OTP is:</p>
<h2 style="letter-spacing:4px;">${otpStr}</h2>
<p>This OTP is valid for <b>${ttlMinutes} minutes</b> and can only be used once.</p>
<hr />
<p style="font-size:12px;color:#777;">${disclaimer}</p>
<p>Best Regards,<br />TàbDey "Everything at your door step!"</p>
`.trim();

  const info = await transporter.sendMail({
    from,
    to: email,
    subject,
    text,
    html,
  });

  // optional: if SMTP didn't accept recipient, throw
  if (!info?.accepted || info.accepted.length === 0) {
    throw new Error("SMTP did not accept recipient");
  }

  return {
    ok: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

module.exports = { sendOtpEmail };
