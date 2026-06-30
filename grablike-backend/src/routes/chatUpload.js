// src/routes/chatUpload.js
import path from "node:path";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import mime from "mime-types";

export function makeChatUploadRouter(publicBase = "grablike/uploads") {
  const router = express.Router();

  const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
  const UP_DIR = path.join(UPLOAD_ROOT, "chat");
  fs.mkdirSync(UP_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype) || "bin";
      const name = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      cb(null, name);
    },
  });

  const ALLOWED_PREFIXES = ["image/", "audio/"];

  const fileFilter = (_req, file, cb) => {
    const ok = ALLOWED_PREFIXES.some((p) => file.mimetype?.startsWith(p));
    if (!ok) return cb(new Error("Only image and audio files are allowed"));
    cb(null, true);
  };

  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — covers full-res phone photos and voice notes
  });

  // POST /chat/upload  (form field: "file")
  router.post("/upload", upload.single("file"), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });
      const rel = path.posix.join("chat", req.file.filename);
      const url = `${publicBase.replace(/\/+$/, "")}/${rel}`; // e.g. /uploads/chat/xxx.jpg
      return res.json({ ok: true, url });
    } catch (e) {
      console.error("[chat upload] error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // Multer/file-filter errors land here instead of falling through to the
  // default Express HTML error page (which breaks the client's res.json()).
  router.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : err.code.toLowerCase();
      console.error("[chat upload] multer error:", err.code);
      return res.status(400).json({ ok: false, error: msg });
    }
    console.error("[chat upload] error:", err?.message);
    return res.status(400).json({ ok: false, error: "upload_failed" });
  });

  return router;
}
