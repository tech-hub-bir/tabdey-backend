-- Run this in your MySQL (create database first: CREATE DATABASE grablike CHARACTER SET utf8mb4; USE grablike;)

CREATE TABLE IF NOT EXISTS drivers (
  driver_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  full_name        VARCHAR(255) NOT NULL,
  phone_e164       VARCHAR(32) NOT NULL UNIQUE,
  status           ENUM('active','suspended','offboarded') NOT NULL DEFAULT 'active',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rides (
  ride_id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  driver_id         BIGINT UNSIGNED NULL,
  passenger_id      BIGINT UNSIGNED NULL,
  service_type      VARCHAR(32) NOT NULL DEFAULT 'standard',
  status            ENUM('requested','offered_to_driver','accepted','arrived_pickup','started','completed','cancelled_driver','cancelled_rider','cancelled_system') NOT NULL,
  requested_at      DATETIME NOT NULL,
  accepted_at       DATETIME NULL,
  arrived_pickup_at DATETIME NULL,
  started_at        DATETIME NULL,
  completed_at      DATETIME NULL,
  cancelled_at      DATETIME NULL,
  cancel_reason     VARCHAR(255) NULL,
  offer_driver_id   BIGINT UNSIGNED NULL,
  offer_expire_at   DATETIME NULL,

  pickup_place      VARCHAR(255) NULL,
  dropoff_place     VARCHAR(255) NULL,
  pickup_lat        DOUBLE NULL,
  pickup_lng        DOUBLE NULL,
  dropoff_lat       DOUBLE NULL,
  dropoff_lng       DOUBLE NULL,

  distance_m        INT NULL,
  duration_s        INT NULL,

  currency          CHAR(3) NOT NULL DEFAULT 'BTN',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_rides_driver_completed (driver_id, completed_at),
  INDEX idx_rides_driver_requested (driver_id, requested_at),
  CONSTRAINT fk_rides_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS pool_batches (
  pool_batch_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  city_id        VARCHAR(64) NOT NULL,
  service_type   VARCHAR(32) NOT NULL,
  status         ENUM('forming','in_progress','completed','cancelled') NOT NULL DEFAULT 'forming',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at     DATETIME NULL,
  completed_at   DATETIME NULL,
  INDEX idx_pool_status (status, created_at)
) ENGINE=InnoDB;

ALTER TABLE rides
  ADD COLUMN trip_type ENUM('instant','pool') NOT NULL DEFAULT 'instant' AFTER service_type,
  ADD COLUMN pool_batch_id BIGINT UNSIGNED NULL AFTER trip_type,
  ADD CONSTRAINT fk_rides_pool_batch
    FOREIGN KEY (pool_batch_id) REFERENCES pool_batches(pool_batch_id),
  ADD INDEX idx_rides_pool_batch (pool_batch_id),
  ADD INDEX idx_rides_triptype_status (trip_type, status),
  ADD INDEX idx_rides_driver_active (driver_id, status, accepted_at),
  ADD INDEX idx_rides_passenger_active (passenger_id, status, requested_at);

CREATE TABLE IF NOT EXISTS ride_earnings (
  ride_id               BIGINT UNSIGNED PRIMARY KEY,
  base_cents            INT NOT NULL DEFAULT 0,
  distance_cents        INT NOT NULL DEFAULT 0,
  time_cents            INT NOT NULL DEFAULT 0,
  surge_cents           INT NOT NULL DEFAULT 0,
  tolls_cents           INT NOT NULL DEFAULT 0,
  tips_cents            INT NOT NULL DEFAULT 0,
  other_adj_cents       INT NOT NULL DEFAULT 0,
  platform_fee_cents    INT NOT NULL DEFAULT 0,
  tax_cents             INT NOT NULL DEFAULT 0,

  driver_earnings_cents INT AS (
    (base_cents + distance_cents + time_cents + surge_cents + tolls_cents + tips_cents + other_adj_cents)
    - (platform_fee_cents + tax_cents)
  ) STORED,

  CONSTRAINT fk_re_ride FOREIGN KEY (ride_id) REFERENCES rides(ride_id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE rides
  ADD COLUMN fare_cents INT UNSIGNED NULL AFTER duration_s;


-- Seed a driver and a couple of completed rides (for quick testing)
INSERT INTO drivers (full_name, phone_e164) VALUES ('Test Driver', '+97517123456')
ON DUPLICATE KEY UPDATE full_name=VALUES(full_name);

SET @driver := (SELECT driver_id FROM drivers WHERE phone_e164 = '+97517123456' LIMIT 1);

INSERT INTO rides
(driver_id, status, requested_at, accepted_at, arrived_pickup_at, started_at, completed_at, pickup_place, dropoff_place, distance_m, duration_s)
VALUES
(@driver, 'completed', NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 2 DAY, NOW() - INTERVAL 2 DAY, 'Changzamtog', 'Babesa', 4200, 900),
(@driver, 'completed', NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY, 'Olakha', 'Town', 3100, 700);

INSERT INTO ride_earnings (ride_id, base_cents, distance_cents, time_cents, platform_fee_cents)
SELECT ride_id, 5000, 3200, 800, 1500
FROM rides WHERE driver_id=@driver AND status='completed'
ON DUPLICATE KEY UPDATE base_cents=VALUES(base_cents);


-- Driver’s earnings-only components (what the driver “earns” from the trip)
CREATE TABLE driver_earnings (
  earning_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  driver_id         BIGINT UNSIGNED NOT NULL,
  ride_id           BIGINT UNSIGNED NOT NULL,

  base_fare_cents   INT UNSIGNED NOT NULL DEFAULT 0,
  time_cents        INT UNSIGNED NOT NULL DEFAULT 0,
  tips_cents        INT UNSIGNED NOT NULL DEFAULT 0,

  currency          CHAR(3) NOT NULL DEFAULT 'BTN',

  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (earning_id),
  UNIQUE KEY uniq_driver_ride (driver_id, ride_id),
  KEY idx_driver (driver_id),
  KEY idx_ride (ride_id),

  CONSTRAINT fk_de_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_de_ride FOREIGN KEY (ride_id) REFERENCES rides(ride_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);
ALTER TABLE driver_earnings
ADD COLUMN payment_method VARCHAR(20) NULL COMMENT 'Method used to pay the driver (e.g., cash, card, wallet)';

-- Platform amounts per ride/driver (fees, taxes)
CREATE TABLE platform_levies (
  levy_id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  driver_id            BIGINT UNSIGNED NOT NULL,
  ride_id              BIGINT UNSIGNED NOT NULL,

  platform_fee_cents   INT UNSIGNED NOT NULL DEFAULT 0,
  tax_cents            INT UNSIGNED NOT NULL DEFAULT 0,

  currency             CHAR(3) NOT NULL DEFAULT 'BTN',

  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (levy_id),
  UNIQUE KEY uniq_driver_ride (driver_id, ride_id),
  KEY idx_driver (driver_id),
  KEY idx_ride (ride_id),

  CONSTRAINT fk_pl_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_pl_ride FOREIGN KEY (ride_id) REFERENCES rides(ride_id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);
ALTER TABLE platform_levies
ADD COLUMN payment_method VARCHAR(20) NULL;

CREATE OR REPLACE VIEW v_driver_payouts AS
SELECT
  de.driver_id,
  de.ride_id,
  de.currency,
  de.base_fare_cents,
  de.time_cents,
  de.tips_cents,
  COALESCE(pl.platform_fee_cents, 0) AS platform_fee_cents,
  COALESCE(pl.tax_cents, 0)          AS tax_cents,
  GREATEST(
    0,
    (de.base_fare_cents + de.time_cents + de.tips_cents)
  ) AS total_cents
FROM driver_earnings de
LEFT JOIN platform_levies pl
  ON pl.driver_id = de.driver_id AND pl.ride_id = de.ride_id;


-- Fee rules (percentage, fixed, caps)
CREATE TABLE platform_fee_rules (
  rule_id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  country_code      CHAR(2)      NULL,
  city_id           VARCHAR(64)  NULL,
  service_type      VARCHAR(64)  NULL,     -- e.g. 'Delivery Bike'
  trip_type         VARCHAR(32)  NULL,     -- instant/scheduled/pool
  channel           VARCHAR(32)  NULL,     -- app/web/partner

  fee_type          ENUM('percent','fixed','mixed') NOT NULL,
  fee_percent_bp    INT UNSIGNED DEFAULT 0,   -- basis points (1% = 100)
  fee_fixed_cents   INT UNSIGNED DEFAULT 0,
  min_cents         INT UNSIGNED DEFAULT 0,
  max_cents         INT UNSIGNED DEFAULT 0,

  apply_on          ENUM('subtotal','fare_after_discounts','driver_take_home_base')
                    NOT NULL DEFAULT 'subtotal',

  priority          INT NOT NULL DEFAULT 100,  -- tie-breaker if multiple match
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  starts_at         DATETIME NOT NULL,
  ends_at           DATETIME NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_match (country_code, city_id, service_type, trip_type, channel, is_active, starts_at, ends_at)
);
CREATE TABLE platform_revenue (
  revenue_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  source_type ENUM('TRANSPORT','FOOD','MART') NOT NULL,
  source_id VARCHAR(64) NOT NULL,   -- ride_id / order_id

  gross_amount_cents INT UNSIGNED NOT NULL,   -- before tax
  tax_cents INT UNSIGNED NOT NULL,             -- GST
  net_revenue_cents INT UNSIGNED NOT NULL,     -- your real income

  commission_type ENUM('PERCENT','FIXED') NOT NULL,
  commission_rate_bp INT UNSIGNED DEFAULT 0,   -- for % commissions
  commission_fixed_cents INT UNSIGNED DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_source (source_type, source_id),
  KEY idx_revenue_date (created_at),
  KEY idx_source_type (source_type)
);

CREATE TABLE IF NOT EXISTS ride_pricing_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ride_id BIGINT NOT NULL UNIQUE,

  platform_fee_cents INT NOT NULL,
  gst_cents INT NOT NULL,
  total_payable_cents INT NOT NULL,
  driver_payout_cents INT NOT NULL,

  platform_fee_rule_id BIGINT NULL,
  tax_rule_id BIGINT NULL,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Tax rules (VAT/GST/TDS/etc.)
CREATE TABLE tax_rules (
  tax_rule_id       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  country_code      CHAR(2)      NULL,
  city_id           VARCHAR(64)  NULL,
  service_type      VARCHAR(64)  NULL,
  tax_type          ENUM('VAT','GST','TDS','DST','LOCAL_SURCHARGE') NOT NULL,

  rate_percent_bp   INT UNSIGNED NOT NULL,   -- basis points
  tax_inclusive     TINYINT(1) NOT NULL DEFAULT 0,  -- prices include tax?

  taxable_base      ENUM('platform_fee','fare_subtotal','fare_after_discounts','driver_earnings')
                    NOT NULL DEFAULT 'platform_fee',

  priority          INT NOT NULL DEFAULT 100,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  starts_at         DATETIME NOT NULL,
  ends_at           DATETIME NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_match (country_code, city_id, service_type, tax_type, is_active, starts_at, ends_at)
);

ALTER TABLE platform_levies
  ADD COLUMN fee_rule_id BIGINT UNSIGNED NULL,
  ADD COLUMN tax_rule_id BIGINT UNSIGNED NULL,
  ADD KEY idx_rules (fee_rule_id, tax_rule_id);


-- Who pays what when a rider cancels late
CREATE TABLE IF NOT EXISTS cancellation_rules (
  rule_id                           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  stage_from                        ENUM('accepted','arrived_pickup') NOT NULL,
  passenger_fee_cents               INT UNSIGNED NOT NULL DEFAULT 0,          -- fixed fee
  passenger_fee_percent_bp          INT UNSIGNED NOT NULL DEFAULT 0,          -- if you prefer % of fare
  payout_percent_to_driver_bp       INT UNSIGNED NOT NULL DEFAULT 10000,      -- 100% to driver by default
  is_active                         TINYINT(1) NOT NULL DEFAULT 1,
  priority                          INT NOT NULL DEFAULT 100,
  starts_at                         DATETIME NOT NULL,
  ends_at                           DATETIME NULL,
  created_at                        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cancellation_levies (
  levy_id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ride_id              BIGINT UNSIGNED NOT NULL,
  booking_id           BIGINT UNSIGNED NULL,
  fee_cents            INT NOT NULL,
  driver_share_cents   INT NOT NULL,
  platform_share_cents INT NOT NULL,
  stage                VARCHAR(32) NOT NULL,
  rule_id              BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_levies_ride (ride_id),
  KEY idx_levies_booking (booking_id),
  CONSTRAINT fk_levies_rides FOREIGN KEY (ride_id) REFERENCES rides(ride_id)
) ENGINE=InnoDB;

-- Sensible defaults:
-- after 'accepted': Nu 5, split 50/50
-- after 'arrived_pickup': Nu 10, 100% to driver
INSERT INTO cancellation_rules
(stage_from, passenger_fee_cents, passenger_fee_percent_bp, payout_percent_to_driver_bp,
 is_active, priority, starts_at, ends_at)
VALUES
('accepted',       500,  0,  5000, 1, 10, NOW(), '2099-12-31'),
('arrived_pickup', 1000, 0, 10000, 1,  5, NOW(), '2099-12-31')
ON DUPLICATE KEY UPDATE is_active=VALUES(is_active);


-- ride_bookings for pool seats (one row per passenger in a pool ride)
CREATE TABLE IF NOT EXISTS ride_bookings (
  booking_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ride_id        BIGINT UNSIGNED NOT NULL,
  passenger_id   BIGINT UNSIGNED NOT NULL,
  seats          INT UNSIGNED NOT NULL DEFAULT 1,

  status         ENUM('requested','accepted','arrived_pickup','started','completed','dropped',
                      'cancelled_passenger','cancelled_driver','cancelled_system') NOT NULL DEFAULT 'requested',

  requested_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at    DATETIME NULL,
  arrived_pickup_at DATETIME NULL,
  started_at     DATETIME NULL,
  completed_at   DATETIME NULL,
  cancelled_at   DATETIME NULL,
  cancel_reason  VARCHAR(255) NULL,

  pickup_place   VARCHAR(255) NULL,
  dropoff_place  VARCHAR(255) NULL,
  pickup_lat     DOUBLE NULL,
  pickup_lng     DOUBLE NULL,
  dropoff_lat    DOUBLE NULL,
  dropoff_lng    DOUBLE NULL,

  fare_cents     INT UNSIGNED NOT NULL DEFAULT 0,
  currency       CHAR(3) NOT NULL DEFAULT 'BTN',

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_ride (ride_id),
  KEY idx_passenger (passenger_id),
  KEY idx_status (status, requested_at),
  CONSTRAINT fk_rb_ride FOREIGN KEY (ride_id) REFERENCES rides(ride_id) ON DELETE CASCADE
) ENGINE=InnoDB;



ALTER TABLE rides
  ADD COLUMN capacity_seats        TINYINT UNSIGNED NULL AFTER duration_s,   -- vehicle seat capacity for pool
  ADD COLUMN seats_booked          TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER capacity_seats,
  ADD COLUMN is_shared             TINYINT(1) NOT NULL DEFAULT 0 AFTER trip_type; -- 1 for pool rides

-- Helpful index when matching / selling seats
CREATE INDEX idx_rides_pool_sales ON rides (is_shared, status, seats_booked, capacity_seats);


CREATE TABLE ride_stops (
  stop_id       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ride_id       BIGINT UNSIGNED NOT NULL,
  booking_id    BIGINT UNSIGNED NULL, -- which booking created this stop (nullable if system-inserted)
  type          ENUM('pickup','dropoff') NOT NULL,
  seq           INT NOT NULL,         -- order in driver’s queue
  place         VARCHAR(255) NULL,
  lat           DOUBLE NOT NULL,
  lng           DOUBLE NOT NULL,
  eta_at        DATETIME NULL,        -- planned ETA (optional)
  added_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_rs_ride (ride_id, seq),
  CONSTRAINT fk_rs_ride    FOREIGN KEY (ride_id)    REFERENCES rides(ride_id)        ON DELETE CASCADE,
  CONSTRAINT fk_rs_booking FOREIGN KEY (booking_id) REFERENCES ride_bookings(booking_id) ON DELETE SET NULL
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS ride_booking_earnings (
  booking_id           BIGINT UNSIGNED PRIMARY KEY,
  driver_id            BIGINT UNSIGNED NOT NULL,
  base_cents           INT NOT NULL DEFAULT 0,
  distance_cents       INT NOT NULL DEFAULT 0,
  time_cents           INT NOT NULL DEFAULT 0,
  surge_cents          INT NOT NULL DEFAULT 0,
  tolls_cents          INT NOT NULL DEFAULT 0,
  tips_cents           INT NOT NULL DEFAULT 0,
  other_adj_cents      INT NOT NULL DEFAULT 0,
  platform_fee_cents   INT NOT NULL DEFAULT 0,
  tax_cents            INT NOT NULL DEFAULT 0,

  driver_earnings_cents INT AS (
    (base_cents + distance_cents + time_cents + surge_cents + tolls_cents + tips_cents + other_adj_cents)
    - (platform_fee_cents + tax_cents)
  ) STORED,

  currency             CHAR(3) NOT NULL DEFAULT 'BTN',
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_be_booking FOREIGN KEY (booking_id) REFERENCES ride_bookings(booking_id) ON DELETE CASCADE
);


-- 001_add_ride_tips.sql

-- Tip events per ride (and optionally per booking for pool)
CREATE TABLE IF NOT EXISTS ride_tips (
  tip_id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ride_id           BIGINT UNSIGNED NOT NULL,
  driver_id         BIGINT UNSIGNED NOT NULL,
  passenger_id      BIGINT UNSIGNED NOT NULL,
  booking_id        BIGINT UNSIGNED NULL,  -- for pool rides; NULL for instant
  amount_cents      INT UNSIGNED NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'BTN',

  -- optional idempotency to prevent double-charges from retries
  idempotency_key   VARCHAR(64) NULL,

  status            ENUM('authorized','captured','refunded','failed') NOT NULL DEFAULT 'captured',

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (tip_id),
  KEY idx_ride (ride_id),
  KEY idx_driver (driver_id),
  KEY idx_passenger (passenger_id),
  KEY idx_booking (booking_id),
  UNIQUE KEY uniq_idem (idempotency_key),

  CONSTRAINT fk_rt_ride FOREIGN KEY (ride_id) REFERENCES rides(ride_id) ON DELETE CASCADE,
  CONSTRAINT fk_rt_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rt_booking FOREIGN KEY (booking_id) REFERENCES ride_bookings(booking_id) ON DELETE SET NULL
);


CREATE TABLE IF NOT EXISTS ride_waypoints (
  ride_id BIGINT NOT NULL,
  order_index INT NOT NULL,
  lat DOUBLE NOT NULL,
  lng DOUBLE NOT NULL,
  address VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ride_id, order_index),
  KEY idx_ride (ride_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE settlement_accounts (
  party_type ENUM('DRIVER','MERCHANT','USER','PARTNER') NOT NULL,
  party_id   BIGINT UNSIGNED NOT NULL,

  balance_cents BIGINT SIGNED NOT NULL DEFAULT 0, -- + means party owes platform
  currency CHAR(3) NOT NULL DEFAULT 'BTN',

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (party_type, party_id),
  KEY idx_balance (balance_cents)
);




CREATE TABLE settlement_ledger (
  entry_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,

  party_type ENUM('DRIVER','MERCHANT','USER','PARTNER') NOT NULL,
  party_id   BIGINT UNSIGNED NOT NULL,

  source_type ENUM('RIDE','FOOD_ORDER','MART_ORDER','PAYOUT','PAYMENT','ADJUSTMENT') NOT NULL,
  source_id   VARCHAR(64) NOT NULL,

  entry_type ENUM(
    'PLATFORM_FEE_DUE',          -- + increases debt to platform
    'TAX_DUE',
    'DELIVERY_FEE_DUE',
    'AUTO_DEDUCT',
    'WALLET_PAYMENT',
    'MANUAL_PAYMENT',
    'REFUND_CREDIT',             -- - reduces debt / becomes platform payable
    'ADJUSTMENT',
    'REVERSAL'
  ) NOT NULL,

  amount_cents BIGINT SIGNED NOT NULL, -- + owe platform, - platform owes/paid
  currency CHAR(3) NOT NULL DEFAULT 'BTN',

  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- prevents double posting per event
  UNIQUE KEY uq_post_once (party_type, party_id, source_type, source_id, entry_type),
  KEY idx_party_date (party_type, party_id, created_at),
  KEY idx_source (source_type, source_id)
);


-- Invite table (share code / expiry)
CREATE TABLE IF NOT EXISTS ride_invites (
  invite_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ride_id BIGINT UNSIGNED NOT NULL,
  invite_code VARCHAR(16) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  max_guests TINYINT UNSIGNED DEFAULT 3,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invite_code (invite_code),
  KEY idx_ride_id (ride_id)
);

-- Participants table (host + guests)
CREATE TABLE IF NOT EXISTS ride_participants (
  participant_id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  ride_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('host','guest') NOT NULL,
  seats TINYINT UNSIGNED NOT NULL DEFAULT 1,
  join_status ENUM('joined','left','removed') NOT NULL DEFAULT 'joined',
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_ride_user (ride_id, user_id),
  KEY idx_ride_id (ride_id),
  KEY idx_user_id (user_id)
);

ALTER TABLE rides
  MODIFY booking_type ENUM('INSTANT','SCHEDULED','GROUP')
  NOT NULL DEFAULT 'INSTANT';

-- Extend rides.status ENUM to include 'scheduled' (required for SCHEDULED booking_type)
ALTER TABLE rides
  MODIFY COLUMN status ENUM(
    'scheduled',
    'requested',
    'offered_to_driver',
    'accepted',
    'arrived_pickup',
    'started',
    'completed',
    'cancelled_driver',
    'cancelled_rider',
    'cancelled_system'
  ) NOT NULL;

-- Extend rides.trip_type ENUM to include 'scheduled' and 'group' (used by matching.js)
ALTER TABLE rides
  MODIFY COLUMN trip_type ENUM('instant','pool','scheduled','group') NOT NULL DEFAULT 'instant';

-- Inter-city fixed fare table
CREATE TABLE IF NOT EXISTS inter_city_fares (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_city    VARCHAR(100) NOT NULL,
  to_city      VARCHAR(100) NOT NULL,
  reserve_fare DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  share_fare   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  UNIQUE KEY uq_inter_city_route (from_city, to_city)
);

-- Intra-city fixed fare table (zone-to-zone within a city)
CREATE TABLE IF NOT EXISTS intra_city_fares (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_zone    VARCHAR(100) NOT NULL,
  to_zone      VARCHAR(100) NOT NULL,
  reserve_fare DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  share_fare   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_share     TINYINT(1)   NOT NULL DEFAULT 0,
  UNIQUE KEY uq_intra_city_route (from_zone, to_zone)
);

-- Airport / flight metadata (populated for rides booked via FlightArrival flow)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS flight_number VARCHAR(20)  NULL DEFAULT NULL AFTER payment_method,
  ADD COLUMN IF NOT EXISTS airport_code  VARCHAR(10)  NULL DEFAULT NULL AFTER flight_number,
  ADD COLUMN IF NOT EXISTS airport_name  VARCHAR(100) NULL DEFAULT NULL AFTER airport_code;
