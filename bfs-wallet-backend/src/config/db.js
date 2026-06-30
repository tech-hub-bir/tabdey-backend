// Very simple in-memory store just for example.
// Replace with your real DB implementation.
const payments = new Map(); // key: orderNo, value: payment row

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
  console.log("Getting payment for orderNo:", orderNo);
  console.log("Current keys in payments map:", Array.from(payments.keys()));
  return payments.get(orderNo) || null;
}

module.exports = {
  createPayment,
  updatePayment,
  getPayment,
};
