import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    driver_id: { type: Number, index: true, required: true },
    started_at: { type: Date, required: true, index: true },
    ended_at: { type: Date, default: null, index: true },
    source: { type: String, default: "foreground", enum: ["foreground", "background", "socket"] }
  },
  { timestamps: true }
);

schema.index({ driver_id: 1, started_at: 1 });

export const DriverOnlineSession = mongoose.model("DriverOnlineSession", schema);
