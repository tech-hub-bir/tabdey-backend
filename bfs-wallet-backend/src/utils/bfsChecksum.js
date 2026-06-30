const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH,
  UAT_PUBLIC_KEY_PATH,
} = require("../config/bfsConfig");

let privateKeyPem = null;
let publicKeyPem = null;
let uatPublicKeyPem = null;

function loadKeys() {
  if (!privateKeyPem && PRIVATE_KEY_PATH) {
    privateKeyPem = fs.readFileSync(path.resolve(PRIVATE_KEY_PATH), "utf8");
  }
  if (!publicKeyPem && PUBLIC_KEY_PATH) {
    publicKeyPem = fs.readFileSync(path.resolve(PUBLIC_KEY_PATH), "utf8");
  }
  if (!uatPublicKeyPem && UAT_PUBLIC_KEY_PATH) {
    uatPublicKeyPem = fs.readFileSync(path.resolve(UAT_PUBLIC_KEY_PATH), "utf8");
  }
}

function buildSourceString(params, order) {
  return order.map((k) => (params[k] ?? "")).join("|");
}

function signChecksum(source) {
  loadKeys();
  if (!privateKeyPem) throw new Error("Private key not loaded");
  const sign = crypto.createSign("RSA-SHA1");
  sign.update(source, "utf8");
  sign.end();
  const signature = sign.sign(privateKeyPem);
  return signature.toString("hex").toUpperCase();
}

function verifyChecksum(params, order, checksumHex) {
  loadKeys();
  if (!uatPublicKeyPem) throw new Error("BFS UAT public key not loaded");
  const verify = crypto.createVerify("RSA-SHA1");
  const source = buildSourceString(params, order);
  verify.update(source, "utf8");
  verify.end();
  const sig = Buffer.from(checksumHex, "hex");
  return verify.verify(uatPublicKeyPem, sig);
}

module.exports = {
  buildSourceString,
  signChecksum,
  verifyChecksum,
};
