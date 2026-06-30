// controllers/adminLogController.js
const AdminLog = require("../models/adminlogModel");

exports.getAdminLogs = async (req, res) => {
  try {
    const logs = await AdminLog.getAll();
    return res.json({ data: logs });
  } catch (err) {
    console.error("getAdminLogs error:", err);
    return res.status(500).json({ error: "Failed to fetch admin logs" });
  }
};
