// controllers/driverSocketController.js
const moment = require("moment-timezone");
const Driver = require("../models/driverModel"); // Mongo model
const { emitAllDrivers } = require("./emitDriverController");
const {
  setDriverOnlineStatusByUserId,
} = require("../models/driveronlineModel");

// Bhutan time helpers (moment-timezone)
const bhutanNowMoment = () => moment.tz("Asia/Thimphu");
const bhutanNowDate = () => bhutanNowMoment().toDate();
const formatToBhutanTime = (dateOrMoment) =>
  moment(dateOrMoment).tz("Asia/Thimphu").format("DD/MM/YYYY HH:mm:ss");

// ✅ Update driver's location & online status
const handleDriverLocationUpdate = async (socket, data) => {
  const { user_id, latitude, longitude } = data || {};

  try {
    const bhutanMoment = bhutanNowMoment();

    // 1) Update Mongo (location + online)
    const updatedDriver = await Driver.findOneAndUpdate(
      { user_id },
      {
        $set: {
          latitude,
          longitude,
          is_online: true,
          updatedAt: formatToBhutanTime(bhutanMoment),
          current_location_updated_at: bhutanMoment.toDate(),
        },
      },
      { new: true }
    );

    if (!updatedDriver) {
      return socket.emit("locationUpdateError", {
        message: "Driver not found",
      });
    }

    // 2) Sync MySQL drivers.is_online = 1
    try {
      const affected = await setDriverOnlineStatusByUserId(user_id, 1);
      if (affected === 0) {
        console.warn(
          `MySQL drivers row not found for user_id=${user_id}, is_online not updated`
        );
      }
    } catch (sqlErr) {
      console.error("MySQL is_online update error:", sqlErr.message);
    }

    const prettyTime = formatToBhutanTime(bhutanMoment);

    console.log(
      `✅ Location & status updated for user_id: ${user_id} at Bhutan time ${prettyTime}`
    );

    socket.emit("locationUpdateSuccess", {
      message: "Location and active status updated successfully!",
      bhutan_time: prettyTime,
    });

    const allDrivers = await emitAllDrivers(socket);
    socket.broadcast.emit("allDriversData", allDrivers);
  } catch (err) {
    console.error("❌ Error updating driver info:", err.message);
    socket.emit("locationUpdateError", {
      message: "Failed to update driver location",
    });
  }
};

// ✅ Update driver's is_online to false on disconnect
const handleDriverDisconnect = async (socket, user_id) => {
  try {
    const bhutanMoment = bhutanNowMoment();

    // 1) Update Mongo
    const updated = await Driver.findOneAndUpdate(
      { user_id },
      {
        $set: {
          is_online: false,
          updatedAt: formatToBhutanTime(bhutanMoment),
        },
      },
      { new: true }
    );

    // 2) Sync MySQL drivers.is_online = 0
    try {
      const affected = await setDriverOnlineStatusByUserId(user_id, 0);
      if (affected === 0) {
        console.warn(
          `MySQL drivers row not found for user_id=${user_id}, is_online not updated`
        );
      }
    } catch (sqlErr) {
      console.error("MySQL is_online update error:", sqlErr.message);
    }

    if (updated) {
      console.log(
        `🔴 Driver (user_id: ${user_id}) set to offline at ${formatToBhutanTime(
          bhutanMoment
        )}`
      );

      // Broadcast the updated driver list to everyone
      const allDrivers = await emitAllDrivers(socket);
      socket.broadcast.emit("allDriversData", allDrivers);
    }
  } catch (err) {
    console.error("❌ Error setting driver offline:", err.message);
  }
};

module.exports = {
  handleDriverLocationUpdate,
  handleDriverDisconnect,
  formatToBhutanTime, // still exported if used elsewhere
};
