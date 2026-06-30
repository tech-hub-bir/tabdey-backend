const db = require("../config/db"); // mysql2/promise pool or connection

async function initAdminLogsTable() {
  /* =======================================================
     1. ADMIN LOGS TABLE
  ======================================================= */
  const sqlLogs = `
    CREATE TABLE IF NOT EXISTS admin_logs (
      log_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id      BIGINT UNSIGNED NULL,
      admin_name   VARCHAR(255) NOT NULL,
      activity     VARCHAR(255) NOT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (log_id),
      KEY idx_user_id (user_id),
      KEY idx_created_at (created_at),

      CONSTRAINT fk_admin_logs_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  /* =======================================================
     2. ADMIN COLLABORATORS TABLE
  ======================================================= */
  const sqlCollaborators = `
    CREATE TABLE IF NOT EXISTS admin_collaborators (
      collaborator_id  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      full_name        VARCHAR(255) NOT NULL,
      contact          VARCHAR(20) NOT NULL,
      email            VARCHAR(255) NOT NULL,
      service          VARCHAR(255) DEFAULT NULL,
      role             VARCHAR(100) DEFAULT NULL,
      current_address  VARCHAR(255) DEFAULT NULL,
      cid              VARCHAR(50) DEFAULT NULL,
      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (collaborator_id),
      UNIQUE KEY uniq_email (email),
      UNIQUE KEY uniq_cid (cid),
      KEY idx_role (role)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  /* =======================================================
     3. SYSTEM NOTIFICATIONS TABLE
  ======================================================= */
  const sqlNotifications = `
    CREATE TABLE IF NOT EXISTS system_notifications (
      id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title             VARCHAR(255) NOT NULL,
      message           TEXT NOT NULL,
      delivery_channels JSON NOT NULL DEFAULT (JSON_ARRAY()),
      target_audience   JSON NOT NULL DEFAULT (JSON_ARRAY()),
      created_by        BIGINT UNSIGNED DEFAULT NULL,
      sent_at           DATETIME DEFAULT NULL,
      status            ENUM('pending','sent','failed') DEFAULT 'sent',
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (id),
      KEY idx_status (status),
      KEY idx_created_at (created_at),

      CONSTRAINT fk_notifications_user
        FOREIGN KEY (created_by) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  /* =======================================================
     4. APP RATINGS TABLE  (with role auto-filled via backend)
     For "Rate Our App" feature
  ======================================================= */
  const sqlAppRatings = `
    CREATE TABLE IF NOT EXISTS app_ratings (
      id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id         BIGINT UNSIGNED DEFAULT NULL,
      role            VARCHAR(50) DEFAULT NULL,   -- role from users table

      rating          INT NOT NULL, 
      comment         TEXT DEFAULT NULL,

      platform        VARCHAR(20) DEFAULT NULL, 
      os_version      VARCHAR(20) DEFAULT NULL,
      app_version     VARCHAR(50) DEFAULT NULL,
      device_model    VARCHAR(255) DEFAULT NULL,
      network_type    VARCHAR(50) DEFAULT NULL,

      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (id),
      KEY idx_rating (rating),
      KEY idx_user_id (user_id),
      KEY idx_role (role),
      KEY idx_created_at (created_at),

      CONSTRAINT fk_app_rating_user
        FOREIGN KEY (user_id) REFERENCES users(user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  /* =======================================================
     5. POINT CONVERSION RULE TABLE
        (single row: rule for points -> wallet amount)
  ======================================================= */
  const sqlPointConversionRule = `
    CREATE TABLE IF NOT EXISTS point_conversion_rule (
      -- Always a single row with id = 1
      id               TINYINT UNSIGNED NOT NULL DEFAULT 1,

      -- How many points are needed to convert
      points_required  INT UNSIGNED NOT NULL,          -- e.g. 100 points

      -- Wallet amount given for those points
      wallet_amount    DECIMAL(10,2) NOT NULL,         -- e.g. 10.00

      -- To toggle the rule on/off without deleting it
      is_active        TINYINT(1) NOT NULL DEFAULT 1,

      created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      CONSTRAINT chk_point_rule_single CHECK (id = 1)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;
  /* =======================================================
   6. CONTACT / INQUIRY TABLE (from "Send us a message")
======================================================= */
  const sqlContactMessages = `
  CREATE TABLE IF NOT EXISTS contact_messages (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

    full_name       VARCHAR(255) NOT NULL,

    contact_type    ENUM('email','phone') NOT NULL DEFAULT 'email',
    contact_value   VARCHAR(255) NOT NULL,   -- email or phone

    user_type       VARCHAR(100) DEFAULT NULL, 
    -- e.g. Merchant / business owner, Driver, Customer

    message         TEXT NOT NULL,

    status          ENUM('new','read','replied') DEFAULT 'new',

    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_contact_type (contact_type),
    KEY idx_user_type (user_type),
    KEY idx_status (status),
    KEY idx_created_at (created_at)
  ) ENGINE=InnoDB
    DEFAULT CHARSET=utf8mb4
    COLLATE=utf8mb4_unicode_ci;
`;
  try {
    await db.query(sqlLogs);
    await db.query(sqlCollaborators);
    await db.query(sqlNotifications);
    await db.query(sqlAppRatings);
    await db.query(sqlPointConversionRule);
    await db.query(sqlContactMessages);
    console.log("✔️ All admin tables + contact_messages table are ready");
  } catch (err) {
    console.error("❌ Error initializing admin tables:", err);
  }
}

module.exports = { initAdminLogsTable };
