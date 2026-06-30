import { SmppClient } from "./SmppClient.js";

const normalizeKey = (value) => String(value || "").trim().toLowerCase();

export class SmppManager {
  constructor({ logger, providers, defaultProvider }) {
    if (!providers || !Object.keys(providers).length) {
      throw new Error("No SMPP providers configured");
    }

    this.logger = logger;
    this.defaultProvider = normalizeKey(defaultProvider);
    this.providers = {};

    for (const [key, cfg] of Object.entries(providers)) {
      const normalizedKey = normalizeKey(key);
      const configWithId = { ...cfg, id: cfg.id || normalizedKey };
      const childLogger =
        logger && typeof logger.child === "function"
          ? logger.child({ smppProvider: normalizedKey })
          : logger;

      this.providers[normalizedKey] = {
        config: configWithId,
        client: new SmppClient({ logger: childLogger, smppConfig: configWithId }),
      };
    }

    if (!this.providers[this.defaultProvider]) {
      this.defaultProvider = Object.keys(this.providers)[0];
    }
  }

  start() {
    Object.values(this.providers).forEach((entry) => entry.client.start());
  }

  stop() {
    Object.values(this.providers).forEach((entry) => entry.client.stop());
  }

  listProviders() {
    return Object.keys(this.providers);
  }

  getDefaultProvider() {
    return this.defaultProvider;
  }

  hasProvider(provider) {
    const key = normalizeKey(provider);
    return Boolean(this.providers[key]);
  }

  getProviderConfig(provider) {
    const key = provider ? normalizeKey(provider) : this.defaultProvider;
    return this.providers[key]?.config || null;
  }

  resolveProvider(provider) {
    return this._resolveProvider(provider);
  }

  isReady(provider) {
    if (provider) {
      const key = normalizeKey(provider);
      return this.providers[key]?.client.isReady() || false;
    }

    return Object.fromEntries(
      Object.entries(this.providers).map(([key, entry]) => [
        key,
        entry.client.isReady(),
      ])
    );
  }

  async sendSms({ provider, ...sms }) {
    const key = this._resolveProvider(provider);
    return this.providers[key].client.sendSms(sms);
  }

  _resolveProvider(provider) {
    if (!provider) return this.defaultProvider;

    const key = normalizeKey(provider);
    if (!this.providers[key]) {
      const available = this.listProviders().join(", ") || "none";
      throw new Error(`SMPP_PROVIDER_NOT_FOUND:${provider} (available: ${available})`);
    }
    return key;
  }
}
