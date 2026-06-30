const BASE = process.env.WALLET_BASE_URL;

async function request(method, path, body) {
  if (!BASE) throw Object.assign(new Error('Wallet service not configured'), { status: 503 });

  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();

  if (!res.ok) {
    throw Object.assign(new Error(data.message || 'Wallet service error'), { status: res.status });
  }
  return data;
}

async function createWallet(userId) {
  return request('POST', '/wallet/create', { user_id: Number(userId) });
}

async function getWalletByUser(userId) {
  return request('GET', `/wallet/getbyuser/${userId}`);
}

// Uses biometric: true (app-authenticated) when no t_pin is provided
async function transfer({ senderWalletId, recipientWalletId, amount, note, tPin }) {
  return request('POST', '/wallet/transfer', {
    sender_wallet_id: senderWalletId,
    recipient_wallet_id: recipientWalletId,
    amount,
    note,
    biometric: !tPin,
    ...(tPin && { t_pin: tPin }),
  });
}

async function getUserTransactions(userId, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null)
  ).toString();
  return request('GET', `/transactions/user/${userId}${qs ? `?${qs}` : ''}`);
}

module.exports = { createWallet, getWalletByUser, transfer, getUserTransactions };
