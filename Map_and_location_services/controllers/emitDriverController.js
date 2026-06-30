const Driver = require("../models/driverModel");

// Format driver data safely for emitting to frontend
const formatDriverData = (driver) => {
  // console.log(driver.device_id);
  const coords =
    Array.isArray(driver.current_location?.coordinates) &&
    driver.current_location.coordinates.length === 2
      ? driver.current_location.coordinates
      : [null, null];

  return {
    _id: driver._id,
    user_id: driver.user_id ?? null,
    license_number: driver.license_number ?? "",
    license_expiry: driver.license_expiry ?? null,
    is_approved: driver.is_approved ?? false,
    approval_status: driver.approval_status ?? "",
    rating: driver.rating ?? 0,
    total_rides: driver.total_rides ?? 0,
    is_online: driver.is_online ?? false,
    location: {
      latitude: coords[1],
      longitude: coords[0],
    },

    device_id: driver.device_id,
    current_location_updated_at: driver.current_location_updated_at ?? null,
    created_at: driver.created_at ?? null,
    updated_at: driver.updated_at ?? null,
  };
};

const emitAllDrivers = async (socket) => {
  try {
    // Select all except password and __v
    const allDriversRaw = await Driver.find({}, { password: 0, __v: 0 });

    // Format each driver for clean data output
    const allDrivers = allDriversRaw.map(formatDriverData);
    // console.log(allDrivers);

    return allDrivers;
    // socket.broadcast.emit("allDriversData", allDrivers);
    // console.log("📤 Emitted all driver data.", allDrivers);
  } catch (err) {
    console.error("❌ Error fetching driver data:", err.message);
    socket.emit("allDriversError", {
      message: "Failed to fetch driver data",
    });
  }
};

module.exports = { emitAllDrivers };
