const nodemailer = require("nodemailer");
const { prisma } = require("../lib/prisma.js");

const {
  SMTP_HOST = "",
  SMTP_PORT = "587",
  SMTP_USER = "",
  SMTP_PASS = "",
  SMTP_FROM = "",
  SMTP_INSECURE_TLS = "false",
  EMAIL_CONCURRENCY = "10",

  BRAND_NAME = "TàbDey",
  SUPPORT_EMAIL = "",
  APP_URL = "",
  BRAND_COLOR = "#0b7a3b",
} = process.env;

const host = String(SMTP_HOST).trim();
const port = Number(String(SMTP_PORT).trim() || 587);
const user = String(SMTP_USER).trim();
const pass = String(SMTP_PASS).trim();

const from =
  (SMTP_FROM && String(SMTP_FROM).trim()) ||
  (user ? `${String(BRAND_NAME || "TàbDey").trim()} <${user}>` : "");

const insecureTls = ["true", "1", "yes", "y"].includes(
  String(SMTP_INSECURE_TLS).trim().toLowerCase(),
);

const isConfigured = Boolean(host && user && pass);

const transporter = isConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      requireTLS: port === 587,
      pool: true,
      maxConnections: 5,
      maxMessages: Infinity,
      ...(insecureTls ? { tls: { rejectUnauthorized: false } } : {}),
      logger: false,
      debug: false,
    })
  : null;

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Fast email sending:
 * - Role-based: pass roles: [...]
 * - Single/Custom recipients: pass recipients: ["a@b.com", "c@d.com"]
 */
async function sendNotificationEmails({
  notificationId,
  title,
  message,
  roles,
  recipients,
}) {
  const brandName = String(BRAND_NAME || "TàbDey").trim();
  const safeTitle = String(title || "System Notification").trim();
  const safeMessage = String(message || "").trim();
  const subject = `${brandName} Notification: ${safeTitle}`;

  if (!isConfigured || !transporter) {
    throw new Error(
      "SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS missing)",
    );
  }

  // Build recipient list either from explicit recipients OR roles lookup
  let users = [];

  if (Array.isArray(recipients) && recipients.length > 0) {
    const uniq = Array.from(
      new Set(
        recipients
          .map((e) =>
            String(e || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    );

    users = uniq.map((email, i) => ({
      user_id: null,
      user_name: "Valued User",
      email,
      _idx: i,
    }));
  } else {
    if (!Array.isArray(roles) || roles.length === 0) {
      return { sent: 0, failed: 0, skipped: 0, total: 0, failures: [] };
    }

    // ✅ Using Prisma to fetch users by roles
    const dbUsers = await prisma.users.findMany({
      where: {
        role: {
          in: roles.map((r) => String(r).trim()),
        },
        email: {
          not: null,
        },
        NOT: {
          email: "",
        },
      },
      select: {
        user_id: true,
        user_name: true,
        email: true,
      },
    });

    if (!dbUsers.length) {
      return { sent: 0, failed: 0, skipped: 0, total: 0, failures: [] };
    }

    users = dbUsers.map((user) => ({
      user_id: Number(user.user_id),
      user_name: user.user_name,
      email: user.email,
    }));
  }

  const concurrency = Math.max(
    1,
    Math.min(30, Number(EMAIL_CONCURRENCY) || 10),
  );

  const year = new Date().getFullYear();
  const brandColor = String(BRAND_COLOR || "#0b7a3b").trim();
  const supportEmail = String(SUPPORT_EMAIL || "").trim();
  const appUrl = String(APP_URL || "").trim();

  // build jobs
  const jobs = users.map((u) => async () => {
    const to = String(u.email || "")
      .trim()
      .toLowerCase();

    const name = String(u.user_name || "Valued User").trim();
    const greetingName = name && name !== "Valued User" ? name : "there";

    if (!isValidEmail(to)) {
      return {
        status: "skipped",
        user_id: u.user_id ?? null,
        email: to,
        reason: "Invalid email",
      };
    }

    const text = `
${brandName} Notification

Hello ${greetingName},

${safeTitle}

${safeMessage}

Regards,
${brandName}${supportEmail ? `\n${supportEmail}` : ""}${appUrl ? `\n${appUrl}` : ""}

---
${notificationId ? `\nReference ID: ${String(notificationId)}` : ""}
`.trim();

    const html = `
<div style="margin:0;padding:0;background:#f6f8fb;">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border:1px solid #e6eaf0;border-radius:12px;overflow:hidden;">
      
      <div style="padding:18px 22px;background:${escapeHtml(brandColor)};">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#ffffff;font-weight:700;">
          ${escapeHtml(brandName)}
        </div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#e9f5ee;margin-top:4px;">
          Notification
        </div>
      </div>

      <div style="padding:22px;">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.6;">
          <p style="margin:0 0 12px 0;">Hello ${escapeHtml(greetingName)},</p>

          <p style="margin:0 0 10px 0;font-size:16px;font-weight:700;color:#111827;">
            ${escapeHtml(safeTitle)}
          </p>

          <div style="margin:0 0 16px 0;color:#374151;white-space:pre-line;">
            ${escapeHtml(safeMessage)}
          </div>

          ${
            appUrl
              ? `
          <div style="margin:18px 0 8px 0;">
            <a href="${escapeHtml(appUrl)}"
               style="display:inline-block;padding:10px 14px;border-radius:10px;background:${escapeHtml(
                 brandColor,
               )};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">
              Open ${escapeHtml(brandName)}
            </a>
          </div>
          `
              : ""
          }

          <hr style="border:none;border-top:1px solid #e6eaf0;margin:18px 0;" />

          <p style="margin:0;color:#111827;">
            Regards,<br/>
            <b>${escapeHtml(brandName)} Team</b>
            ${
              supportEmail
                ? `<br/><span style="color:#6b7280;font-size:12px;">Support: ${escapeHtml(
                    supportEmail,
                  )}</span>`
                : ""
            }
          </p>

          <p style="margin:14px 0 0 0;color:#6b7280;font-size:12px;line-height:1.5;">
            ${
              notificationId
                ? `<br/>Reference ID: <span style="font-family:monospace;">${escapeHtml(
                    notificationId,
                  )}</span>`
                : ""
            }
          </p>
        </div>
      </div>

      <div style="padding:14px 22px;background:#f9fafb;border-top:1px solid #e6eaf0;">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b7280;">
          © ${year} ${escapeHtml(brandName)}. All rights reserved.
        </div>
      </div>

    </div>
  </div>
</div>
`.trim();

    try {
      const info = await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
        envelope: { from, to: [to] },
        headers: notificationId
          ? { "X-Notification-Id": String(notificationId) }
          : undefined,
      });

      if (!info?.accepted || info.accepted.length === 0) {
        return {
          status: "failed",
          user_id: u.user_id ?? null,
          email: to,
          reason: "SMTP did not accept recipient",
        };
      }

      return { status: "sent", user_id: u.user_id ?? null, email: to };
    } catch (e) {
      return {
        status: "failed",
        user_id: u.user_id ?? null,
        email: to,
        reason: e?.message || String(e),
      };
    }
  });

  // concurrency runner
  let idx = 0;
  const results = [];

  const workers = Array.from({
    length: Math.min(concurrency, jobs.length),
  }).map(async () => {
    while (idx < jobs.length) {
      const cur = idx++;
      results.push(await jobs[cur]());
    }
  });

  await Promise.all(workers);

  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const failures = results
    .filter((r) => r.status === "failed")
    .slice(0, 20)
    .map(({ user_id, email, reason }) => ({ user_id, email, reason }));

  return { sent, failed, skipped, total: users.length, failures };
}

module.exports = { sendNotificationEmails };
