// models/driverModel.js
const mongoose = require("mongoose");

const driverSchema = new mongoose.Schema(
  {
    user_id: {
      type: Number, // Link to MySQL user_id
      required: true,
      unique: true,
    },
    license_number: {
      type: String,
      required: true,
      unique: true,
    },
    license_expiry: {
      type: Date,
      required: true,
    },
    is_approved: {
      type: Boolean,
      default: false,
    },
    approval_status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    approved_at: Date,
    rejection_reason: String,
    rating: {
      type: Number,
      default: 0.0,
      min: 0,
      max: 5,
    },
    total_rides: {
      type: Number,
      default: 0,
    },
    is_online: {
      type: Boolean,
      default: false,
    },
    current_location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0],
      },
    },
    device_id: {
      type: String,
      default: null,
    },
    current_location_updated_at: Date,
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

// Create geospatial index for location queries
driverSchema.index({ current_location: "2dsphere" });

module.exports = mongoose.model("Driver", driverSchema);
