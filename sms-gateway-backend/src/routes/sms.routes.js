// src/routes/sms.routes.js
import express from "express";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import {
  insertMessage,
  updateMessage,
  getMessage,
  listMessages,
} from "../db/messages.repo.js";
import { config } from "../config.js";
/**
 * Role-based request limits (per minute). Adjust as you like.
 */
const LIMITS = {
  otp: { windowMs: 60_000, max: 120 }, // 120 req/min
  marketing: { windowMs: 60_000, max: 20 }, // 20 req/min
  system: { windowMs: 60_000, max: 240 }, // 240 req/min
};

/**
 * ✅ IMPORTANT: Create rate limit instances ONCE (module init time),
 * NOT inside a request handler.
 */
const commonLimiterOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers["x-api-key"] || "unknown"),
  message: { ok: false, error: "RATE_LIMITED" },
};

const limiterOtp = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.otp.windowMs,
  max: LIMITS.otp.max,
});

const limiterMarketing = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.marketing.windowMs,
  max: LIMITS.marketing.max,
});

const limiterSystem = rateLimit({
  ...commonLimiterOpts,
  windowMs: LIMITS.system.windowMs,
  max: LIMITS.system.max,
});

function getKeyRole(xApiKey) {
  const key = String(xApiKey || "").trim();
  if (!key) return null;

  if (config.apiKeys.otp && key === config.apiKeys.otp) return "otp";
  if (config.apiKeys.marketing && key === config.apiKeys.marketing)
    return "marketing";
  if (config.apiKeys.system && key === config.apiKeys.system) return "system";
  if (config.apiKeys.master && key === config.apiKeys.master) return "master";

  return null;
}

function requireApiKey(req, res, next) {
  const role = getKeyRole(req.headers["x-api-key"]);
  if (!role) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  req.apiRole = role;
  next();
}

function applyRoleLimiter(req, res, next) {
  // Treat master key like system
  const role = req.apiRole === "master" ? "system" : req.apiRole;

  if (role === "otp") return limiterOtp(req, res, next);
  if (role === "marketing") return limiterMarketing(req, res, next);
  return limiterSystem(req, res, next);
}

function normalizeTo(v) {
  return String(v || "").trim();
}

function normalizeMsisdnDigits(value) {
  const trimmed = normalizeTo(value);
  if (!trimmed) return "";

  let digits = trimmed.replace(/^\+/, "");
  if (digits.startsWith("975")) digits = digits.slice(3);

  return digits;
}

function chooseProviderForMsisdn(smpp, msisdn) {
  const digits = normalizeMsisdnDigits(msisdn);

  if (digits.startsWith("17") || digits.startsWith("16")) {
    if (smpp.hasProvider("bhutan_telecom")) return "bhutan_telecom";
  } else if (digits.startsWith("77")) {
    if (smpp.hasProvider("tashicell")) return "tashicell";
  }

  return smpp.getDefaultProvider();
}

export function smsRouter({ smpp, logger }) {
  const router = express.Router();

  // ✅ Auth + limiter applied to all sms endpoints
  router.use(requireApiKey);
  router.use(applyRoleLimiter);

  /**
   * POST /api/sms/send
   * body: { to, text, from? }
   */
  router.post("/send", async (req, res) => {
    const { to, text, from } = req.body || {};
    const toMsisdn = normalizeTo(to);
    const msgText = String(text || "");

    if (!toMsisdn || !msgText) {
      return res
        .status(400)
        .json({ ok: false, error: "to and text are required" });
    }

    const providerKey = chooseProviderForMsisdn(smpp, toMsisdn);
    const providerConfig = smpp.getProviderConfig(providerKey);
    const defaultSenderId = normalizeTo(providerConfig?.defaultSenderId || "NEWEDGE");

    // Optional policy: marketing key cannot override sender id
    if (
      req.apiRole === "marketing" &&
      from &&
      normalizeTo(from) !== defaultSenderId
    ) {
      return res
        .status(403)
        .json({ ok: false, error: "MARKETING_SENDER_NOT_ALLOWED" });
    }

    const id = uuidv4();
    const now = new Date();

    // Save initial record
    await insertMessage({
      id,
      to_msisdn: toMsisdn,
      sender_id: normalizeTo(from || defaultSenderId),
      text: msgText,
      status: "QUEUED",
      error: null,
      smpp_message_id: null,
      created_at: now,
      sent_at: null,
      delivered_at: null,
    });

    try {
      const { smppMessageId } = await smpp.sendSms({
        provider: providerKey,
        to: toMsisdn,
        text: msgText,
        from: from ? normalizeTo(from) : undefined,
      });

      await updateMessage(id, {
        status: "SENT",
        smpp_message_id: smppMessageId,
        sent_at: new Date(),
        error: null,
      });

      return res.json({
        ok: true,
        id,
        smppMessageId,
        status: "SENT",
        provider: providerKey,
        role: req.apiRole,
      });
    } catch (err) {
      logger?.error?.({ err }, "send failed");

      await updateMessage(id, {
        status: "FAILED",
        error: err?.message || "SEND_FAILED",
      });

      return res.status(503).json({
        ok: false,
        id,
        error: err?.message || "SEND_FAILED",
      });
    }
  });

  /**
   * POST /api/sms/bulk
   * body: { messages: [{to,text,from?}, ...] }
   */
  router.post("/bulk", async (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: "messages[] required" });
    }

    const results = [];

    for (const m of messages) {
      const toMsisdn = normalizeTo(m?.to);
      const msgText = String(m?.text || "");
      const from = m?.from;

      if (!toMsisdn || !msgText) {
        results.push({ ok: false, error: "INVALID_MESSAGE", message: m });
        continue;
      }

      const providerKey = chooseProviderForMsisdn(smpp, toMsisdn);
      const providerConfig = smpp.getProviderConfig(providerKey);
      const defaultSenderId = normalizeTo(providerConfig?.defaultSenderId || "NEWEDGE");

      if (
        req.apiRole === "marketing" &&
        from &&
        normalizeTo(from) !== defaultSenderId
      ) {
        results.push({
          ok: false,
          error: "MARKETING_SENDER_NOT_ALLOWED",
          provider: providerKey,
          to: toMsisdn,
        });
        continue;
      }

      const id = uuidv4();
      const now = new Date();

      await insertMessage({
        id,
        to_msisdn: toMsisdn,
        sender_id: normalizeTo(from || defaultSenderId),
        text: msgText,
        status: "QUEUED",
        error: null,
        smpp_message_id: null,
        created_at: now,
        sent_at: null,
        delivered_at: null,
      });

      try {
        const { smppMessageId } = await smpp.sendSms({
          provider: providerKey,
          to: toMsisdn,
          text: msgText,
          from: from ? normalizeTo(from) : undefined,
        });

        await updateMessage(id, {
          status: "SENT",
          smpp_message_id: smppMessageId,
          sent_at: new Date(),
          error: null,
        });

        results.push({ ok: true, id, smppMessageId, status: "SENT", provider: providerKey });
      } catch (err) {
        await updateMessage(id, {
          status: "FAILED",
          error: err?.message || "SEND_FAILED",
        });

        results.push({
          ok: false,
          id,
          error: err?.message || "SEND_FAILED",
          provider: providerKey,
        });
      }
    }

    return res.json({ ok: true, role: req.apiRole, results });
  });

  /**
   * GET /api/sms/:id
   */
  router.get("/:id", async (req, res) => {
    const row = await getMessage(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    return res.json({ ok: true, message: row });
  });

  /**
   * GET /api/sms?status=SENT&to=...&limit=50&offset=0
   */
  router.get("/", async (req, res) => {
    const { status, to } = req.query;
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);

    const rows = await listMessages({
      status: status ? String(status) : undefined,
      to: to ? String(to) : undefined,
      limit,
      offset,
    });

    return res.json({ ok: true, role: req.apiRole, messages: rows });
  });

  return router;
}
