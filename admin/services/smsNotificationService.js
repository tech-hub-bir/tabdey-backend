const { prisma } = require("../lib/prisma.js");

const SMS_BULK_URL = process.env.SMS_BULK_URL;
const SMS_API_KEY = (process.env.SMS_API_KEY || "").trim();
const SMS_FROM = process.env.SMS_FROM.trim();

const MAX_BULK = Number(process.env.SMS_BULK_MAX || 50);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node 18+ has global fetch. If older node, uses node-fetch dynamically.
async function fetchAny(url, opts) {
  if (global.fetch) return global.fetch(url, opts);
  const { default: fetch } = await import("node-fetch");
  return fetch(url, opts);
}

function normalizeBhutanNumberForSms(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const digits = raw.replace(/[^\d]/g, "");

  // 8-digit local -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // already with country code
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  // otherwise return digits as-is
  return digits || null;
}

/**
 * Fetch phones for roles from users table using Prisma.
 * Uses ONLY users.phone.
 */
async function getPhonesForRoles(roles = []) {
  if (!roles.length) return [];

  // ✅ Using Prisma to fetch users by roles
  const users = await prisma.users.findMany({
    where: {
      role: {
        in: roles,
      },
      phone: {
        not: null,
      },
      NOT: {
        phone: "",
      },
    },
    select: {
      user_id: true,
      user_name: true,
      phone: true,
    },
  });

  const phones = [];
  for (const user of users) {
    const normalized = normalizeBhutanNumberForSms(user.phone);
    if (normalized) phones.push(normalized);
  }

  return Array.from(new Set(phones));
}

/**
 * Send SMS notifications:
 * - Role-based: pass roles: [...]
 * - Single/Custom recipients: pass recipients: ["97517xxxxxx", "17xxxxxx"]
 */
async function sendNotificationSmsBulk({ title, message, roles, recipients }) {
  const text = `${String(title || "").trim()}\n${String(
    message || "",
  ).trim()}`.trim();

  // Build phone list either from explicit recipients OR roles lookup
  let phones = [];

  if (Array.isArray(recipients) && recipients.length > 0) {
    phones = Array.from(
      new Set(
        recipients.map((p) => normalizeBhutanNumberForSms(p)).filter(Boolean),
      ),
    );
  } else {
    if (!Array.isArray(roles) || !roles.length) {
      return { sent: 0, failed: 0, total: 0, batches: 0, rawResponses: [] };
    }
    phones = await getPhonesForRoles(roles);
  }

  if (!phones.length) {
    return { sent: 0, failed: 0, total: 0, batches: 0, rawResponses: [] };
  }

  if (!SMS_API_KEY) {
    throw new Error("SMS_API_KEY is missing in env");
  }

  let sent = 0;
  let failed = 0;
  let batches = 0;
  const rawResponses = [];

  for (let i = 0; i < phones.length; i += MAX_BULK) {
    const chunk = phones.slice(i, i + MAX_BULK);
    batches++;

    const payload = {
      messages: chunk.map((to) => ({
        to,
        text,
        from: SMS_FROM,
      })),
    };

    const resp = await fetchAny(SMS_BULK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": SMS_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    rawResponses.push(bodyText);

    if (!resp.ok) {
      failed += chunk.length;
    } else {
      try {
        const parsed = JSON.parse(bodyText);
        const results = Array.isArray(parsed?.results) ? parsed.results : null;

        if (results) {
          for (const r of results) {
            if (r && r.ok === true) sent++;
            else failed++;
          }
        } else {
          sent += chunk.length;
        }
      } catch (e) {
        sent += chunk.length;
      }
    }

    if (i + MAX_BULK < phones.length) {
      await sleep(500);
    }
  }

  return { sent, failed, total: phones.length, batches, rawResponses };
}

module.exports = { sendNotificationSmsBulk };
