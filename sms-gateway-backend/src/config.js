import dotenv from "dotenv";
dotenv.config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const BHUTAN_TELECOM_KEY = "bhutan_telecom";
const TASHICELL_KEY = "tashicell";

const smppProviders = buildSmppProviders();
const defaultSmppProvider = resolveDefaultSmppProvider(smppProviders);

export const config = {
  port: Number(process.env.PORT || 5055),

  apiKeys: {
    master: process.env.API_KEY || "",
    otp: process.env.API_KEY_OTP || "",
    marketing: process.env.API_KEY_MARKETING || "",
    system: process.env.API_KEY_SYSTEM || ""
  },

  smpp: {
    providers: smppProviders,
    defaultProvider: defaultSmppProvider
  },

  mysql: {
    host: must("MYSQL_HOST"),
    port: Number(process.env.MYSQL_PORT || 3306),
    user: must("MYSQL_USER"),
    password: must("MYSQL_PASSWORD"),
    database: must("MYSQL_DATABASE"),
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10)
  }
};

function buildSmppProviders() {
  const providers = {};
  providers[BHUTAN_TELECOM_KEY] = buildBhutanTelecomSmppConfig();

  if (process.env.TASHICELL_SMPP_HOST) {
    providers[TASHICELL_KEY] = buildTashicellSmppConfig();
  }

  return providers;
}

function resolveDefaultSmppProvider(providers) {
  const envProvider = normalizeProviderKey(process.env.DEFAULT_SMPP_PROVIDER);
  if (envProvider && providers[envProvider]) return envProvider;

  const keys = Object.keys(providers);
  if (!keys.length) throw new Error("At least one SMPP provider must be configured");
  return keys[0];
}

function normalizeProviderKey(value) {
  return String(value || "").trim().toLowerCase();
}

function buildBhutanTelecomSmppConfig() {
  return {
    id: BHUTAN_TELECOM_KEY,
    host: must("SMPP_HOST"),
    port: Number(must("SMPP_PORT")),
    systemId: must("SMPP_SYSTEM_ID"),
    password: must("SMPP_PASSWORD"),
    systemType: process.env.SMPP_SYSTEM_TYPE || "",
    interfaceVersion: Number(process.env.SMPP_INTERFACE_VERSION || 52),
    enquireLinkMs: Number(process.env.ENQUIRE_LINK_MS || 30000),
    reconnectMs: Number(process.env.RECONNECT_MS || 5000),
    maxMps: Number(process.env.MAX_MPS || 10),
    defaultSenderId: process.env.DEFAULT_SENDER_ID || "NEWEDGE"
  };
}

function buildTashicellSmppConfig() {
  const mustT = (suffix) => must(`TASHICELL_${suffix}`);

  return {
    id: TASHICELL_KEY,
    host: mustT("SMPP_HOST"),
    port: Number(mustT("SMPP_PORT")),
    systemId: mustT("SMPP_SYSTEM_ID"),
    password: mustT("SMPP_PASSWORD"),
    systemType: process.env.TASHICELL_SMPP_SYSTEM_TYPE || "",
    interfaceVersion: Number(process.env.TASHICELL_SMPP_INTERFACE_VERSION || 52),
    enquireLinkMs: Number(
      process.env.TASHICELL_ENQUIRE_LINK_MS || process.env.ENQUIRE_LINK_MS || 30000
    ),
    reconnectMs: Number(
      process.env.TASHICELL_RECONNECT_MS || process.env.RECONNECT_MS || 5000
    ),
    maxMps: Number(process.env.TASHICELL_MAX_MPS || process.env.MAX_MPS || 10),
    defaultSenderId:
      process.env.TASHICELL_DEFAULT_SENDER_ID ||
      process.env.DEFAULT_SENDER_ID ||
      "NEWEDGE"
  };
}
