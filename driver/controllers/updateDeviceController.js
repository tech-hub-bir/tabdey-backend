const { prisma } = require("../lib/prisma.js");

const updateDeviceID = async (req, res) => {
  const { user_id, role, deviceID } = req.body;

  if (!user_id || !role || !deviceID) {
    return res
      .status(400)
      .json({ error: "user_id, role, and deviceID are required" });
  }

  try {
    // 🔎 Step 1: Check if user exists
    const userRows = await prisma.users.findMany({
      where: { user_id: parseInt(user_id) },
      select: { user_id: true, role: true },
    });

    if (userRows.length === 0) {
      return res
        .status(404)
        .json({ error: "User ID not found in the database" });
    }

    // ✅ Optional: Check if role matches with what's stored
    const storedRole = userRows[0].role;
    if (storedRole !== role) {
      return res.status(400).json({
        error: `Role mismatch. Provided role is '${role}' but found '${storedRole}' in DB`,
      });
    }

    // 🔧 Step 2: Determine the correct table
    let table = "";
    if (role === "driver") {
      table = "driver_devices";
    } else if (role === "user") {
      table = "user_devices";
    } else {
      return res.status(400).json({ error: "Invalid role provided" });
    }

    // 🔄 Step 3: Update or Insert device ID
    let existingRows = [];

    if (table === "driver_devices") {
      existingRows = await prisma.driver_devices.findMany({
        where: { user_id: parseInt(user_id) },
        select: { id: true },
      });
    } else if (table === "user_devices") {
      existingRows = await prisma.user_devices.findMany({
        where: { user_id: parseInt(user_id) },
        select: { id: true },
      });
    }

    if (existingRows.length > 0) {
      if (table === "driver_devices") {
        await prisma.driver_devices.update({
          where: { user_id: parseInt(user_id) },
          data: {
            device_id: deviceID,
            updated_at: new Date(),
          },
        });
      } else if (table === "user_devices") {
        await prisma.user_devices.update({
          where: { user_id: parseInt(user_id) },
          data: {
            device_id: deviceID,
            updated_at: new Date(),
          },
        });
      }
    } else {
      if (table === "driver_devices") {
        await prisma.driver_devices.create({
          data: {
            user_id: parseInt(user_id),
            device_id: deviceID,
            updated_at: new Date(),
          },
        });
      } else if (table === "user_devices") {
        await prisma.user_devices.create({
          data: {
            user_id: parseInt(user_id),
            device_id: deviceID,
            updated_at: new Date(),
          },
        });
      }
    }

    return res
      .status(200)
      .json({ message: "✅ Device ID updated successfully" });
  } catch (err) {
    console.error("❌ Error updating device ID:", err);
    return res.status(500).json({ error: "Failed to update device ID" });
  }
};

module.exports = { updateDeviceID };
