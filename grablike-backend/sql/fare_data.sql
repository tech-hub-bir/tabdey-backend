-- ============================================================
-- Dummy fare data for inter_city_fares & intra_city_fares
-- Run AFTER schema.sql
-- ============================================================

-- ------------------------------------------------------------
-- Inter-City Fares (city to city)
-- ------------------------------------------------------------
INSERT INTO inter_city_fares (from_city, to_city, reserve_fare, share_fare) VALUES
  ('Thimphu',  'Paro',       300.00, 150.00),
  ('Paro',     'Thimphu',    300.00, 150.00),

  ('Thimphu',  'Punakha',    500.00, 250.00),
  ('Punakha',  'Thimphu',    500.00, 250.00),

  ('Thimphu',  'Wangdue',    550.00, 280.00),
  ('Wangdue',  'Thimphu',    550.00, 280.00),

  ('Thimphu',  'Haa',        600.00, 300.00),
  ('Haa',      'Thimphu',    600.00, 300.00),

  ('Thimphu',  'Bumthang',  1200.00, 600.00),
  ('Bumthang', 'Thimphu',   1200.00, 600.00),

  ('Paro',     'Punakha',    650.00, 330.00),
  ('Punakha',  'Paro',       650.00, 330.00),

  ('Thimphu',  'Trongsa',    900.00, 450.00),
  ('Trongsa',  'Thimphu',    900.00, 450.00),

  ('Thimphu',  'Gelephu',   1500.00, 750.00),
  ('Gelephu',  'Thimphu',   1500.00, 750.00),

  ('Thimphu',  'Phuentsholing', 800.00, 400.00),
  ('Phuentsholing', 'Thimphu', 800.00, 400.00)
ON DUPLICATE KEY UPDATE
  reserve_fare = VALUES(reserve_fare),
  share_fare   = VALUES(share_fare);


-- ------------------------------------------------------------
-- Intra-City Fares (zone to zone within Thimphu)
-- is_share = 1 means shared ride is allowed on that route
-- ------------------------------------------------------------
INSERT INTO intra_city_fares (from_zone, to_zone, reserve_fare, share_fare, is_share) VALUES
  ('Changlimithang', 'Babesa',          80.00,  40.00, 1),
  ('Babesa',         'Changlimithang',  80.00,  40.00, 1),

  ('Changlimithang', 'Simtokha',        70.00,  35.00, 1),
  ('Simtokha',       'Changlimithang',  70.00,  35.00, 1),

  ('Changlimithang', 'Chubachu',        60.00,   0.00, 0),
  ('Chubachu',       'Changlimithang',  60.00,   0.00, 0),

  ('Babesa',         'Simtokha',        50.00,  25.00, 1),
  ('Simtokha',       'Babesa',          50.00,  25.00, 1),

  ('Babesa',         'Taba',            90.00,  45.00, 1),
  ('Taba',           'Babesa',          90.00,  45.00, 1),

  ('Simtokha',       'Lungtenphu',      55.00,  28.00, 1),
  ('Lungtenphu',     'Simtokha',        55.00,  28.00, 1),

  ('Norzin Lam',     'Babesa',          85.00,  42.00, 1),
  ('Babesa',         'Norzin Lam',      85.00,  42.00, 1),

  ('Norzin Lam',     'Simtokha',        75.00,  38.00, 1),
  ('Simtokha',       'Norzin Lam',      75.00,  38.00, 1),

  ('Norzin Lam',     'Chubachu',        50.00,   0.00, 0),
  ('Chubachu',       'Norzin Lam',      50.00,   0.00, 0),

  ('Taba',           'Simtokha',       100.00,  50.00, 1),
  ('Simtokha',       'Taba',           100.00,  50.00, 1),

  ('Lungtenphu',     'Changlimithang',  65.00,  32.00, 1),
  ('Changlimithang', 'Lungtenphu',      65.00,  32.00, 1)
ON DUPLICATE KEY UPDATE
  reserve_fare = VALUES(reserve_fare),
  share_fare   = VALUES(share_fare),
  is_share     = VALUES(is_share);
