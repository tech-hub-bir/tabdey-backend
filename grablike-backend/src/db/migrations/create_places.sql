-- Run once against your MySQL database:
--   mysql -u root -p your_db < src/db/migrations/create_places.sql

CREATE TABLE IF NOT EXISTS places (
  id        BIGINT        AUTO_INCREMENT PRIMARY KEY,
  osm_id    BIGINT,
  name      VARCHAR(500)  NOT NULL,
  name_en   VARCHAR(500),
  amenity   VARCHAR(100),
  tourism   VARCHAR(100),
  shop      VARCHAR(100),
  place     VARCHAR(100),
  lat       DOUBLE        NOT NULL,
  lon       DOUBLE        NOT NULL,
  location  POINT         NOT NULL,
  tags      LONGTEXT,
  FULLTEXT  INDEX ft_name    (name),
  SPATIAL   INDEX sp_location (location)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
