-- Migration: referral system tables
-- Run once against the grab/tabdhey database.

-- Stores each user's unique shareable referral code.
-- Generated on first request to GET /api/referrals/my-code.
CREATE TABLE IF NOT EXISTS user_referral_codes (
  user_id    BIGINT UNSIGNED NOT NULL,
  code       VARCHAR(32)     NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT UTC_TIMESTAMP(),
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per referral relationship.
-- referee_id is UNIQUE: each account may only use one referral code ever.
CREATE TABLE IF NOT EXISTS referrals (
  id            BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  referral_code VARCHAR(32)      NOT NULL,
  referrer_id   BIGINT UNSIGNED  NOT NULL,  -- owner of the code
  referee_id    BIGINT UNSIGNED  NOT NULL,  -- new user who applied the code
  status        ENUM('pending','credited','expired') NOT NULL DEFAULT 'pending',
  amount        INT UNSIGNED     NOT NULL DEFAULT 50,  -- Nu. credited to each party
  credited_at   DATETIME         NULL,
  created_at    DATETIME         NOT NULL DEFAULT UTC_TIMESTAMP(),
  UNIQUE KEY uq_referee  (referee_id),      -- one referral per account
  KEY idx_referrer (referrer_id),
  KEY idx_code     (referral_code),
  KEY idx_status   (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
