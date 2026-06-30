const db = require("../config/db");

/* ---------------- helpers ---------------- */
async function tableExists(tableName) {
  const [rows] = await db.query(`SHOW TABLES LIKE ?`, [tableName]);
  return rows.length > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName],
  );
  return rows.length > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await db.query(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [tableName, indexName],
  );
  return rows.length > 0;
}

async function fkConstraintNamesForColumn(tableName, columnName) {
  const [rows] = await db.query(
    `SELECT tc.CONSTRAINT_NAME AS name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND tc.TABLE_NAME = kcu.TABLE_NAME
        AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND kcu.COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return rows.map((r) => r.name);
}

async function executeIgnoreErr(sql, params = []) {
  try {
    await db.query(sql, params);
  } catch {}
}

// Read the exact COLUMN_TYPE (e.g., "BIGINT UNSIGNED")
async function getColumnType(table, column) {
  const [r] = await db.query(
    `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );
  return r[0]?.COLUMN_TYPE || null;
}

// Ensure a table column matches a reference type; drop & re-add FK if needed
async function ensureColumnTypeMatches({
  table,
  column,
  refTable,
  refColumn,
  desiredType,
  fkName,
}) {
  const refType = desiredType || (await getColumnType(refTable, refColumn));
  if (!refType) {
    throw new Error(
      `Cannot determine type of ${refTable}.${refColumn}. Create that table first.`,
    );
  }

  const [r] = await db.query(
    `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );
  const curType = r[0]?.COLUMN_TYPE || null;

  // Drop any existing FKs on the column
  const fks = await fkConstraintNamesForColumn(table, column);
  for (const name of fks) {
    await executeIgnoreErr(
      `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``,
    );
  }

  // Add/modify column to match referenced type
  if (curType == null) {
    await db.query(
      `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${refType} NOT NULL`,
    );
  } else if (curType.toUpperCase() !== refType.toUpperCase()) {
    await db.query(
      `ALTER TABLE \`${table}\` MODIFY \`${column}\` ${refType} NOT NULL`,
    );
  }

  // Re-add FK
  await db.query(
    `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${fkName}\`
       FOREIGN KEY (\`${column}\`)
       REFERENCES \`${refTable}\`(\`${refColumn}\`)
       ON DELETE CASCADE ON UPDATE CASCADE`,
  );
}

/* --------------- creators --------------- */
async function ensureBusinessTypesTable() {
  const table = "business_types";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        image VARCHAR(255),
        types VARCHAR(255),
        description TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureMerchantBusinessDetailsTable() {
  const table = "merchant_business_details";
  if (!(await tableExists(table))) {
    await db.query(`
  CREATE TABLE ${table} (
    business_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    owner_type VARCHAR(50),
    business_name VARCHAR(255) NOT NULL,
    business_license_number VARCHAR(100),
    license_image VARCHAR(255),
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    address TEXT,
    business_logo VARCHAR(255),
    delivery_option VARCHAR(50),
    min_amount_for_fd DECIMAL(10,2) DEFAULT NULL,
    complementary VARCHAR(100),
    complementary_details TEXT,
    opening_time TIME,
    closing_time TIME,
    kitchen_closing_time TIME DEFAULT NULL,  -- ✅ NEW COLUMN
    holidays JSON,
    special_celebration VARCHAR(255) DEFAULT NULL,
    special_celebration_discount_percentage DECIMAL(5,2) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE ON UPDATE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);
  } else {
    // Add the new columns if they don't exist already
    const columnExistsCheck1 = await columnExists(table, "special_celebration");
    const columnExistsCheck2 = await columnExists(
      table,
      "special_celebration_discount_percentage",
    );

    if (!columnExistsCheck1) {
      await db.query(`
        ALTER TABLE ${table}
        ADD COLUMN special_celebration VARCHAR(255) DEFAULT NULL;
      `);
    }

    if (!columnExistsCheck2) {
      await db.query(`
        ALTER TABLE ${table}
        ADD COLUMN special_celebration_discount_percentage DECIMAL(5,2) DEFAULT 0;
      `);
    }
  }
}

async function ensureMerchantBusinessTypesTable() {
  const table = "merchant_business_types";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        business_type_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (business_type_id) REFERENCES business_types(id) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureFoodCategoryTable() {
  const table = "food_category";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        category_name VARCHAR(100) NOT NULL,
        business_type VARCHAR(100),
        description TEXT,
        category_image VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_category_name (category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureMartCategoryTable() {
  const table = "mart_category";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        category_name VARCHAR(100) NOT NULL,
        business_type VARCHAR(100),
        description TEXT,
        category_image VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_category_name (category_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

async function ensureBusinessBannersTable() {
  const table = "business_banners";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        title VARCHAR(255),
        description TEXT,
        banner_image VARCHAR(255),
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        start_date DATE,
        end_date DATE,
        owner_type ENUM('food','mart') NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_business_owner_created (business_id, owner_type, created_at),
        FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

/* ---------- NEW: BANNERS BASE PRICES ---------- */
async function ensureBannersBasePricesTable() {
  const table = "banners_base_prices";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        banner_price_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        amount_per_day DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (banner_price_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

/* ---------- FOOD MENU ---------- */
async function ensureFoodMenuTable() {
  const table = "food_menu";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(100) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(255),
        actual_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        is_veg TINYINT(1) NOT NULL DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None',
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        stock_limit INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_food_menu_business (business_id),
        KEY idx_food_menu_cat (category_name),
        KEY idx_food_menu_available (is_available),
        UNIQUE KEY uk_foodmenu_biz_cat_name (business_id, category_name, item_name),
        FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

/* ---------- MART MENU ---------- */
async function ensureMartMenuTable() {
  const table = "mart_menu";
  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(100) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(255),
        actual_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        discount_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        is_veg TINYINT(1) NOT NULL DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') NOT NULL DEFAULT 'None',
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        stock_limit INT NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_mart_menu_business (business_id),
        KEY idx_mart_menu_cat (category_name),
        KEY idx_mart_menu_available (is_available),
        UNIQUE KEY uk_martmenu_biz_cat_name (business_id, category_name, item_name),
        FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }
}

/* ---------- FOOD RATINGS (uses business_id, allows many per user) ---------- */
async function ensureFoodRatingsTable() {
  const newName = "food_ratings";
  const oldName = "food_menu_ratings";

  // If legacy table exists and new doesn't, rename it
  if (await tableExists(oldName)) {
    if (!(await tableExists(newName))) {
      await db.query(`RENAME TABLE \`${oldName}\` TO \`${newName}\``);
    }
  }

  // Create fresh if still missing
  if (!(await tableExists(newName))) {
    await db.query(`
      CREATE TABLE \`${newName}\` (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        rating TINYINT UNSIGNED NOT NULL,
        comment TEXT NULL,
        likes_count INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fr_business (business_id),
        KEY idx_fr_user (user_id),
        KEY idx_fr_rating (rating)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  // Migrate: if column menu_id exists, add business_id, backfill via food_menu, drop menu_id
  const hasMenuId = await columnExists(newName, "menu_id");
  if (hasMenuId && !(await columnExists(newName, "business_id"))) {
    await db.query(
      `ALTER TABLE \`${newName}\` ADD COLUMN business_id BIGINT UNSIGNED NULL AFTER id`,
    );
  }
  if (hasMenuId) {
    await executeIgnoreErr(`
      UPDATE ${newName} fr
      JOIN food_menu fm ON fm.id = fr.menu_id
         SET fr.business_id = fm.business_id
       WHERE fr.business_id IS NULL
    `);
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` MODIFY business_id BIGINT UNSIGNED NOT NULL`,
    );
    await executeIgnoreErr(`ALTER TABLE \`${newName}\` DROP COLUMN menu_id`);
  }

  // Drop any legacy UNIQUE that blocks multiple feedbacks per (business_id,user_id)
  const legacyUniques = [
    "uk_fmr_menu_user",
    "uk_fr_business_user",
    "menu_id_user_id",
    "business_id_user_id",
  ];
  for (const idx of legacyUniques) {
    if (await indexExists(newName, idx)) {
      await executeIgnoreErr(
        `ALTER TABLE \`${newName}\` DROP INDEX \`${idx}\``,
      );
    }
  }

  // Ensure indexes
  if (!(await indexExists(newName, "idx_fr_business"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_fr_business (business_id)`,
    );
  }
  if (!(await indexExists(newName, "idx_fr_user"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_fr_user (user_id)`,
    );
  }
  if (!(await indexExists(newName, "idx_fr_rating"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_fr_rating (rating)`,
    );
  }

  // Recreate clean FKs
  for (const col of ["business_id", "user_id"]) {
    const fks = await fkConstraintNamesForColumn(newName, col);
    for (const name of fks) {
      await executeIgnoreErr(
        `ALTER TABLE \`${newName}\` DROP FOREIGN KEY \`${name}\``,
      );
    }
  }
  await executeIgnoreErr(`
    ALTER TABLE \`${newName}\`
      ADD CONSTRAINT fk_fr_business
      FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id)
      ON DELETE CASCADE ON UPDATE CASCADE
  `);
  await executeIgnoreErr(`
    ALTER TABLE \`${newName}\`
      ADD CONSTRAINT fk_fr_user
      FOREIGN KEY (user_id) REFERENCES users(user_id)
      ON DELETE CASCADE ON UPDATE CASCADE
  `);

  // Rating guard (safe no-op if already exists on some MySQL versions)
  await executeIgnoreErr(
    `ALTER TABLE \`${newName}\` ADD CONSTRAINT chk_fr_rating CHECK (rating BETWEEN 1 AND 5)`,
  );
}

/* ---------- MART RATINGS (uses business_id, allows many per user) ---------- */
async function ensureMartRatingsTable() {
  const newName = "mart_ratings";
  const oldName = "mart_menu_ratings";

  // If legacy table exists and new doesn't, rename it
  if (await tableExists(oldName)) {
    if (!(await tableExists(newName))) {
      await db.query(`RENAME TABLE \`${oldName}\` TO \`${newName}\``);
    }
  }

  // Create fresh if still missing
  if (!(await tableExists(newName))) {
    await db.query(`
      CREATE TABLE \`${newName}\` (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        rating TINYINT UNSIGNED NOT NULL,
        comment TEXT NULL,
        likes_count INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_mr_business (business_id),
        KEY idx_mr_user (user_id),
        KEY idx_mr_rating (rating)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  // Migrate: if column menu_id exists, add business_id, backfill via mart_menu, drop menu_id
  const hasMenuId = await columnExists(newName, "menu_id");
  if (hasMenuId && !(await columnExists(newName, "business_id"))) {
    await db.query(
      `ALTER TABLE \`${newName}\` ADD COLUMN business_id BIGINT UNSIGNED NULL AFTER id`,
    );
  }
  if (hasMenuId) {
    await executeIgnoreErr(`
      UPDATE ${newName} mr
      JOIN mart_menu mm ON mm.id = mr.menu_id
         SET mr.business_id = mm.business_id
       WHERE mr.business_id IS NULL
    `);
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` MODIFY business_id BIGINT UNSIGNED NOT NULL`,
    );
    await executeIgnoreErr(`ALTER TABLE \`${newName}\` DROP COLUMN menu_id`);
  }

  // Drop any legacy UNIQUE that blocks multiple feedbacks per (business_id,user_id)
  const legacyUniques = [
    "uk_mmr_menu_user",
    "uk_mr_business_user",
    "menu_id_user_id",
    "business_id_user_id",
  ];
  for (const idx of legacyUniques) {
    if (await indexExists(newName, idx)) {
      await executeIgnoreErr(
        `ALTER TABLE \`${newName}\` DROP INDEX \`${idx}\``,
      );
    }
  }

  // Ensure indexes
  if (!(await indexExists(newName, "idx_mr_business"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_mr_business (business_id)`,
    );
  }
  if (!(await indexExists(newName, "idx_mr_user"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_mr_user (user_id)`,
    );
  }
  if (!(await indexExists(newName, "idx_mr_rating"))) {
    await executeIgnoreErr(
      `ALTER TABLE \`${newName}\` ADD KEY idx_mr_rating (rating)`,
    );
  }

  // Recreate clean FKs
  for (const col of ["business_id", "user_id"]) {
    const fks = await fkConstraintNamesForColumn(newName, col);
    for (const name of fks) {
      await executeIgnoreErr(
        `ALTER TABLE \`${newName}\` DROP FOREIGN KEY \`${name}\``,
      );
    }
  }
  await executeIgnoreErr(`
    ALTER TABLE \`${newName}\`
      ADD CONSTRAINT fk_mr_business
      FOREIGN KEY (business_id) REFERENCES merchant_business_details(business_id)
      ON DELETE CASCADE ON UPDATE CASCADE
  `);
  await executeIgnoreErr(`
    ALTER TABLE \`${newName}\`
      ADD CONSTRAINT fk_mr_user
      FOREIGN KEY (user_id) REFERENCES users(user_id)
      ON DELETE CASCADE ON UPDATE CASCADE
  `);

  // Rating guard (safe no-op)
  await executeIgnoreErr(
    `ALTER TABLE \`${newName}\` ADD CONSTRAINT chk_mr_rating CHECK (rating BETWEEN 1 AND 5)`,
  );
}

/* -------- merchant_bank_details -------- */
async function ensureMerchantBankDetailsTable() {
  const table = "merchant_bank_details";

  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE ${table} (
        bank_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        business_id BIGINT UNSIGNED NULL DEFAULT NULL,
        bank_name VARCHAR(255) NOT NULL,
        account_holder_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(50) NOT NULL,
        bank_qr_code_image TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (bank_id),
        KEY idx_mbd_user (user_id),
        KEY idx_mbd_business (business_id),
        CONSTRAINT fk_mbd_user
          FOREIGN KEY (user_id)
          REFERENCES users(user_id)
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT fk_mbd_business
          FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE SET NULL ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  } else {
    await ensureColumnTypeMatches({
      table,
      column: "business_id",
      refTable: "merchant_business_details",
      refColumn: "business_id",
      desiredType: null,
      fkName: "fk_mbd_business",
    });

    await ensureColumnTypeMatches({
      table,
      column: "user_id",
      refTable: "users",
      refColumn: "user_id",
      desiredType: null,
      fkName: "fk_mbd_user",
    });

    if (!(await indexExists(table, "idx_mbd_business"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_mbd_business (business_id)`,
      );
    }
    if (!(await indexExists(table, "idx_mbd_user"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_mbd_user (user_id)`,
      );
    }
  }
}

/* ---------- NEW: MERCHANT EARNINGS ---------- */
async function ensureMerchantEarningsTable() {
  const table = "merchant_earnings";

  if (!(await tableExists(table))) {
    await db.query(`
      CREATE TABLE \`${table}\` (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        business_id BIGINT UNSIGNED NOT NULL,
        \`date\` DATE NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        order_id VARCHAR(50) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_me_business_date (business_id, \`date\`),
        KEY idx_me_order (order_id),
        CONSTRAINT fk_me_business
          FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  } else {
    // If table already exists, ensure columns (safe adds)
    if (!(await columnExists(table, "business_id"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD COLUMN business_id BIGINT UNSIGNED NOT NULL`,
      );
    }
    if (!(await columnExists(table, "date"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD COLUMN \`date\` DATE NOT NULL`,
      );
    }
    if (!(await columnExists(table, "total_amount"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD COLUMN total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00`,
      );
    }
    if (!(await columnExists(table, "order_id"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD COLUMN order_id VARCHAR(50) NOT NULL`,
      );
    }

    // Ensure business_id column type matches merchant_business_details.business_id and FK exists
    await ensureColumnTypeMatches({
      table,
      column: "business_id",
      refTable: "merchant_business_details",
      refColumn: "business_id",
      desiredType: null,
      fkName: "fk_me_business",
    });

    // Ensure indexes
    if (!(await indexExists(table, "idx_me_business_date"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_me_business_date (business_id, \`date\`)`,
      );
    }
    if (!(await indexExists(table, "idx_me_order"))) {
      await executeIgnoreErr(
        `ALTER TABLE \`${table}\` ADD KEY idx_me_order (order_id)`,
      );
    }
  }
}

/* --------------- entrypoint --------------- */
async function initMerchantTables() {
  await ensureBusinessTypesTable();
  await ensureMerchantBusinessDetailsTable();
  await ensureMerchantBusinessTypesTable();
  await ensureMerchantBankDetailsTable();
  await ensureFoodCategoryTable();
  await ensureMartCategoryTable();
  await ensureBusinessBannersTable();
  await ensureBannersBasePricesTable(); // <<< NEW call added, everything else unchanged
  await ensureMerchantEarningsTable(); // <<< NEW: merchant earnings table
  await ensureFoodMenuTable();
  await ensureMartMenuTable();
  await ensureFoodRatingsTable(); // uses business_id; allows multiple feedbacks per user
  await ensureMartRatingsTable(); // uses business_id; allows multiple feedbacks per user
}

module.exports = { initMerchantTables };
