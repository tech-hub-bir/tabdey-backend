const express = require("express");
const router = express.Router();
const { updateDeviceID } = require("../controllers/updateDeviceController");

router.put("/device/update", updateDeviceID);

module.exports = router;
