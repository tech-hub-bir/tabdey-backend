-- Migration: add airport/flight metadata columns to rides
-- These are populated only for rides booked via the FlightArrival flow.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS flight_number VARCHAR(20)  NULL DEFAULT NULL AFTER payment_method,
  ADD COLUMN IF NOT EXISTS airport_code  VARCHAR(10)  NULL DEFAULT NULL AFTER flight_number,
  ADD COLUMN IF NOT EXISTS airport_name  VARCHAR(100) NULL DEFAULT NULL AFTER airport_code;
