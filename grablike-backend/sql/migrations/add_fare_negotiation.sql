-- Fare negotiation: passenger offered price + final negotiated price on the rides table
ALTER TABLE rides
  ADD COLUMN offered_fare_cents INT UNSIGNED NULL AFTER fare_cents,
  ADD COLUMN final_fare_cents   INT UNSIGNED NULL AFTER offered_fare_cents;

-- Per-driver counter-offers for a ride (one row per driver per ride)
CREATE TABLE IF NOT EXISTS ride_fare_counters (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ride_id       BIGINT UNSIGNED NOT NULL,
  driver_id     BIGINT UNSIGNED NOT NULL,
  counter_cents INT UNSIGNED    NOT NULL,
  status        ENUM('pending','accepted','rejected','withdrawn','expired')
                  NOT NULL DEFAULT 'pending',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rfc_ride   (ride_id),
  INDEX idx_rfc_driver (driver_id, ride_id)
) ENGINE=InnoDB;
