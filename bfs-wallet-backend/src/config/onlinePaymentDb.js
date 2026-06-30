// In-memory store for online payment sessions (separate from wallet topup).
const payments = new Map();

function createPayment(row) {
  payments.set(row.order_no, row);
  return row;
}

function updatePayment(orderNo, patch) {
  const existing = payments.get(orderNo);
  if (!existing) return null;
  const updated = { ...existing, ...patch, updated_at: new Date() };
  payments.set(orderNo, updated);
  return updated;
}

function getPayment(orderNo) {
  return payments.get(orderNo) || null;
}

module.exports = { createPayment, updatePayment, getPayment };
