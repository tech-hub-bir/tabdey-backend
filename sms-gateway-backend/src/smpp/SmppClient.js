import smpp from "smpp";
import { parseDlrText } from "./dlr.js";
import { updateBySmppMessageId } from "../db/messages.repo.js";

export class SmppClient {
  constructor({ logger, smppConfig }) {
    if (!smppConfig) throw new Error("smppConfig is required for SmppClient");

    const providerName = smppConfig.id || smppConfig.provider || "smpp";
    this.log = logger?.child
      ? logger.child({ smppProvider: providerName })
      : logger;
    this.name = providerName;
    this.cfg = smppConfig;

    this.session = null;
    this.connected = false;
    this.bound = false;
    this.binding = false;

    this.enquireTimer = null;
    this.reconnectTimer = null;

    // throughput throttle (tokens refill per second)
    this.maxMps = Number(smppConfig.maxMps || 10);
    this.tokens = this.maxMps;
    this.lastRefill = Date.now();

    // optional dialing rules (defaults for Bhutan)
    this.countryCode = String(smppConfig.countryCode || "975"); // allow override
    this.forceInternationalDest = smppConfig.forceInternationalDest !== false; // default true
  }

  start() {
    this._connect();
  }

  stop() {
    try {
      if (this.enquireTimer) clearInterval(this.enquireTimer);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (this.session) this.session.close();
    } finally {
      this.session = null;
      this.connected = false;
      this.bound = false;
      this.binding = false;
      this.enquireTimer = null;
      this.reconnectTimer = null;
    }
  }

  isReady() {
    return this.connected && this.bound;
  }

  _scheduleReconnect(reason) {
    if (this.reconnectTimer) return;

    this.log.warn({ reason }, "SMPP reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.cfg.reconnectMs);
  }

  _connect() {
    const { host, port } = this.cfg;
    this.log.info({ host, port }, "Connecting to SMPP...");

    try {
      this.session = smpp.connect({ url: `smpp://${host}:${port}` });

      this.session.on("connect", () => {
        this.connected = true;
        this.log.info("SMPP TCP connected");
        this._bind();
      });

      this.session.on("close", () => {
        this.log.warn("SMPP connection closed");
        this.connected = false;
        this.bound = false;
        this.binding = false;
        this._clearEnquire();
        this._scheduleReconnect("close");
      });

      this.session.on("error", (err) => {
        this.log.error({ err }, "SMPP error");
        this.connected = false;
        this.bound = false;
        this.binding = false;
        this._clearEnquire();
        this._scheduleReconnect("error");
      });

      this.session.on("pdu", async (pdu) => {
        if (pdu.command === "deliver_sm") {
          // always ack
          try {
            this.session.deliver_sm_resp({
              sequence_number: pdu.sequence_number,
            });
          } catch {}

          const msg =
            pdu.short_message?.message || pdu.short_message?.toString?.() || "";

          const dlr = parseDlrText(msg);

          if (dlr?.smppMessageId) {
            const now = new Date();
            await updateBySmppMessageId(dlr.smppMessageId, {
              status: dlr.status || "UNKNOWN",
              delivered_at: dlr.status === "DELIVERED" ? now : null,
            });

            this.log.info(
              {
                smppMessageId: dlr.smppMessageId,
                status: dlr.status,
                raw: dlr.rawStat,
              },
              "DLR received",
            );
          } else {
            this.log.info({ msg }, "deliver_sm received (non-DLR or unparsed)");
          }
        }
      });
    } catch (err) {
      this.log.error({ err }, "Failed to start SMPP connect()");
      this._scheduleReconnect("connect_exception");
    }
  }

  _bind() {
    if (!this.session || this.binding) return;
    this.binding = true;

    const { systemId, password, systemType, interfaceVersion } = this.cfg;

    this.session.bind_transceiver(
      {
        system_id: systemId,
        password,
        system_type: systemType,
        interface_version: interfaceVersion,
      },
      (pdu) => {
        this.binding = false;

        if (pdu.command_status === 0) {
          this.bound = true;
          this.log.info("✅ SMPP bind_transceiver success");
          this._startEnquire();
        } else {
          this.bound = false;
          this.log.error(
            { command_status: pdu.command_status },
            "❌ SMPP bind failed",
          );
          this._clearEnquire();
          this._scheduleReconnect("bind_failed");
        }
      },
    );
  }

  _startEnquire() {
    this._clearEnquire();
    this.enquireTimer = setInterval(() => {
      try {
        this.session?.enquire_link();
      } catch (err) {
        this.log.error({ err }, "enquire_link error");
      }
    }, this.cfg.enquireLinkMs);
  }

  _clearEnquire() {
    if (this.enquireTimer) clearInterval(this.enquireTimer);
    this.enquireTimer = null;
  }

  _refillTokens() {
    const now = Date.now();
    if (now - this.lastRefill >= 1000) {
      this.tokens = this.maxMps;
      this.lastRefill = now;
    }
  }

  async _takeToken() {
    while (true) {
      this._refillTokens();
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ---------- Address helpers ----------
  _onlyDigits(s) {
    return String(s || "").replace(/\D+/g, "");
  }

  _isNumericAddr(s) {
    return /^[0-9]+$/.test(String(s || ""));
  }

  _isBhutanLocal8(digits) {
    return typeof digits === "string" && digits.length === 8;
  }

  _normalizeDest(to) {
    const raw = String(to || "").trim();
    const digits = this._onlyDigits(raw);

    if (!digits) return { dest: raw, isIntl: false, digits: "" };

    // If already starts with country code 975 => international
    if (
      digits.startsWith(this.countryCode) &&
      digits.length > this.countryCode.length
    ) {
      return { dest: digits, isIntl: true, digits };
    }

    // If local 8 digits and we prefer international => add 975
    if (this.forceInternationalDest && this._isBhutanLocal8(digits)) {
      const cc = this.countryCode;
      return { dest: `${cc}${digits}`, isIntl: true, digits: `${cc}${digits}` };
    }

    // otherwise keep as digits (national)
    return { dest: digits, isIntl: false, digits };
  }

  _senderTonNpi(sender) {
    const s = String(sender || "").trim();
    if (!s) return { ton: 0, npi: 0 };

    // Alphanumeric sender IDs: TON=5, NPI=0 (most common requirement)
    if (!this._isNumericAddr(s)) {
      return { ton: 5, npi: 0 };
    }

    // Numeric sender (shortcode/msisdn): TON depends on whether it includes country code
    const digits = this._onlyDigits(s);
    const isIntl =
      digits.startsWith(this.countryCode) &&
      digits.length > this.countryCode.length;
    return { ton: isIntl ? 1 : 2, npi: 1 }; // 1=international, 2=national, NPI=E.164
  }

  _destTonNpi(isIntl) {
    return { ton: isIntl ? 1 : 2, npi: 1 }; // NPI=E.164
  }

  async sendSms({ to, text, from }) {
    if (!this.isReady()) throw new Error("SMPP_NOT_READY");

    await this._takeToken();

    const sender = (from || this.cfg.defaultSenderId || "").trim();
    const body = String(text ?? "");

    const { dest, isIntl } = this._normalizeDest(to);

    // If no sender provided, some SMSCs allow empty source_addr; but safer to enforce defaultSenderId.
    if (!sender) throw new Error("SENDER_ID_REQUIRED");

    const { ton: source_addr_ton, npi: source_addr_npi } =
      this._senderTonNpi(sender);
    const { ton: dest_addr_ton, npi: dest_addr_npi } = this._destTonNpi(isIntl);

    // helpful debug (no sensitive data)
    this.log.info(
      {
        to: dest,
        isIntl,
        from: sender,
        source_addr_ton,
        source_addr_npi,
        dest_addr_ton,
        dest_addr_npi,
      },
      "submit_sm prepared",
    );

    return new Promise((resolve, reject) => {
      try {
        this.session.submit_sm(
          {
            destination_addr: dest,
            dest_addr_ton,
            dest_addr_npi,

            source_addr: sender,
            source_addr_ton,
            source_addr_npi,

            short_message: body,

            // ask for delivery receipts only if provider supports (you can enable later)
            // registered_delivery: 1,
          },
          (pdu) => {
            if (pdu.command_status === 0)
              resolve({ smppMessageId: pdu.message_id });
            else reject(new Error(`SUBMIT_SM_FAILED_${pdu.command_status}`));
          },
        );
      } catch (err) {
        reject(err);
      }
    });
  }
}
