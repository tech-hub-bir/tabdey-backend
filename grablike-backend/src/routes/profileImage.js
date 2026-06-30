// src/routes/profileImage.js
import path from "node:path";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import mime from "mime-types";
import { withConn } from "../db/mysql.js";

const BASE_URL = (process.env.BASE_URL || "https://backend.tabdhey.bt").replace(/\/+$/, "");
const UPLOADS_BASE = `${BASE_URL}/grablike/uploads`;

export default function makeProfileImageRouter() {
  const router = express.Router();

  const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
  const UP_DIR = path.join(UPLOAD_ROOT, "profiles");
  fs.mkdirSync(UP_DIR, { recursive: true });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UP_DIR),
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype) || "jpg";
      const name = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      cb(null, name);
    },
  });

  const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype?.startsWith("image/")) {
        return cb(new Error("Only image files are allowed"));
      }
      cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  });

  /**
   * POST /api/users/:user_id/profile-image
   * Form field: "image"
   * Uploads the file, updates users.profile_image, returns the new URL.
   */
  router.post(
    "/users/:user_id/profile-image",
    upload.single("image"),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ ok: false, error: "no_file" });
        }

        const userId = Number(req.params.user_id);
        if (!Number.isFinite(userId)) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ ok: false, error: "invalid_user_id" });
        }

        const imageUrl = `${UPLOADS_BASE}/profiles/${req.file.filename}`;

        await withConn(async (conn) => {
          const [result] = await conn.execute(
            "UPDATE users SET profile_image = ? WHERE user_id = ?",
            [imageUrl, userId]
          );

          if (result.affectedRows === 0) {
            fs.unlink(req.file.path, () => {});
            return res.status(404).json({ ok: false, error: "user_not_found" });
          }

          return res.json({ ok: true, profile_image: imageUrl });
        });
      } catch (e) {
        console.error("[profileImage] error:", e?.message);
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(500).json({ ok: false, error: "server_error" });
      }
    }
  );

  /**
   * DELETE /api/users/:user_id/profile-image
   * Clears the profile_image field in the DB (does not delete the file).
   */
  router.delete("/users/:user_id/profile-image", async (req, res) => {
    try {
      const userId = Number(req.params.user_id);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ ok: false, error: "invalid_user_id" });
      }

      await withConn(async (conn) => {
        const [result] = await conn.execute(
          "UPDATE users SET profile_image = NULL WHERE user_id = ?",
          [userId]
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ ok: false, error: "user_not_found" });
        }

        return res.json({ ok: true });
      });
    } catch (e) {
      console.error("[profileImage] delete error:", e?.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  return router;
}
