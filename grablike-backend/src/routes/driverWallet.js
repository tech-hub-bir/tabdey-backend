import express from "express";
import { withConn } from "../db/mysql.js";
import { DriverOnlineSession } from "../models/DriverOnlineSession.js";

const SORT_MAP = {
  total: "total_earn_cents",
  trips: "trip_count",
  trip_earn: "trip_earn_cents",
  adj_earn: "adj_earn_cents",
  name: "d.full_name",
  last_trip: "last_trip_at",
};

export function walletRouter(mysqlPool) {
  const router = express.Router();

  // get driver's earning by driver_id and insert the amount in the wallet
  return router;
}
