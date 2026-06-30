// config/bfsConfig.js
module.exports = {
  BFS_API_URL: process.env.BFS_API_URL,
  BFS_AS_URL: process.env.BFS_AS_URL,

  BFS_BENF_ID: process.env.BFS_BENF_ID,                 // BE10000259
  BFS_BENF_BANK_CODE: process.env.BFS_BENF_BANK_CODE,   // 01
  BFS_TXN_CURRENCY: process.env.BFS_TXN_CURRENCY,       // BTN
  BFS_VERSION: process.env.BFS_VERSION,                 // 1.0

  PRIVATE_KEY_PATH: process.env.BFS_PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH: process.env.BFS_PUBLIC_KEY_PATH,
  UAT_PUBLIC_KEY_PATH: process.env.BFS_UAT_PUBLIC_KEY_PATH,
  BFS_TIMEOUT_MS: Number(process.env.BFS_TIMEOUT_MS || 60000),
};

