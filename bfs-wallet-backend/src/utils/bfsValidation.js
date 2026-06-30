// Per-bank account number lengths (from RMA PG spec)
// Keys include both numeric IDs (from bankList) and short codes
const BANK_ACC_LENGTHS = {
  "1010": 9,   // Bank of Bhutan (BOBL)
  "1020": 9,   // Bhutan National Bank (BNBL)
  "1030": 12,  // Druk PNBL (DPNBL)
  "1040": 9,   // Tashi Bank
  "1050": 12,  // Bhutan Development Bank (BDBL)
  "1060": 12,  // Digital Kidu (DK)
  BOBL: 9,
  BNBL: 9,
  DPNBL: 12,
  TBANK: 9,
  BDBL: 12,
  DK: 12,
};

function validateBankAccNo(bankId, accNo) {
  const id = String(bankId || "").toUpperCase();
  const acc = String(accNo || "").trim();
  const expectedLen = BANK_ACC_LENGTHS[id] ?? BANK_ACC_LENGTHS[bankId];

  if (!acc || !/^\d+$/.test(acc)) {
    const err = new Error("Account number must contain digits only.");
    err.status = 400;
    throw err;
  }

  if (expectedLen !== undefined && acc.length !== expectedLen) {
    const err = new Error(
      `Account number for this bank must be exactly ${expectedLen} digits (got ${acc.length}).`
    );
    err.status = 400;
    throw err;
  }
}

function validateOtp(otp) {
  const o = String(otp || "").trim();
  if (!/^\d{6}$/.test(o)) {
    const err = new Error("OTP must be exactly 6 digits.");
    err.status = 400;
    throw err;
  }
}

module.exports = { validateBankAccNo, validateOtp };
