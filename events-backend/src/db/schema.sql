-- users table already exists in Superapp_production (user_id BIGINT, user_name, email, phone, ...)
-- We only create the events-module tables here.

CREATE TABLE IF NOT EXISTS organizers (
  id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  category ENUM('cinema','concert','festival','workshop','experience') NOT NULL,
  city VARCHAR(100) NOT NULL,
  venue_name VARCHAR(255) NOT NULL,
  venue_address VARCHAR(255),
  organizer_name VARCHAR(255),
  organizer_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  cover_image VARCHAR(500),
  description TEXT,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  is_live TINYINT(1) DEFAULT 0,
  avg_rating DECIMAL(3,2) DEFAULT 0.00,
  total_reviews INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organizer_id) REFERENCES organizers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_tiers (
  id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  price INT NOT NULL,
  available_seats INT NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
  ticket_code VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci UNIQUE NOT NULL,
  user_id BIGINT(20) UNSIGNED NOT NULL,
  event_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  tier_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  quantity INT NOT NULL,
  total_amount INT NOT NULL,
  payment_method ENUM('WALLET','CARD','UPI') NOT NULL,
  attendee_names JSON NOT NULL,
  status ENUM('confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (tier_id) REFERENCES ticket_tiers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  user_id BIGINT(20) UNSIGNED NOT NULL,
  rating TINYINT NOT NULL,
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review (event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wishlists (
  user_id BIGINT(20) UNSIGNED NOT NULL,
  event_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organizer_revenue_share (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  organizer_id          CHAR(36) NOT NULL UNIQUE,
  total_revenue         DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  org_share_pct         DECIMAL(5,2)  NOT NULL DEFAULT 80.00,
  tabdey_share_pct      DECIMAL(5,2)  NOT NULL DEFAULT 20.00,
  total_org_revenue     DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  total_tabdey_revenue  DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by            BIGINT UNSIGNED NULL,
  FOREIGN KEY (organizer_id) REFERENCES event_organizers(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by)   REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
