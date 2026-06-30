// src/routes/agora.js
import express from "express";
import pkg from "agora-token";
const { RtcTokenBuilder, RtcRole } = pkg;

const router = express.Router();

router.post("/token", (req, res) => {
  const { channelName, uid } = req.body;
  if (!channelName || uid == null) {
    return res.status(400).json({ ok: false, error: "channelName and uid required" });
  }

  const appId = process.env.AGORA_APP_ID;
  const appCert = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCert) {
    return res.status(500).json({ ok: false, error: "Agora not configured on server" });
  }

  const expireSecs = 3600;
  const now = Math.floor(Date.now() / 1000);

  const token = RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCert,
    channelName,
    Number(uid),
    RtcRole.PUBLISHER,
    expireSecs,
    now + expireSecs,
  );

  return res.json({ ok: true, token, appId });
});

export default router;
