-- Migration: add per-participant stage tracking for Taxi Sharing rides
-- Run once against the production database.

ALTER TABLE ride_participants
  ADD COLUMN IF NOT EXISTS stage
    ENUM('waiting', 'arrived', 'onboard', 'dropped')
    NOT NULL
    DEFAULT 'waiting'
    AFTER join_status;
