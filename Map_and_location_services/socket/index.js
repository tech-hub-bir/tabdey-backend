const {
  handleDriverLocationUpdate,
  handleDriverDisconnect,
} = require("../controllers/locationController");
const { emitAllDrivers } = require("../controllers/emitDriverController");

const socketHandler = (io) => {
  const driverSockets = new Map(); // Map socket.id to user_id

  io.on("connection", (socket) => {
    console.log(`🟢 New socket connection: ${socket.id}`);

    // Location update
    socket.on("driverLocationUpdate", (data) => {
      handleDriverLocationUpdate(socket, data);
      if (data.user_id) {
        driverSockets.set(socket.id, data.user_id); // store mapping
      }
    });

    // Get all drivers
    socket.on("getAllDrivers", () => emitAllDrivers(socket));

    socket.on("disconnect", async () => {
      console.log(`🔴 Disconnected: ${socket.id}`);

      const user_id = driverSockets.get(socket.id);
      if (user_id) {
        await handleDriverDisconnect(socket, user_id);
        driverSockets.delete(socket.id);
      }
    });
  });
};

module.exports = socketHandler;
