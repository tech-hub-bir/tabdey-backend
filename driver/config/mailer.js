// config/mailer.js
const nodemailer = require("nodemailer");

const {
  SMTP_HOST = "",
  SMTP_PORT = "587",
  SMTP_USER = "",
  SMTP_PASS = "",
  SMTP_FROM = "",
  SMTP_INSECURE_TLS = "false", // set true ONLY if your server has TLS cert-chain issues
} = process.env;

const host = String(SMTP_HOST).trim();
const port = Number(String(SMTP_PORT).trim() || 587);
const user = String(SMTP_USER).trim();
const pass = String(SMTP_PASS).trim();
const from =
  (SMTP_FROM && String(SMTP_FROM).trim()) ||
  (user ? `TàbDey <${user}>` : null);

const isConfigured = Boolean(host && user && pass);

const insecureTls = ["true", "1", "yes", "y"].includes(
  String(SMTP_INSECURE_TLS).toLowerCase()
);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 SSL, 587 STARTTLS
      auth: { user, pass },
      requireTLS: port === 587,
      logger: false,
      debug: false,
      ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
    })
  : null;

module.exports = { transporter, from, isConfigured };
