const redis = require("../models/redisClient");

const checkEmailVerified = async (req, res, next) => {
  const email = req.body?.user?.email;
  if (!email)
    return res.status(400).json({ error: "Email is missing in user data" });

  const isVerified = await redis.get(`verified:${email}`);
  if (isVerified !== "true") {
    return res
      .status(403)
      .json({ error: "Email not verified. Please verify OTP." });
  }

  next();
};

module.exports = checkEmailVerified;
