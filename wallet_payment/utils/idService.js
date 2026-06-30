// utils/idService.js
const crypto = require("crypto");

function makeTxnId() {
  return (
    "TNX" + Date.now() + crypto.randomBytes(2).toString("hex").toUpperCase()
  );
}
function makeJournalCode() {
  return "JRN" + crypto.randomBytes(6).toString("hex").toUpperCase();
}

module.exports = {
  makeTxnId,
  makeJournalCode,
};
