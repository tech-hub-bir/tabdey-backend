// src/routes/debugRoutes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();

router.get("/debug/jwt", (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(400).json({ ok: false, error: "No token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ ok: true, payload });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "JWT verify failed", detail: e.message });
  }
});

module.exports = router;
