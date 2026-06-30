const db = require("../config/db");

// Check if table exists
async function tableExists(table) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ? 
      LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

// Check if column exists
async function columnExists(table, column) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ? 
        AND COLUMN_NAME = ? 
      LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

// Ensure index exists
async function ensureIndex(table, indexName, ddlSql) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ? 
        AND INDEX_NAME = ? 
      LIMIT 1`,
    [table, indexName],
  );
  if (!rows.length) {
    await db.query(ddlSql);
  }
}

// Get column meta (type, precision, scale)
async function getNumericColumnMeta(table, column) {
  const [rows] = await db.query(
    `SELECT DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ? 
        AND COLUMN_NAME = ? 
      LIMIT 1`,
    [table, column],
  );
  return rows[0] || null;
}

// Initialize wallet tables (wallets and wallet_transactions)
async function initWalletTables() {
  console.log("🪙 Checking wallet & transaction tables...");

  const walletExists = await tableExists("wallets");
  const txExists = await tableExists("wallet_transactions");

  // ---------- WALLET TABLE ----------
  if (!walletExists) {
    await db.query(`
      CREATE TABLE wallets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        wallet_id VARCHAR(20) UNIQUE,
        user_id BIGINT UNSIGNED NOT NULL UNIQUE,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        t_pin VARCHAR(255) DEFAULT NULL,
        status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_wallet_user (user_id),
        KEY idx_wallet_status (status),
        KEY idx_wallet_created (created_at)
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ Created table: wallets");
  } else {
    console.log("ℹ️  wallets table already exists — skipped creation.");
    const meta = await getNumericColumnMeta("wallets", "amount");
    if (meta && (meta.DATA_TYPE !== "decimal" || meta.NUMERIC_SCALE !== 2)) {
      await db.query(
        `ALTER TABLE wallets MODIFY amount DECIMAL(12,2) NOT NULL DEFAULT 0.00`,
      );
      console.log("🔧 Patched wallets.amount to DECIMAL(12,2)");
    }
  }

  // ---------- TRANSACTION TABLE ----------
  if (!txExists) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        transaction_id VARCHAR(32) NOT NULL UNIQUE, -- TNX...
        journal_code VARCHAR(36) NULL, -- JRN... link DR/CR pair
        tnx_from VARCHAR(20) NULL, -- NET...
        tnx_to VARCHAR(20) NULL, -- NET...
        amount DECIMAL(12,2) NOT NULL, -- Nu with 2 decimals
        remark ENUM('CR','DR') NOT NULL, -- Credit/Debit indicator
        note VARCHAR(255) NULL, -- transfer notes
        -- NEW: single wallet pointer for de-duplicated views
        actual_wallet_id VARCHAR(20)
          GENERATED ALWAYS AS (
            CASE WHEN remark = 'DR' THEN tnx_from ELSE tnx_to END
          ) STORED,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_journal_code (journal_code),
        KEY idx_from (tnx_from),
        KEY idx_to (tnx_to),
        KEY idx_tx_created (created_at),
        KEY idx_actual_wallet (actual_wallet_id, created_at)
      ) ENGINE=InnoDB
        DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ Created table: wallet_transactions");
  } else {
    console.log(
      "ℹ️  wallet_transactions table already exists — skipped creation.",
    );

    // Ensure DECIMAL(12,2) for amount
    const meta = await getNumericColumnMeta("wallet_transactions", "amount");
    if (meta && (meta.DATA_TYPE !== "decimal" || meta.NUMERIC_SCALE !== 2)) {
      await db.query(
        `ALTER TABLE wallet_transactions MODIFY amount DECIMAL(12,2) NOT NULL`,
      );
      console.log("🔧 Patched wallet_transactions.amount to DECIMAL(12,2)");
    }

    // Ensure the generated column exists
    const hasActual = await columnExists(
      "wallet_transactions",
      "actual_wallet_id",
    );
    if (!hasActual) {
      await db.query(`
        ALTER TABLE wallet_transactions
          ADD COLUMN actual_wallet_id VARCHAR(20)
          GENERATED ALWAYS AS (
            CASE WHEN remark = 'DR' THEN tnx_from ELSE tnx_to END
          ) STORED
      `);
      console.log(
        "🆕 Added generated column wallet_transactions.actual_wallet_id",
      );
    }

    // Ensure indexes
    await ensureIndex(
      "wallet_transactions",
      "idx_journal_code",
      "CREATE INDEX idx_journal_code ON wallet_transactions(journal_code)",
    );
    await ensureIndex(
      "wallet_transactions",
      "idx_from",
      "CREATE INDEX idx_from ON wallet_transactions(tnx_from)",
    );
    await ensureIndex(
      "wallet_transactions",
      "idx_to",
      "CREATE INDEX idx_to ON wallet_transactions(tnx_to)",
    );
    await ensureIndex(
      "wallet_transactions",
      "idx_tx_created",
      "CREATE INDEX idx_tx_created ON wallet_transactions(created_at)",
    );
    await ensureIndex(
      "wallet_transactions",
      "idx_actual_wallet",
      "CREATE INDEX idx_actual_wallet ON wallet_transactions(actual_wallet_id, created_at)",
    );
  }

  console.log("✅ Wallet system initialization complete.");
}

module.exports = { initWalletTables };
