// middlewares/upload.js
const multer = require("multer");
const path = require("path");

const {
  ensureDirSync,
  isLikelyImage,
  wrapMulterWithCompression,
} = require("./imageCompression");

// ✅ Define upload root (K8s: /uploads | local: ./uploads)
const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

// 🧩 Map field names → subfolders
const SUBFOLDERS = {
  license_image: "licenses",
  business_logo: "logos",
  bank_qr_code_image: "bank_qr",
  default: "misc",
};

// 🧰 Create all known upload subfolders at startup
Object.values(SUBFOLDERS).forEach((sub) => {
  ensureDirSync(path.join(UPLOAD_ROOT, sub));
});

// ⚙️ Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = SUBFOLDERS[file.fieldname] || SUBFOLDERS.default;
    const dest = path.join(UPLOAD_ROOT, sub);
    ensureDirSync(dest);
    cb(null, dest);
  },

  filename: (req, file, cb) => {
    const base = (path.basename(file.originalname || "file", path.extname(file.originalname || "")) || "file")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60);

    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Save compressed output as webp
    cb(null, `${unique}-${base || "file"}.webp`);
  },
});

// 🧤 File filter
const fileFilter = (_req, file, cb) => {
  console.log("[MERCHANT IMAGE RECEIVED]", {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
  });

  if (isLikelyImage(file)) return cb(null, true);

  return cb(
    new Error(
      `Only image files are allowed. Received mimetype=${file.mimetype}, file=${file.originalname}`,
    ),
  );
};

// 🚀 Initialize raw Multer instance
const rawUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 3,
  },
});

// ✅ Wrapper keeps existing route usage unchanged:
// upload.single(...)
// upload.fields(...)
// upload.any(...)
const upload = {
  single(fieldName) {
    return wrapMulterWithCompression(rawUpload.single(fieldName), {
      targetKB: 100,
    });
  },

  array(fieldName, maxCount) {
    return wrapMulterWithCompression(rawUpload.array(fieldName, maxCount), {
      targetKB: 100,
    });
  },

  fields(fields) {
    return wrapMulterWithCompression(rawUpload.fields(fields), {
      targetKB: 100,
    });
  },

  any() {
    return wrapMulterWithCompression(rawUpload.any(), {
      targetKB: 100,
    });
  },
};

// 🌍 Utility to generate public web paths
function toWebPath(fieldname, filename) {
  const sub = SUBFOLDERS[fieldname] || SUBFOLDERS.default;
  return `/uploads/${sub}/${filename}`;
}

upload.toWebPath = toWebPath;
upload.UPLOAD_ROOT = UPLOAD_ROOT;
upload.SUBFOLDERS = SUBFOLDERS;
upload.rawUpload = rawUpload;

module.exports = upload;