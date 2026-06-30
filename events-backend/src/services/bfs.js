const BFS_BASE = process.env.BFS_BASE_URL;
const BFS_API_KEY = process.env.BFS_API_KEY;

async function bfsRequest(method, path, body, token) {
  const url = `${BFS_BASE}${path}`;
  console.log(`[BFS] ${method} ${url}`);
  if (body) console.log('[BFS] Request body:', JSON.stringify(body));

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (BFS_API_KEY) headers['x-api-key'] = BFS_API_KEY;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  console.log(`[BFS] Status: ${res.status} | Response: ${text}`);

  let json;
  try { json = JSON.parse(text); } catch {
    const err = new Error('BFS returned non-JSON response');
    err.status = 502; throw err;
  }

  if (!json.ok) {
    const err = new Error(json.error || 'BFS payment gateway error');
    err.status = res.status === 200 ? 422 : res.status;
    throw err;
  }

  return json.data;
}

// Step 1 — Init payment, returns orderNo + bankList
async function initPayment({ userId, amount, email, description }, token) {
  return bfsRequest('POST', '/api/wallet/topup/init', {
    userId,
    amount,
    email,
    description: description || 'Event ticket payment',
  }, token);
}

// Step 2 — Verify bank account
async function accountEnquiry({ orderNo, remitterBankId, remitterAccNo }, token) {
  return bfsRequest('POST', '/api/wallet/topup/account-enquiry', {
    orderNo,
    remitterBankId,
    remitterAccNo,
  }, token);
}

// Step 3 — Debit with OTP
async function debitWithOtp({ orderNo, otp }, token) {
  return bfsRequest('POST', '/api/wallet/topup/debit', { orderNo, otp }, token);
}

// Check payment status
async function getStatus(orderNo, token) {
  return bfsRequest('GET', `/api/wallet/topup/status/${orderNo}`, null, token);
}

module.exports = { initPayment, accountEnquiry, debitWithOtp, getStatus };
