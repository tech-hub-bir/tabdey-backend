CREATE TABLE rma_pg_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Optional linkage (so you can search later)
  order_no   VARCHAR(64)  NULL,   -- your internal orderNo (if you have it)
  bfs_txn_id VARCHAR(64)  NULL,   -- bfs_bfsTxnId (if you have it)

  -- Optional small tag so you know what it was
  tag        VARCHAR(32)  NULL COMMENT 'e.g. AR-RC, AE-EC, DR-AC, AS-AC, ERROR',

  -- Whole response/request/log as a single blob
  raw_log    MEDIUMTEXT   NOT NULL,  -- store the full raw string or JSON

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_order_no (order_no),
  KEY idx_bfs_txn_id (bfs_txn_id),
  KEY idx_tag_created (tag, created_at)
) ENGINE=InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;



/* =========================
   1) Holds (reserve funds)
========================= */
CREATE TABLE IF NOT EXISTS wallet_holds (
  hold_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,

  source_type VARCHAR(32) NOT NULL,    -- 'WITHDRAWAL'
  source_id VARCHAR(64) NOT NULL,      -- withdrawal_request_id

  amount DECIMAL(17,2) NOT NULL,

  status ENUM('ACTIVE','RELEASED','CAPTURED') NOT NULL DEFAULT 'ACTIVE',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_user_status (user_id, status),
  UNIQUE KEY uq_hold_source (source_type, source_id)
) ENGINE=InnoDB;


/* =========================
   2) Withdrawal requests
========================= */
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  request_id VARCHAR(64) PRIMARY KEY,  -- wd-<timestamp>-<rand>
  user_id BIGINT UNSIGNED NOT NULL,

  amount DECIMAL(17,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'BTN',

  bank_code VARCHAR(32) NOT NULL,
  bank_name VARCHAR(64) NOT NULL,
  account_no VARCHAR(64) NOT NULL,
  account_name VARCHAR(128) NOT NULL,

  status ENUM(
    'SUBMITTED',   -- user created (wallet already debited)
    'NEEDS_INFO',
    'APPROVED',
    'REJECTED',    -- refunded
    'CANCELLED',   -- refunded
    'PAID',        -- completed externally
    'FAILED'       -- refunded
  ) NOT NULL DEFAULT 'SUBMITTED',

  idempotency_key VARCHAR(80) NOT NULL,

  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,

  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,

  paid_by BIGINT UNSIGNED NULL,
  paid_at DATETIME NULL,
  bank_reference VARCHAR(128) NULL,

  user_note VARCHAR(255) NULL,
  admin_note VARCHAR(255) NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_user_date (user_id, created_at),
  KEY idx_status_date (status, created_at),
  UNIQUE KEY uq_user_idem (user_id, idempotency_key),
  UNIQUE KEY uq_bank_ref (bank_reference)
) ENGINE=InnoDB;


/* =========================
   3) Audit trail
========================= */
CREATE TABLE IF NOT EXISTS withdrawal_audit (
  audit_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  request_id VARCHAR(64) NOT NULL,
  actor_type ENUM('USER','ADMIN','SYSTEM') NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,     -- CREATE, APPROVE, REJECT, MARK_PAID, FAIL, CANCEL, NEEDS_INFO, REFUND
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_req_date (request_id, created_at)
) ENGINE=InnoDB;


/* =========================
   4) Optional: Wallet ledger (recommended)
   If you already have a ledger/transactions table, skip this.
========================= */
CREATE TABLE IF NOT EXISTS wallet_ledger (
  ledger_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  entry_type ENUM(
    'WITHDRAW_REQUEST_DEBIT',
    'WITHDRAW_REFUND',
    'WITHDRAW_PAID'
  ) NOT NULL,
  amount DECIMAL(17,2) NOT NULL, -- store negative for debit, positive for credit
  source_type VARCHAR(32) NOT NULL,
  source_id VARCHAR(64) NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_user_date (user_id, created_at),
  KEY idx_source (source_type, source_id)
) ENGINE=InnoDB;
