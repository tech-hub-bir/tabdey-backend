const db = require("../config/db");

async function initMenuTables() {
  try {
    // ===== FOOD MENU TABLE =====
    await db.query(`
      CREATE TABLE IF NOT EXISTS food_menu (
        id INT AUTO_INCREMENT PRIMARY KEY,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(255) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(500),
        actual_price DECIMAL(10,2) NOT NULL,            -- NEW
        discount_percentage DECIMAL(5,2) DEFAULT 0.00,  -- NEW
        tax_rate DECIMAL(5,2) DEFAULT 0.00,
        is_veg TINYINT(1) DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') DEFAULT 'None',
        is_available TINYINT(1) DEFAULT 1,
        stock_limit INT DEFAULT 0,
        sort_order INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        KEY idx_foodmenu_business (business_id),
        KEY idx_foodmenu_category (category_name),
        UNIQUE KEY uq_foodmenu_unique (business_id, category_name, item_name),

        CONSTRAINT fk_foodmenu_business FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ===== MART MENU TABLE =====
    await db.query(`
      CREATE TABLE IF NOT EXISTS mart_menu (
        id INT AUTO_INCREMENT PRIMARY KEY,
        business_id BIGINT UNSIGNED NOT NULL,
        category_name VARCHAR(255) NOT NULL,
        item_name VARCHAR(255) NOT NULL,
        description TEXT,
        item_image VARCHAR(500),
        actual_price DECIMAL(10,2) NOT NULL,            -- NEW
        discount_percentage DECIMAL(5,2) DEFAULT 0.00,  -- NEW
        tax_rate DECIMAL(5,2) DEFAULT 0.00,
        is_veg TINYINT(1) DEFAULT 0,
        spice_level ENUM('None','Mild','Medium','Hot') DEFAULT 'None',
        is_available TINYINT(1) DEFAULT 1,
        stock_limit INT DEFAULT 0,
        sort_order INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        KEY idx_martmenu_business (business_id),
        KEY idx_martmenu_category (category_name),
        UNIQUE KEY uq_martmenu_unique (business_id, category_name, item_name),

        CONSTRAINT fk_martmenu_business FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ===== CART TABLE =====
    await db.query(`
      CREATE TABLE IF NOT EXISTS carts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        business_id BIGINT UNSIGNED NOT NULL,
        owner_type ENUM('food','mart') NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        note_for_merchant TEXT NULL,
        fulfillment ENUM('pickup','delivery') DEFAULT 'pickup',
        business_name_snapshot VARCHAR(255) NULL,
        business_logo_snapshot VARCHAR(1024) NULL,
        subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_carts_user (user_id),
        KEY idx_carts_business (business_id),
        UNIQUE KEY uk_active_cart (user_id, business_id, owner_type, is_active),

        CONSTRAINT fk_carts_user FOREIGN KEY (user_id)
          REFERENCES users(user_id)
          ON DELETE CASCADE ON UPDATE CASCADE,

        CONSTRAINT fk_carts_business FOREIGN KEY (business_id)
          REFERENCES merchant_business_details(business_id)
          ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ===== CART ITEMS FOOD TABLE =====
    await db.query(`
      CREATE TABLE IF NOT EXISTS cart_items_food (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        cart_id BIGINT UNSIGNED NOT NULL,
        menu_id INT NOT NULL,  -- FK to food_menu(id)

        item_name_snapshot VARCHAR(255) NOT NULL,
        item_image_snapshot VARCHAR(1024) NULL,
        actual_price_snapshot DECIMAL(10,2) NOT NULL,
        discount_pct_snapshot DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        quantity INT NOT NULL DEFAULT 1,
        special_instructions TEXT NULL,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_cif_cart (cart_id),
        KEY idx_cif_menu (menu_id),

        CONSTRAINT fk_cif_cart FOREIGN KEY (cart_id)
          REFERENCES carts(id)
          ON DELETE CASCADE ON UPDATE CASCADE,

        CONSTRAINT fk_cif_menu FOREIGN KEY (menu_id)
          REFERENCES food_menu(id)
          ON DELETE RESTRICT ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // ===== CART ITEMS MART TABLE =====
    await db.query(`
      CREATE TABLE IF NOT EXISTS cart_items_mart (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        cart_id BIGINT UNSIGNED NOT NULL,
        menu_id INT NOT NULL,  -- FK to mart_menu(id)

        item_name_snapshot VARCHAR(255) NOT NULL,
        item_image_snapshot VARCHAR(1024) NULL,
        actual_price_snapshot DECIMAL(10,2) NOT NULL,
        discount_pct_snapshot DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        quantity INT NOT NULL DEFAULT 1,
        special_instructions TEXT NULL,

        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_cim_cart (cart_id),
        KEY idx_cim_menu (menu_id),

        CONSTRAINT fk_cim_cart FOREIGN KEY (cart_id)
          REFERENCES carts(id)
          ON DELETE CASCADE ON UPDATE CASCADE,

        CONSTRAINT fk_cim_menu FOREIGN KEY (menu_id)
          REFERENCES mart_menu(id)
          ON DELETE RESTRICT ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log(
      "✅ food_menu and mart_menu tables ensured with actual_price & discount_percentage, and additional cart tables created."
    );
  } catch (err) {
    console.error("❌ Error creating menu tables:", err);
  }
}

module.exports = initMenuTables;
