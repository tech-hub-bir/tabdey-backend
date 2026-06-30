-- Table to store passenger → driver ratings on completed rides
CREATE TABLE IF NOT EXISTS ride_ratings (
  rating_id      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

  ride_id        BIGINT UNSIGNED NOT NULL,
  driver_id      BIGINT UNSIGNED NOT NULL,
  passenger_id   BIGINT UNSIGNED NULL,

  rating         TINYINT UNSIGNED NOT NULL, -- 1..5
  comment        VARCHAR(500) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_rr_ride   FOREIGN KEY (ride_id)   REFERENCES rides(ride_id)   ON DELETE CASCADE,
  CONSTRAINT fk_rr_driver FOREIGN KEY (driver_id) REFERENCES drivers(driver_id),

  -- one rating per ride from the passenger perspective
  UNIQUE KEY uq_rr_ride (ride_id),

  -- helpful indexes
  KEY idx_rr_driver_created (driver_id, created_at),
  KEY idx_rr_driver_rating  (driver_id, rating)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- (Optional) seed a couple of rows for testing.
-- Make sure ride_id values exist in rides and belong to the driver you’ll test with.
-- Example (update IDs to match your DB):
INSERT INTO ride_ratings (ride_id, driver_id, passenger_id, rating, comment)
VALUES
  (41, 7, 201, 5, 'Excellent ride, very comfortable.'),
  (42, 7, 202, 4, 'Smooth driving, but arrived a bit late.'),
  (46, 7, 203, 5, 'Driver was very friendly and professional.');
 

