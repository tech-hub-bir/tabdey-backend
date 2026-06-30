const pool = require("../config/db");

const tables = [
  {
    name: "users",
    sql: `
     CREATE TABLE users (
      user_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_name VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      phone VARCHAR(20) UNIQUE NOT NULL,
      cid VARCHAR(11) UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',

      -- ⭐ Points column
      points BIGINT UNSIGNED NOT NULL DEFAULT 0,

      profile_image VARCHAR(255) NOT NULL DEFAULT '/uploads/profiles/default.png',  
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      is_verified TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      last_login TIMESTAMP NULL,
      INDEX (email),
      INDEX (phone),
      INDEX (is_active),
      INDEX (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },

  // ✅ Point system config for users
  {
    name: "point_system",
    sql: `
      CREATE TABLE point_system (
        point_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        -- Minimum order amount required to earn one "unit" of points
        min_amount_per_point DECIMAL(10,2) NOT NULL,
        -- How many points to award per "unit"
        point_to_award INT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },

  {
    name: "user_verification",
    sql: `
      CREATE TABLE user_verification (
        verification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        verification_type ENUM('email', 'phone', '2fa') NOT NULL,
        token VARCHAR(100) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        is_used TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        INDEX (token),
        INDEX (expires_at),
        INDEX (verification_type, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  {
    name: "drivers",
    sql: `
      CREATE TABLE drivers (
        driver_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED UNIQUE,
        license_number VARCHAR(50) COLLATE utf8mb4_bin UNIQUE NOT NULL,
        license_expiry DATE NOT NULL,
        is_approved TINYINT(1) DEFAULT 0,
        approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        approved_at TIMESTAMP NULL,
        rejection_reason TEXT,
        rating DECIMAL(3,2) UNSIGNED DEFAULT 0.0,
        total_rides INT UNSIGNED DEFAULT 0,
      
        is_online TINYINT(1) DEFAULT 0,
        current_location POINT SRID 4326 NOT NULL,
        current_location_updated_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        SPATIAL INDEX (current_location),
        INDEX (approval_status),
        INDEX (is_online)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  {
    name: "driver_documents",
    sql: `
      CREATE TABLE driver_documents (
        document_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        driver_id BIGINT UNSIGNED NOT NULL,
        document_type ENUM('license', 'insurance', 'registration', 'profile') NOT NULL,
        document_url VARCHAR(255) NOT NULL,
        verification_status ENUM('pending', 'verified', 'rejected') DEFAULT 'pending',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_at TIMESTAMP NULL,
        verified_by BIGINT UNSIGNED,
        metadata JSON,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id) ON DELETE CASCADE,
        INDEX (verification_status),
        INDEX (document_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  {
    name: "driver_vehicles",
    sql: `
      CREATE TABLE driver_vehicles (
        vehicle_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        driver_id BIGINT UNSIGNED NOT NULL,
        make VARCHAR(50) NOT NULL,
        model VARCHAR(50) NOT NULL,
        year SMALLINT UNSIGNED NOT NULL,
        color VARCHAR(30) NOT NULL,
        license_plate VARCHAR(255) COLLATE utf8mb4_bin UNIQUE NOT NULL,
        vehicle_type VARCHAR(255) NOT NULL,
        is_approved TINYINT(1) DEFAULT 0,
        actual_capacity INT UNSIGNED DEFAULT 0,
        available_capacity INT UNSIGNED DEFAULT 0,
        features SET('wifi', 'child_seat', 'pet_friendly', 'wheelchair', 'extra_luggage','ac'),
        insurance_expiry DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES drivers(driver_id) ON DELETE CASCADE,
        INDEX (vehicle_type),
        INDEX (is_approved)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  // New user_devices table
  {
    name: "user_devices",
    sql: `
      CREATE TABLE user_devices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        UNIQUE KEY unique_user_device (user_id, device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  // New driver_devices table
  {
    name: "driver_devices",
    sql: `
      CREATE TABLE driver_devices (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        UNIQUE KEY unique_driver_device (user_id, device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `,
  },
  {
    name: "notifications",
    sql: `
      CREATE TABLE notifications (
        id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id      BIGINT UNSIGNED NOT NULL,
        type         VARCHAR(50) NOT NULL,          
        title        VARCHAR(100) NOT NULL,
        message      TEXT NOT NULL,
        data         JSON DEFAULT NULL,            
        status       ENUM('unread','read') DEFAULT 'unread',
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id)
      );
    `,
  },
  {
    name: "all_device_ids",
    sql: `
    CREATE TABLE all_device_ids (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uniq_user (user_id),          -- ✅ one device per user
  INDEX idx_device_id (device_id),

  CONSTRAINT fk_all_device_ids_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `,
  },
];

const checkAndCreateTables = async () => {
  const conn = await pool.getConnection();
  try {
    for (const table of tables) {
      const [exists] = await conn.query(`SHOW TABLES LIKE ?`, [table.name]);
      if (exists.length === 0) {
        console.log(`Creating table: ${table.name}`);
        await conn.query(table.sql);
        console.log(`✅ Table "${table.name}" created`);
      } else {
        // Table already exists — you can enable logging here if you want
        // console.log(`✅ Table "${table.name}" already exists`);
      }
    }
  } catch (err) {
    console.error(`❌ Error initializing tables:`, err.message);
  } finally {
    conn.release();
  }
};

module.exports = { checkAndCreateTables };
