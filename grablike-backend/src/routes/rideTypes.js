import path from "node:path";
import fs from "node:fs";
import express from "express";
import multer from "multer";
import mime from "mime-types";
import { withConn } from "../db/mysql.js";

export const ridesTypesRouter = express.Router();

const BASE_URL = (process.env.BASE_URL || "https://backend.tabdhey.bt").replace(/\/+$/, "");
const UPLOADS_BASE = `${BASE_URL}/grablike/uploads`;

/* ===================== Multer — ride type icons ===================== */
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
const ICON_DIR = path.join(UPLOAD_ROOT, "ride-type-icons");
fs.mkdirSync(ICON_DIR, { recursive: true });

const iconStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ICON_DIR),
  filename: (_req, file, cb) => {
    const ext = mime.extension(file.mimetype) || "png";
    cb(null, `ride-icon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  },
});

const uploadIcon = multer({
  storage: iconStorage,
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

/* ===================== money helpers ===================== */
// Admin enters Nu (e.g. 10 or "10.00") -> store cents (1000)
function toCents(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// DB cents -> Nu (e.g. 1000 -> 10)
function toNu(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Number((n / 100).toFixed(2));
}

function toTinyIntBool(v, fallback = 1) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return 1;
  if (["0", "false", "no", "n"].includes(s)) return 0;
  return fallback;
}

/**
 * DB row -> API row
 * - keeps *_cents
 * - adds Nu fields: base_fare, per_km_rate, per_min_rate, min_fare, cancellation_fee
 */
function mapRideTypeRow(row) {
  if (!row) return row;

  return {
    ...row,

    // ✅ add Nu fields
    base_fare: toNu(row.base_fare_cents),
    per_km_rate: toNu(row.per_km_rate_cents),
    min_fare: toNu(row.min_fare_cents),
    cancellation_fee: toNu(row.cancellation_fee_cents),

    // ✅ ensure cents are numbers
    base_fare_cents: Number(row.base_fare_cents || 0),
    per_km_rate_cents: Number(row.per_km_rate_cents || 0),
    min_fare_cents: Number(row.min_fare_cents || 0),
    cancellation_fee_cents: Number(row.cancellation_fee_cents || 0),
  };
}

/* ===================== Add ride type ===================== */
ridesTypesRouter.post("/add-ride-types", uploadIcon.single("icon"), async (req, res) => {
  const {
    name,
    code,
    description,
    base_fare,
    per_km_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type,
    is_active = true,
  } = req.body;

  // icon_url: uploaded file takes priority, fallback to text field
  const icon_url = req.file
    ? `${UPLOADS_BASE}/ride-type-icons/${req.file.filename}`
    : (req.body.icon_url || null);

  if (!name || !code) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      success: false,
      message: "name and code are required",
    });
  }

  const base_fare_cents = toCents(base_fare) ?? 0;
  const per_km_rate_cents = toCents(per_km_rate) ?? 0;
  const min_fare_cents = toCents(min_fare) ?? 0;
  const cancellation_fee_cents = toCents(cancellation_fee) ?? 0;
  const is_active_int = toTinyIntBool(is_active, 1);

  try {
    await withConn(async (db) => {
      const [result] = await db.query(
        `
        INSERT INTO ride_types
          (name, code, description,
           base_fare_cents, per_km_rate_cents,
           min_fare_cents, cancellation_fee_cents,
           capacity, vehicle_type, icon_url, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          name,
          code,
          description || null,
          base_fare_cents,
          per_km_rate_cents,
          min_fare_cents,
          cancellation_fee_cents,
          capacity ?? null,
          vehicle_type || null,
          icon_url,
          is_active_int,
        ]
      );

      res.status(201).json({
        success: true,
        message: "Ride type added successfully",
        id: result.insertId,
        icon_url,
      });
    });
  } catch (err) {
    console.error("Error adding ride type:", err);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===================== Get all ride types ===================== */
ridesTypesRouter.get("/get-ride-types", async (req, res) => {
  try {
    await withConn(async (db) => {
      const [rows] = await db.query(
        `
        SELECT
          id, name, code, description,
          base_fare_cents, per_km_rate_cents,
          min_fare_cents, cancellation_fee_cents,
          capacity, vehicle_type, icon_url, is_active, created_at, updated_at
        FROM ride_types
        ORDER BY id DESC
        `
      );

      res.status(200).json({
        success: true,
        data: (rows || []).map(mapRideTypeRow),
      });
    });
  } catch (err) {
    console.error("Error fetching ride types:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===================== Get ride type by user_id ===================== */
ridesTypesRouter.get("/get-ride-type/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    await withConn(async (db) => {
      // 1) driver_id from user_id
      const [driverResult] = await db.query(
        "SELECT driver_id FROM drivers WHERE user_id = ?",
        [user_id]
      );

      if (driverResult.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Driver not found" });
      }

      const driver_id = driverResult[0].driver_id;

      // 2) driver vehicle info
      const [vehicleRows] = await db.query(
        "SELECT vehicle_type, code FROM driver_vehicles WHERE driver_id = ?",
        [driver_id]
      );

      if (vehicleRows.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Ride type not found" });
      }

      res.status(200).json({
        success: true,
        data: vehicleRows[0],
      });
    });
  } catch (err) {
    console.error("Error fetching ride type:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===================== EDIT/UPDATE ride type by ID ===================== */
ridesTypesRouter.put("/edit-ride-type/:id", uploadIcon.single("icon"), async (req, res) => {
  const { id } = req.params;

  const {
    name,
    code,
    description,
    base_fare,
    per_km_rate,
    min_fare,
    cancellation_fee,
    capacity,
    vehicle_type,
    is_active,
  } = req.body;

  // uploaded file takes priority over text icon_url field
  const icon_url = req.file
    ? `${UPLOADS_BASE}/ride-type-icons/${req.file.filename}`
    : req.body.icon_url;

  try {
    await withConn(async (db) => {
      const [existingRide] = await db.query(
        "SELECT id FROM ride_types WHERE id = ?",
        [id]
      );

      if (existingRide.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found",
        });
      }

      const updateFields = [];
      const updateValues = [];

      if (name !== undefined) {
        updateFields.push("name = ?");
        updateValues.push(name);
      }
      if (code !== undefined) {
        updateFields.push("code = ?");
        updateValues.push(code);
      }
      if (description !== undefined) {
        updateFields.push("description = ?");
        updateValues.push(description);
      }

      // ✅ Convert Nu -> cents before update
      if (base_fare !== undefined) {
        updateFields.push("base_fare_cents = ?");
        updateValues.push(toCents(base_fare) ?? 0);
      }
      if (per_km_rate !== undefined) {
        updateFields.push("per_km_rate_cents = ?");
        updateValues.push(toCents(per_km_rate) ?? 0);
      }
      if (min_fare !== undefined) {
        updateFields.push("min_fare_cents = ?");
        updateValues.push(toCents(min_fare) ?? 0);
      }
      if (cancellation_fee !== undefined) {
        updateFields.push("cancellation_fee_cents = ?");
        updateValues.push(toCents(cancellation_fee) ?? 0);
      }

      if (capacity !== undefined) {
        updateFields.push("capacity = ?");
        updateValues.push(capacity);
      }
      if (vehicle_type !== undefined) {
        updateFields.push("vehicle_type = ?");
        updateValues.push(vehicle_type);
      }
      if (icon_url !== undefined) {
        updateFields.push("icon_url = ?");
        updateValues.push(icon_url);
      }
      if (is_active !== undefined) {
        updateFields.push("is_active = ?");
        updateValues.push(toTinyIntBool(is_active, 1));
      }

      updateFields.push("updated_at = CURRENT_TIMESTAMP");

      if (updateFields.length === 1) {
        return res.status(400).json({
          success: false,
          message: "No fields to update",
        });
      }

      updateValues.push(id);

      const query = `UPDATE ride_types SET ${updateFields.join(
        ", "
      )} WHERE id = ?`;
      const [result] = await db.query(query, updateValues);

      res.status(200).json({
        success: true,
        message: "Ride type updated successfully",
        affectedRows: result.affectedRows,
      });
    });
  } catch (err) {
    console.error("Error updating ride type:", err);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
});

/* ===================== HARD DELETE ride type by ID ===================== */
ridesTypesRouter.delete("/hard-delete-ride-type/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await withConn(async (db) => {
      const [existingRide] = await db.query(
        "SELECT id, name, code FROM ride_types WHERE id = ?",
        [id]
      );

      if (existingRide.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Ride type not found",
        });
      }

      const [driversUsingRideType] = await db.query(
        `
        SELECT COUNT(*) as driver_count
        FROM driver_vehicles dv
        WHERE dv.vehicle_type COLLATE utf8mb4_unicode_ci = ?
        `,
        [existingRide[0].code]
      );

      if (driversUsingRideType[0].driver_count > 0) {
        return res.status(400).json({
          success: false,
          message:
            "Cannot delete ride type. It is currently being used by drivers.",
          driverCount: driversUsingRideType[0].driver_count,
        });
      }

      const [result] = await db.query("DELETE FROM ride_types WHERE id = ?", [
        id,
      ]);

      res.status(200).json({
        success: true,
        message: "Ride type permanently deleted",
        deletedRideType: existingRide[0].name,
      });
    });
  } catch (err) {
    console.error("Error hard deleting ride type:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
});

/* ===================== Get ride type by ID ===================== */
ridesTypesRouter.get("/get-ride-type-by-id/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await withConn(async (db) => {
      const [rows] = await db.query(
        `
        SELECT
          id, name, code, description,
          base_fare_cents, per_km_rate_cents,
          min_fare_cents, cancellation_fee_cents,
          capacity, vehicle_type, icon_url, is_active, created_at, updated_at
        FROM ride_types
        WHERE id = ?
        `,
        [id]
      );

      if (rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Ride type not found" });
      }

      res.status(200).json({
        success: true,
        data: mapRideTypeRow(rows[0]),
      });
    });
  } catch (err) {
    console.error("Error fetching ride type by ID:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===================== Upload icon for a ride type ===================== */
ridesTypesRouter.post(
  "/ride-type-icon/:id",
  uploadIcon.single("icon"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
      }

      const { id } = req.params;
      const iconUrl = `${UPLOADS_BASE}/ride-type-icons/${req.file.filename}`;

      await withConn(async (db) => {
        const [existing] = await db.query(
          "SELECT id FROM ride_types WHERE id = ?",
          [id]
        );

        if (existing.length === 0) {
          fs.unlink(req.file.path, () => {});
          return res.status(404).json({ success: false, message: "Ride type not found" });
        }

        await db.query(
          "UPDATE ride_types SET icon_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [iconUrl, id]
        );

        return res.status(200).json({ success: true, icon_url: iconUrl });
      });
    } catch (err) {
      console.error("Error uploading ride type icon:", err);
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);
