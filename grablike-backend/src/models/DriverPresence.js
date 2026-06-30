import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    driver_id: { type: Number, index: true, required: true },
    last_ping: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

// TTL index: auto-remove after 10 minutes
schema.index({ last_ping: 1 }, { expireAfterSeconds: 600 });

export const DriverPresence = mongoose.model("DriverPresence", schema);
