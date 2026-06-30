// config/initOrderManagementTable.js
const db = require("../config/db");

/* ----------------------- helpers ----------------------- */
async function indexExists(table, indexName) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
    LIMIT 1
    `,
    [table, indexName],
  );
  return rows.length > 0;
}

async function ensureIndex(table, indexName, ddlSql) {
  const exists = await indexExists(table, indexName);
  if (!exists) await db.query(ddlSql);
}

async function columnExists(table, column) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [table, column],
  );
  return rows.length > 0;
}

async function ensureColumn(table, column, ddlSql) {
  const exists = await columnExists(table, column);
  if (!exists) await db.query(ddlSql);
}

async function getColumnDataType(table, column) {
  const [rows] = await db.query(
    `
    SELECT DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [table, column],
  );
  return rows[0] || null;
}

// If column exists but type is too small/incorrect, modify it.
async function ensureColumnType(table, column, shouldModifyFn, modifySql) {
  const info = await getColumnDataType(table, column);
  if (!info) return; // doesn't exist yet; ensureColumn should handle add
  if (shouldModifyFn(info)) {
    await db.query(modifySql);
  }
}

async function tableExists(table) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    LIMIT 1
    `,
    [table],
  );
  return rows.length > 0;
}

/* ------------------- main initializer ------------------- */
/**
 * Initialize (and patch) order management tables in a version-safe way.
 *
 * ✅ Change: delivery_photo_url is now TEXT (stores JSON array string or long URI list)
 * ✅ NEW: food_mart_revenue table (keeps lifetime revenue rows even if delivered_orders is trimmed)
 */
async function initOrderManagementTable() {
  /* -------- Orders -------- */
  await db.query(`
CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(12) NOT NULL,
  user_id INT(11) NOT NULL,
  service_type ENUM('FOOD','MART') NOT NULL DEFAULT 'FOOD',
  business_id INT(10) UNSIGNED DEFAULT NULL,
  batch_id BIGINT(20) UNSIGNED DEFAULT NULL,

  total_amount DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) DEFAULT 0.00,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  payment_method ENUM('COD','Wallet','Card') NOT NULL,

  delivery_address VARCHAR(500) NOT NULL,
  delivery_lat DECIMAL(9,6) DEFAULT NULL,
  delivery_lng DECIMAL(9,6) DEFAULT NULL,

  -- ✅ NEW address-details fields
  delivery_floor_unit VARCHAR(80) DEFAULT NULL,
  delivery_instruction_note VARCHAR(256) DEFAULT NULL,

  -- ✅ UPDATED: was VARCHAR(500); now TEXT so you can store JSON array string
  delivery_photo_url TEXT NULL,

  -- ✅ NEW special instruction mode (DROP_OFF / MEET_UP)
  delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL,

  note_for_restaurant VARCHAR(500) DEFAULT NULL,
  if_unavailable VARCHAR(256) DEFAULT NULL,

  status VARCHAR(100) DEFAULT 'PENDING',
  status_reason VARCHAR(255) DEFAULT NULL,

  fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery',
  priority TINYINT(1) DEFAULT 0,
  estimated_arrivial_time VARCHAR(40) DEFAULT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  platform_fee DECIMAL(10,2) DEFAULT 0.00,
  merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL,

  delivery_batch_id BIGINT(20) UNSIGNED DEFAULT NULL,
  delivery_driver_id INT(11) DEFAULT NULL,
  delivery_status ENUM('PENDING','ASSIGNED','PICKED_UP','ON_ROAD','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  delivery_ride_id BIGINT(20) DEFAULT NULL,

  PRIMARY KEY (order_id),
  KEY idx_orders_user (user_id),
  KEY idx_orders_created (created_at),
  KEY idx_orders_batch_id (batch_id),
  KEY idx_orders_business_service_created (business_id, service_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  // Patches – safe if the table already existed with older schema.
  const ordersCols = [
    [
      "service_type",
      `ALTER TABLE orders ADD COLUMN service_type ENUM('FOOD','MART') NOT NULL DEFAULT 'FOOD'`,
    ],
    [
      "business_id",
      `ALTER TABLE orders ADD COLUMN business_id INT(10) UNSIGNED DEFAULT NULL`,
    ],
    [
      "batch_id",
      `ALTER TABLE orders ADD COLUMN batch_id BIGINT(20) UNSIGNED DEFAULT NULL`,
    ],
    [
      "delivery_lat",
      `ALTER TABLE orders ADD COLUMN delivery_lat DECIMAL(9,6) DEFAULT NULL`,
    ],
    [
      "delivery_lng",
      `ALTER TABLE orders ADD COLUMN delivery_lng DECIMAL(9,6) DEFAULT NULL`,
    ],
    [
      "platform_fee",
      `ALTER TABLE orders ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0.00`,
    ],
    [
      "merchant_delivery_fee",
      `ALTER TABLE orders ADD COLUMN merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL`,
    ],
    [
      "delivery_batch_id",
      `ALTER TABLE orders ADD COLUMN delivery_batch_id BIGINT(20) UNSIGNED DEFAULT NULL`,
    ],
    [
      "delivery_driver_id",
      `ALTER TABLE orders ADD COLUMN delivery_driver_id INT(11) DEFAULT NULL`,
    ],
    [
      "delivery_status",
      `ALTER TABLE orders ADD COLUMN delivery_status ENUM('PENDING','ASSIGNED','PICKED_UP','ON_ROAD','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING'`,
    ],
    [
      "delivery_ride_id",
      `ALTER TABLE orders ADD COLUMN delivery_ride_id BIGINT(20) DEFAULT NULL`,
    ],
    [
      "if_unavailable",
      `ALTER TABLE orders ADD COLUMN if_unavailable VARCHAR(256) DEFAULT NULL`,
    ],
    [
      "status_reason",
      `ALTER TABLE orders ADD COLUMN status_reason VARCHAR(255) DEFAULT NULL`,
    ],
    [
      "fulfillment_type",
      `ALTER TABLE orders ADD COLUMN fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery'`,
    ],
    ["priority", `ALTER TABLE orders ADD COLUMN priority TINYINT(1) DEFAULT 0`],
    [
      "estimated_arrivial_time",
      `ALTER TABLE orders ADD COLUMN estimated_arrivial_time VARCHAR(40) DEFAULT NULL`,
    ],
    [
      "delivery_floor_unit",
      `ALTER TABLE orders ADD COLUMN delivery_floor_unit VARCHAR(80) DEFAULT NULL`,
    ],
    [
      "delivery_instruction_note",
      `ALTER TABLE orders ADD COLUMN delivery_instruction_note VARCHAR(256) DEFAULT NULL`,
    ],

    // ✅ existing single url (legacy)
    [
      "delivery_photo_url",
      `ALTER TABLE orders ADD COLUMN delivery_photo_url TEXT NULL`,
    ],

    // ✅ NEW: list of urls (stored as JSON string)
    [
      "delivery_photo_urls",
      `ALTER TABLE orders ADD COLUMN delivery_photo_urls TEXT NULL`,
    ],

    [
      "delivery_special_mode",
      `ALTER TABLE orders ADD COLUMN delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL`,
    ],

    // ✅ NEW: store exact time order was marked DELIVERED
    [
      "delivered_at",
      `ALTER TABLE orders ADD COLUMN delivered_at DATETIME NULL`,
    ],
  ];

  for (const [col, ddl] of ordersCols) {
    await ensureColumn("orders", col, ddl);
  }

  // ✅ IMPORTANT: if column existed as VARCHAR(500), upgrade it to TEXT
  await ensureColumnType(
    "orders",
    "delivery_photo_url",
    (info) => {
      const t = String(info.DATA_TYPE || "").toLowerCase();
      return (
        t !== "text" && t !== "mediumtext" && t !== "longtext" && t !== "json"
      );
    },
    `ALTER TABLE orders MODIFY COLUMN delivery_photo_url TEXT NULL`,
  );

  // Ensure indexes exist (idempotent)
  await ensureIndex(
    "orders",
    "idx_orders_user",
    "CREATE INDEX idx_orders_user ON orders(user_id)",
  );
  await ensureIndex(
    "orders",
    "idx_orders_created",
    "CREATE INDEX idx_orders_created ON orders(created_at)",
  );
  await ensureIndex(
    "orders",
    "idx_orders_batch_id",
    "CREATE INDEX idx_orders_batch_id ON orders(batch_id)",
  );
  await ensureIndex(
    "orders",
    "idx_orders_business_service_created",
    "CREATE INDEX idx_orders_business_service_created ON orders(business_id, service_type, created_at)",
  );

  /* -------- Order items -------- */
  await db.query(`
CREATE TABLE IF NOT EXISTS order_items (
  item_id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(12) NOT NULL,
  business_id INT NOT NULL,
  business_name VARCHAR(255) NOT NULL,
  menu_id INT NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  item_image VARCHAR(500),
  quantity INT NOT NULL DEFAULT 1,
  price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  platform_fee DECIMAL(10,2) DEFAULT 0,
  delivery_fee DECIMAL(10,2) DEFAULT 0,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  await ensureColumn(
    "order_items",
    "platform_fee",
    `ALTER TABLE order_items ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`,
  );
  await ensureColumn(
    "order_items",
    "delivery_fee",
    `ALTER TABLE order_items ADD COLUMN delivery_fee DECIMAL(10,2) DEFAULT 0`,
  );

  await ensureIndex(
    "order_items",
    "idx_items_order",
    "CREATE INDEX idx_items_order ON order_items(order_id)",
  );
  await ensureIndex(
    "order_items",
    "idx_items_biz_order",
    "CREATE INDEX idx_items_biz_order ON order_items(business_id, order_id)",
  );

  /* -------- Order notification -------- */
  await db.query(`
CREATE TABLE IF NOT EXISTS order_notification (
  notification_id CHAR(36) PRIMARY KEY,
  order_id VARCHAR(12) NOT NULL,
  business_id INT NOT NULL,
  user_id INT NOT NULL,
  type VARCHAR(64) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body_preview VARCHAR(220) NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP NULL,
  seen_at TIMESTAMP NULL,
  INDEX idx_notif_merchant_time (business_id, created_at DESC),
  INDEX idx_notif_merchant_unread (business_id, is_read, created_at DESC),
  INDEX idx_notif_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  /* -------- Order wallet captures (idempotency) -------- */
  await db.query(`
CREATE TABLE IF NOT EXISTS order_wallet_captures (
  order_id      VARCHAR(32) NOT NULL,
  capture_type  VARCHAR(32) NOT NULL,   -- WALLET_FULL | COD_FEE
  captured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  buyer_txn_id  VARCHAR(64) DEFAULT NULL,
  merch_txn_id  VARCHAR(64) DEFAULT NULL,
  admin_txn_id  VARCHAR(64) DEFAULT NULL,
  PRIMARY KEY (order_id, capture_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  /* ================= Cancelled archive tables ================= */

  await db.query(`
CREATE TABLE IF NOT EXISTS cancelled_orders (
  cancelled_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(12) NOT NULL,
  user_id INT NOT NULL,

  status VARCHAR(100) NOT NULL DEFAULT 'CANCELLED',
  status_reason VARCHAR(255) NULL,

  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL,

  payment_method ENUM('COD','WALLET','CARD') NOT NULL,

  delivery_address VARCHAR(500) NOT NULL,
  note_for_restaurant VARCHAR(500),
  if_unavailable VARCHAR(256),

  delivery_floor_unit VARCHAR(80) DEFAULT NULL,
  delivery_instruction_note VARCHAR(256) DEFAULT NULL,

  -- ✅ UPDATED: TEXT
  delivery_photo_url TEXT NULL,

  delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL,

  fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery',
  priority BOOLEAN DEFAULT 0,
  estimated_arrivial_time VARCHAR(40) DEFAULT NULL,

  cancelled_by ENUM('USER','MERCHANT','ADMIN','SYSTEM') NOT NULL DEFAULT 'USER',
  cancelled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  original_created_at TIMESTAMP NULL,
  original_updated_at TIMESTAMP NULL,

  PRIMARY KEY (cancelled_id),
  UNIQUE KEY uk_cancelled_order_id (order_id),
  INDEX idx_cancelled_user (user_id),
  INDEX idx_cancelled_time (cancelled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  if (await tableExists("cancelled_orders")) {
    const cancelledCols = [
      [
        "merchant_delivery_fee",
        `ALTER TABLE cancelled_orders ADD COLUMN merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL`,
      ],
      [
        "status_reason",
        `ALTER TABLE cancelled_orders ADD COLUMN status_reason VARCHAR(255) NULL`,
      ],
      [
        "cancelled_by",
        `ALTER TABLE cancelled_orders ADD COLUMN cancelled_by ENUM('USER','MERCHANT','ADMIN','SYSTEM') NOT NULL DEFAULT 'USER'`,
      ],
      [
        "original_created_at",
        `ALTER TABLE cancelled_orders ADD COLUMN original_created_at TIMESTAMP NULL`,
      ],
      [
        "original_updated_at",
        `ALTER TABLE cancelled_orders ADD COLUMN original_updated_at TIMESTAMP NULL`,
      ],
      [
        "delivery_floor_unit",
        `ALTER TABLE cancelled_orders ADD COLUMN delivery_floor_unit VARCHAR(80) DEFAULT NULL`,
      ],
      [
        "delivery_instruction_note",
        `ALTER TABLE cancelled_orders ADD COLUMN delivery_instruction_note VARCHAR(256) DEFAULT NULL`,
      ],
      [
        "delivery_photo_url",
        `ALTER TABLE cancelled_orders ADD COLUMN delivery_photo_url TEXT NULL`,
      ],
      [
        "delivery_special_mode",
        `ALTER TABLE cancelled_orders ADD COLUMN delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL`,
      ],
    ];
    for (const [col, ddl] of cancelledCols) {
      await ensureColumn("cancelled_orders", col, ddl);
    }

    await ensureColumnType(
      "cancelled_orders",
      "delivery_photo_url",
      (info) => {
        const t = String(info.DATA_TYPE || "").toLowerCase();
        return (
          t !== "text" && t !== "mediumtext" && t !== "longtext" && t !== "json"
        );
      },
      `ALTER TABLE cancelled_orders MODIFY COLUMN delivery_photo_url TEXT NULL`,
    );
  }

  await db.query(`
CREATE TABLE IF NOT EXISTS cancelled_order_items (
  cancelled_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(12) NOT NULL,

  business_id INT NOT NULL,
  business_name VARCHAR(255) NOT NULL,

  menu_id INT NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  item_image VARCHAR(500),

  quantity INT NOT NULL DEFAULT 1,
  price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (cancelled_item_id),
  INDEX idx_cancelled_items_order (order_id),
  INDEX idx_cancelled_items_biz (business_id),
  CONSTRAINT fk_cancelled_items_order
    FOREIGN KEY (order_id) REFERENCES cancelled_orders(order_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  /* ================= Delivered archive tables ================= */

  await db.query(`
CREATE TABLE IF NOT EXISTS delivered_orders (
  delivered_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(12) NOT NULL,
  user_id INT NOT NULL,

  service_type ENUM('FOOD','MART') NOT NULL DEFAULT 'FOOD',

  status VARCHAR(100) NOT NULL DEFAULT 'COMPLETED',
  status_reason VARCHAR(255) NULL,

  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(10,2) DEFAULT 0,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL,

  payment_method ENUM('COD','WALLET','CARD') NOT NULL,

  delivery_address VARCHAR(500) NOT NULL,
  note_for_restaurant VARCHAR(500),
  if_unavailable VARCHAR(256),

  delivery_floor_unit VARCHAR(80) DEFAULT NULL,
  delivery_instruction_note VARCHAR(256) DEFAULT NULL,

  -- ✅ UPDATED: TEXT
  delivery_photo_url TEXT NULL,

  delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL,

  fulfillment_type ENUM('Delivery','Pickup') DEFAULT 'Delivery',
  priority BOOLEAN DEFAULT 0,
  estimated_arrivial_time VARCHAR(40) DEFAULT NULL,

  delivered_by ENUM('USER','MERCHANT','ADMIN','SYSTEM','DRIVER') NOT NULL DEFAULT 'SYSTEM',
  delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  delivery_batch_id BIGINT(20) UNSIGNED DEFAULT NULL,
  delivery_driver_id INT(11) DEFAULT NULL,
  delivery_status ENUM('PENDING','ASSIGNED','PICKED_UP','ON_ROAD','DELIVERED','CANCELLED') NOT NULL DEFAULT 'DELIVERED',
  delivery_ride_id BIGINT(20) DEFAULT NULL,

  original_created_at TIMESTAMP NULL,
  original_updated_at TIMESTAMP NULL,

  PRIMARY KEY (delivered_id),
  UNIQUE KEY uk_delivered_order_id (order_id),
  INDEX idx_delivered_user (user_id),
  INDEX idx_delivered_time (delivered_at),
  INDEX idx_delivered_service_created (service_type, original_created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  if (await tableExists("delivered_orders")) {
    const deliveredCols = [
      [
        "service_type",
        `ALTER TABLE delivered_orders ADD COLUMN service_type ENUM('FOOD','MART') NOT NULL DEFAULT 'FOOD'`,
      ],
      [
        "status_reason",
        `ALTER TABLE delivered_orders ADD COLUMN status_reason VARCHAR(255) NULL`,
      ],
      [
        "merchant_delivery_fee",
        `ALTER TABLE delivered_orders ADD COLUMN merchant_delivery_fee DECIMAL(10,2) DEFAULT NULL`,
      ],
      [
        "delivered_by",
        `ALTER TABLE delivered_orders ADD COLUMN delivered_by ENUM('USER','MERCHANT','ADMIN','SYSTEM','DRIVER') NOT NULL DEFAULT 'SYSTEM'`,
      ],
      [
        "delivered_at",
        `ALTER TABLE delivered_orders ADD COLUMN delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      ],
      [
        "delivery_batch_id",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_batch_id BIGINT(20) UNSIGNED DEFAULT NULL`,
      ],
      [
        "delivery_driver_id",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_driver_id INT(11) DEFAULT NULL`,
      ],
      [
        "delivery_status",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_status ENUM('PENDING','ASSIGNED','PICKED_UP','ON_ROAD','DELIVERED','CANCELLED') NOT NULL DEFAULT 'DELIVERED'`,
      ],
      [
        "delivery_ride_id",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_ride_id BIGINT(20) DEFAULT NULL`,
      ],
      [
        "original_created_at",
        `ALTER TABLE delivered_orders ADD COLUMN original_created_at TIMESTAMP NULL`,
      ],
      [
        "original_updated_at",
        `ALTER TABLE delivered_orders ADD COLUMN original_updated_at TIMESTAMP NULL`,
      ],
      [
        "delivery_floor_unit",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_floor_unit VARCHAR(80) DEFAULT NULL`,
      ],
      [
        "delivery_instruction_note",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_instruction_note VARCHAR(256) DEFAULT NULL`,
      ],
      [
        "delivery_photo_url",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_photo_url TEXT NULL`,
      ],
      [
        "delivery_special_mode",
        `ALTER TABLE delivered_orders ADD COLUMN delivery_special_mode ENUM('DROP_OFF','MEET_UP') DEFAULT NULL`,
      ],
    ];

    for (const [col, ddl] of deliveredCols) {
      await ensureColumn("delivered_orders", col, ddl);
    }

    await ensureColumnType(
      "delivered_orders",
      "delivery_photo_url",
      (info) => {
        const t = String(info.DATA_TYPE || "").toLowerCase();
        return (
          t !== "text" && t !== "mediumtext" && t !== "longtext" && t !== "json"
        );
      },
      `ALTER TABLE delivered_orders MODIFY COLUMN delivery_photo_url TEXT NULL`,
    );
  }

  await db.query(`
CREATE TABLE IF NOT EXISTS delivered_order_items (
  delivered_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(12) NOT NULL,

  business_id INT NOT NULL,
  business_name VARCHAR(255) NOT NULL,

  menu_id INT NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  item_image VARCHAR(500),

  quantity INT NOT NULL DEFAULT 1,
  price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,

  platform_fee DECIMAL(10,2) DEFAULT 0,
  delivery_fee DECIMAL(10,2) DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (delivered_item_id),
  INDEX idx_delivered_items_order (order_id),
  INDEX idx_delivered_items_biz (business_id),
  CONSTRAINT fk_delivered_items_order
    FOREIGN KEY (order_id) REFERENCES delivered_orders(order_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  if (await tableExists("delivered_order_items")) {
    await ensureColumn(
      "delivered_order_items",
      "platform_fee",
      `ALTER TABLE delivered_order_items ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0`,
    );
    await ensureColumn(
      "delivered_order_items",
      "delivery_fee",
      `ALTER TABLE delivered_order_items ADD COLUMN delivery_fee DECIMAL(10,2) DEFAULT 0`,
    );
  }

  // Ensure indexes exist (idempotent)
  await ensureIndex(
    "delivered_orders",
    "idx_delivered_user",
    "CREATE INDEX idx_delivered_user ON delivered_orders(user_id)",
  );
  await ensureIndex(
    "delivered_orders",
    "idx_delivered_time",
    "CREATE INDEX idx_delivered_time ON delivered_orders(delivered_at)",
  );
  await ensureIndex(
    "delivered_orders",
    "idx_delivered_service_created",
    "CREATE INDEX idx_delivered_service_created ON delivered_orders(service_type, original_created_at)",
  );
  await ensureIndex(
    "delivered_order_items",
    "idx_delivered_items_order",
    "CREATE INDEX idx_delivered_items_order ON delivered_order_items(order_id)",
  );
  await ensureIndex(
    "delivered_order_items",
    "idx_delivered_items_biz",
    "CREATE INDEX idx_delivered_items_biz ON delivered_order_items(business_id)",
  );

  /* ================= NEW: FOOD/MART REVENUE SNAPSHOT TABLE =================
     Stores the same fields you are returning in fetchFoodMartRevenueReport
     so even if delivered_orders is trimmed per user, revenue stays forever.
  ========================================================================== */

  await db.query(`
CREATE TABLE IF NOT EXISTS food_mart_revenue (
  revenue_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- identity
  order_id VARCHAR(12) NOT NULL,
  user_id INT NOT NULL,
  business_id INT NOT NULL,

  -- classification
  owner_type ENUM('FOOD','MART') NOT NULL,
  source ENUM('orders','cancelled','delivered') NOT NULL DEFAULT 'delivered',

  -- order fields snapshot
  status VARCHAR(100) DEFAULT NULL,
  placed_at TIMESTAMP NULL DEFAULT NULL,
  payment_method VARCHAR(16) DEFAULT NULL,

  -- money snapshot (what you show in report)
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  revenue_earned DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- display fields snapshot
  customer_name VARCHAR(255) DEFAULT NULL,
  customer_phone VARCHAR(64) DEFAULT NULL,
  business_name VARCHAR(255) DEFAULT NULL,
  items_summary TEXT NULL,
  total_quantity INT NOT NULL DEFAULT 0,

  -- full payload snapshot (same structure as controller returns)
  details_json LONGTEXT NULL,

  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (revenue_id),
  UNIQUE KEY uk_food_mart_revenue_order (order_id),
  KEY idx_fmr_owner_time (owner_type, placed_at),
  KEY idx_fmr_biz_time (business_id, placed_at),
  KEY idx_fmr_user_time (user_id, placed_at),
  KEY idx_fmr_source_time (source, placed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

  // Patches for older installs (safe)
  if (await tableExists("food_mart_revenue")) {
    const fmrCols = [
      [
        "source",
        `ALTER TABLE food_mart_revenue ADD COLUMN source ENUM('orders','cancelled','delivered') NOT NULL DEFAULT 'delivered'`,
      ],
      [
        "status",
        `ALTER TABLE food_mart_revenue ADD COLUMN status VARCHAR(100) DEFAULT NULL`,
      ],
      [
        "placed_at",
        `ALTER TABLE food_mart_revenue ADD COLUMN placed_at TIMESTAMP NULL DEFAULT NULL`,
      ],
      [
        "payment_method",
        `ALTER TABLE food_mart_revenue ADD COLUMN payment_method VARCHAR(16) DEFAULT NULL`,
      ],
      [
        "revenue_earned",
        `ALTER TABLE food_mart_revenue ADD COLUMN revenue_earned DECIMAL(10,2) NOT NULL DEFAULT 0.00`,
      ],
      [
        "tax",
        `ALTER TABLE food_mart_revenue ADD COLUMN tax DECIMAL(10,2) NOT NULL DEFAULT 0.00`,
      ],
      [
        "customer_name",
        `ALTER TABLE food_mart_revenue ADD COLUMN customer_name VARCHAR(255) DEFAULT NULL`,
      ],
      [
        "customer_phone",
        `ALTER TABLE food_mart_revenue ADD COLUMN customer_phone VARCHAR(64) DEFAULT NULL`,
      ],
      [
        "business_name",
        `ALTER TABLE food_mart_revenue ADD COLUMN business_name VARCHAR(255) DEFAULT NULL`,
      ],
      [
        "items_summary",
        `ALTER TABLE food_mart_revenue ADD COLUMN items_summary TEXT NULL`,
      ],
      [
        "total_quantity",
        `ALTER TABLE food_mart_revenue ADD COLUMN total_quantity INT NOT NULL DEFAULT 0`,
      ],
      [
        "details_json",
        `ALTER TABLE food_mart_revenue ADD COLUMN details_json LONGTEXT NULL`,
      ],
      [
        "created_at",
        `ALTER TABLE food_mart_revenue ADD COLUMN created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP`,
      ],
    ];

    for (const [col, ddl] of fmrCols) {
      await ensureColumn("food_mart_revenue", col, ddl);
    }

    // ensure details_json is LONGTEXT (in case it was TEXT)
    await ensureColumnType(
      "food_mart_revenue",
      "details_json",
      (info) => {
        const t = String(info.DATA_TYPE || "").toLowerCase();
        return t !== "longtext" && t !== "json";
      },
      `ALTER TABLE food_mart_revenue MODIFY COLUMN details_json LONGTEXT NULL`,
    );

    // indexes (idempotent)
    await ensureIndex(
      "food_mart_revenue",
      "uk_food_mart_revenue_order",
      "CREATE UNIQUE INDEX uk_food_mart_revenue_order ON food_mart_revenue(order_id)",
    );
    await ensureIndex(
      "food_mart_revenue",
      "idx_fmr_owner_time",
      "CREATE INDEX idx_fmr_owner_time ON food_mart_revenue(owner_type, placed_at)",
    );
    await ensureIndex(
      "food_mart_revenue",
      "idx_fmr_biz_time",
      "CREATE INDEX idx_fmr_biz_time ON food_mart_revenue(business_id, placed_at)",
    );
    await ensureIndex(
      "food_mart_revenue",
      "idx_fmr_user_time",
      "CREATE INDEX idx_fmr_user_time ON food_mart_revenue(user_id, placed_at)",
    );
    await ensureIndex(
      "food_mart_revenue",
      "idx_fmr_source_time",
      "CREATE INDEX idx_fmr_source_time ON food_mart_revenue(source, placed_at)",
    );
  }

  console.log(
    "✅ orders*, order_items, order_notification, order_wallet_captures, cancelled_orders*, cancelled_order_items*, delivered_orders*, delivered_order_items*, food_mart_revenue are ready (version-safe).",
  );
}

module.exports = { initOrderManagementTable };
