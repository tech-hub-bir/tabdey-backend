const { prisma } = require("../lib/prisma.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Helper function to convert BigInt safely
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return value;
}

// Helper function for consistent error responses
function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

// Phone numbers (e.g. App Store review demo accounts) that skip the
// single-device lock so reviewers can log in from any device without an SMS OTP.
const DEMO_BYPASS_PHONES = ["+97517368132"];

function isDemoBypassPhone(phone) {
  return Boolean(phone) && DEMO_BYPASS_PHONES.includes(phone);
}

/* ===================== REGISTER ===================== */
const registerUser = async (req, res) => {
  let userId = null;
  let driverId = null;

  const normalizeBhutanPhone = (raw) => {
    if (raw == null) return null;
    let s = String(raw)
      .trim()
      .replace(/[^\d+]/g, "");
    if (s.startsWith("00")) s = `+${s.slice(2)}`;
    if (s.startsWith("+975")) return s;
    if (s.startsWith("975")) return `+${s}`;
    if (s.startsWith("+")) return s;
    return `+975${s}`;
  };

  try {
    const { user, driver, documents, vehicle } = req.body;

    if (!user || !user.password || !user.role) {
      return errorResponse(
        res,
        400,
        "Please provide all required user information",
      );
    }

    const normalizedPhone = normalizeBhutanPhone(user.phone);
    const deviceID = driver?.device_id ?? req.body.deviceID ?? null;

    // Admin and finance roles don't require device
    const requiresDevice =
      user?.role !== "admin" &&
      user?.role !== "finance" &&
      user?.role !== "organizer";

    if (requiresDevice && !deviceID) {
      return errorResponse(res, 400, "Device ID is required for registration");
    }

    await prisma.$transaction(async (prismaTx) => {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      const newUser = await prismaTx.users.create({
        data: {
          user_name: user.user_name ?? null,
          email: user.email ? user.email.toLowerCase() : null,
          phone: normalizedPhone,
          password_hash: hashedPassword,
          is_verified: false,
          is_active: true,
          role: user.role,
        },
      });

      userId = toNumber(newUser.user_id);

      if (requiresDevice) {
        if (user.role === "driver") {
          await prismaTx.driver_devices.create({
            data: {
              user_id: newUser.user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        } else {
          await prismaTx.user_devices.create({
            data: {
              user_id: newUser.user_id,
              device_id: deviceID,
              updated_at: new Date(),
            },
          });
        }
      }

      // Driver-specific validation (skip for finance, admin, merchant)
      if (user.role === "driver") {
        if (
          !driver ||
          !driver.current_location?.coordinates ||
          !driver.license_number ||
          !driver.license_expiry
        ) {
          throw new Error("missing_driver_fields");
        }
        if (!vehicle || !vehicle.capacity || !vehicle.vehicle_type) {
          throw new Error("missing_vehicle_fields");
        }

        const lng = driver.current_location.coordinates[0];
        const lat = driver.current_location.coordinates[1];

        // current_location is POINT SRID 4326 NOT NULL — Prisma skips
        // Unsupported fields, so we use raw SQL for this INSERT.
        await prismaTx.$executeRaw`
          INSERT INTO drivers (
            user_id, license_number, license_expiry,
            approval_status, is_approved, rating, total_rides,
            is_online, current_location, current_location_updated_at
          ) VALUES (
            ${newUser.user_id},
            ${driver.license_number},
            ${new Date(driver.license_expiry)},
            'pending', 0, 0.00, 0, 0,
            ST_GeomFromText(${`POINT(${lng} ${lat})`}, 4326),
            NOW()
          )
        `;

        const newDriver = await prismaTx.drivers.findFirst({
          where: { user_id: newUser.user_id },
          select: { driver_id: true },
          orderBy: { driver_id: "desc" },
        });

        if (!newDriver) throw new Error("driver_insert_failed");

        driverId = toNumber(newDriver.driver_id);

        if (Array.isArray(documents) && documents.length > 0) {
          for (const doc of documents) {
            await prismaTx.driver_documents.create({
              data: {
                driver_id: newDriver.driver_id,
                document_type: doc.document_type,
                document_url: doc.document_url,
              },
            });
          }
        }

        if (vehicle) {
          await prismaTx.driver_vehicles.create({
            data: {
              driver_id: newDriver.driver_id,
              make: vehicle.make ?? null,
              model: vehicle.model ?? null,
              year: vehicle.year ?? null,
              color: vehicle.color ?? null,
              license_plate: vehicle.license_plate ?? null,
              vehicle_type: vehicle.vehicle_type,
              actual_capacity: vehicle.capacity,
              available_capacity: vehicle.capacity,
              features: (() => {
                const f = vehicle.features;
                if (f == null) return null;
                if (Array.isArray(f)) return f.join(",");
                if (typeof f === "object") return Object.values(f).join(",");
                return String(f);
              })(),
              insurance_expiry: vehicle.insurance_expiry
                ? new Date(vehicle.insurance_expiry)
                : null,
              code: vehicle.code ?? null,
            },
          });
        }
      }
    });

    let message = "Registration successful";
    if (user.role === "driver") message = "Driver registration successful";
    if (user.role === "admin") message = "Admin registration successful";
    if (user.role === "finance") message = "Finance registration successful";

    return res.status(201).json({
      success: true,
      message,
      user_id: userId,
      phone: normalizedPhone,
    });
  } catch (err) {
    console.error("Registration error:", err?.message || err);
    console.error("Registration error code:", err?.code, "meta:", err?.meta);

    if (err.code === "P2002") {
      const target = err.meta?.target;
      if (Array.isArray(target)) {
        if (target.includes("email")) {
          return errorResponse(
            res,
            409,
            "This email is already registered. Please use a different email or login.",
          );
        }
        if (target.includes("phone")) {
          return errorResponse(
            res,
            409,
            "This phone number is already registered. Please use a different number or login.",
          );
        }
      }
      return errorResponse(
        res,
        409,
        "Account already exists with this information.",
      );
    }

    if (err.message === "driver_insert_failed") {
      return errorResponse(
        res,
        500,
        "Failed to create driver record. Please try again.",
      );
    }

    if (err.message === "missing_driver_fields") {
      return errorResponse(
        res,
        400,
        "Please provide all required driver information including license and location.",
      );
    }

    if (err.message === "missing_vehicle_fields") {
      return errorResponse(
        res,
        400,
        "Please provide all required vehicle information.",
      );
    }

    return errorResponse(
      res,
      500,
      "Registration failed. Please try again later.",
    );
  }
};

/* ===================== LOGIN ===================== */
const loginUser = async (req, res) => {
  const normalizeBhutanPhone = (raw) => {
    if (raw == null) return null;
    let s = String(raw)
      .trim()
      .replace(/[^\d+]/g, "");
    if (!s) return null;
    if (s.startsWith("00")) s = `+${s.slice(2)}`;
    if (s.startsWith("+975")) return s;
    if (s.startsWith("975")) return `+${s}`;
    if (s.startsWith("+")) return s;
    return `+975${s}`;
  };

  const normalizeEmail = (raw) => {
    if (raw == null) return null;
    const e = String(raw).trim().toLowerCase();
    return e ? e : null;
  };

  const safeDeviceId = (raw) => {
    const v = raw == null ? "" : String(raw).trim();
    return v ? v : null;
  };

  const truthy = (v) => {
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "y";
  };

  const isAdminRole = (role) => {
    const r = String(role || "")
      .toLowerCase()
      .trim();
    return (
      r === "admin" ||
      r === "super admin" ||
      r === "super_admin" ||
      r === "superadmin" ||
      r === "finance"
    );
  };

  try {
    const b = req.body || {};
    const phone = b.phone ? normalizeBhutanPhone(b.phone) : null;
    const email = b.email ? normalizeEmail(b.email) : null;
    const password = b.password != null ? String(b.password) : null;

    if (!password) {
      return errorResponse(res, 400, "Password is required");
    }

    if (!phone && !email) {
      return errorResponse(
        res,
        400,
        "Please provide either email or phone number to login",
      );
    }

    const desktop = truthy(b.desktop);
    const deviceId = safeDeviceId(
      b.device_id ?? b.deviceID ?? b.deviceId ?? b.deviceid ?? null,
    );

    let candidates = [];

    if (email) {
      const normalizedEmail = email.toLowerCase();
      candidates = await prisma.$queryRaw`
        SELECT user_id, user_name, phone, email, role, is_active, is_verified, password_hash
        FROM users
        WHERE LOWER(email) = ${normalizedEmail}
        ORDER BY user_id DESC
        LIMIT 25
      `;
    } else {
      candidates = await prisma.users.findMany({
        where: { phone: phone },
        select: {
          user_id: true,
          user_name: true,
          phone: true,
          email: true,
          role: true,
          is_active: true,
          is_verified: true,
          password_hash: true,
        },
        orderBy: { user_id: "desc" },
        take: 25,
      });
    }

    if (!candidates.length) {
      return errorResponse(
        res,
        404,
        "No account found with this email or phone number. Please check and try again.",
      );
    }

    let picked = null;
    for (const u of candidates) {
      if (!u?.password_hash) continue;
      const ok = await bcrypt.compare(password, u.password_hash);
      if (ok) {
        picked = u;
        break;
      }
    }

    if (!picked) {
      return errorResponse(res, 401, "Incorrect password. Please try again.");
    }

    const user = await prisma.users.findUnique({
      where: { user_id: toNumber(picked.user_id) },
      select: {
        user_id: true,
        user_name: true,
        phone: true,
        email: true,
        role: true,
        is_active: true,
        is_verified: true,
      },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "Account not found. Please contact support.",
      );
    }

    user.user_id = toNumber(user.user_id);

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support for assistance.",
      );
    }

    // Block drivers whose registration has not yet been approved
    if (user.role === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: { user_id: user.user_id },
        select: { approval_status: true },
      });

      const status = driverRecord?.approval_status ?? "pending";

      if (status === "pending") {
        return errorResponse(
          res,
          403,
          "Your registration is under review. You will be notified once approved.",
        );
      }

      if (status === "rejected") {
        return errorResponse(
          res,
          403,
          "Your registration was not approved. Please contact support for more information.",
        );
      }
    }

    const roleLower = String(user.role || "")
      .toLowerCase()
      .trim();
    const isMerchant = roleLower === "merchant";
    const isFinance = roleLower === "finance";
    const adminNoDevice = isAdminRole(user.role);
    const merchantDesktopNoDevice = isMerchant && desktop === true;
    const financeNoDevice = isFinance && desktop === true;

    // Device conflict check - skip for finance, admin, demo/review accounts,
    // and when no device_id was supplied (device_id is optional for login)
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      !isDemoBypassPhone(user.phone) &&
      user.is_verified === true &&
      deviceId
    ) {
      const deviceRecord = await prisma.all_device_ids.findUnique({
        where: { user_id: user.user_id },
        select: { device_id: true },
      });

      const dbDeviceId = deviceRecord?.device_id
        ? String(deviceRecord.device_id)
        : null;

      if (!dbDeviceId || dbDeviceId !== deviceId) {
        return errorResponse(
          res,
          409,
          "You are already logged in on another device. Please logout from that device first.",
        );
      }
    }

    // Update device ID - skip for finance and admin
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      deviceId
    ) {
      try {
        await prisma.all_device_ids.upsert({
          where: { user_id: user.user_id },
          update: { device_id: deviceId, last_seen: new Date() },
          create: {
            user_id: user.user_id,
            device_id: deviceId,
            last_seen: new Date(),
          },
        });
      } catch (e) {
        console.error("device_id save failed:", e?.message || e);
      }
    }

    if (phone && user.phone && user.phone !== phone) {
      try {
        await prisma.users.update({
          where: { user_id: user.user_id },
          data: { phone: phone },
        });
        user.phone = phone;
      } catch (e) {
        console.error("phone normalize update failed:", e?.message || e);
      }
    }

    try {
      await prisma.users.update({
        where: { user_id: user.user_id },
        data: { is_verified: true, last_login: new Date() },
      });
      user.is_verified = true;
    } catch (e) {
      console.error("is_verified update failed:", e?.message || e);
    }

    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (isMerchant) {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: { user_id: user.user_id },
          orderBy: [{ created_at: "desc" }, { business_id: "desc" }],
          select: {
            business_id: true,
            business_name: true,
            owner_type: true,
            business_logo: true,
            address: true,
          },
        });

        if (business) {
          owner_type = business.owner_type ?? null;
          business_id = business.business_id
            ? toNumber(business.business_id)
            : null;
          business_name = business.business_name ?? null;
          business_logo = business.business_logo ?? null;
          address = business.address ?? null;
        }
      } catch (e) {
        console.error("merchant extras fetch failed:", e?.message || e);
      }
    }

    const payload = {
      user_id: toNumber(user.user_id),
      role: user.role,
      user_name: user.user_name,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });
    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "1440m",
    });

    // Build user response object
    const userResponse = {
      user_id: toNumber(user.user_id),
      user_name: user.user_name,
      phone: user.phone,
      role: user.role,
      email: user.email,
      is_verified: user.is_verified ? 1 : 0,
    };

    if (isMerchant) {
      userResponse.owner_type = owner_type;
      userResponse.business_id = business_id;
      userResponse.business_name = business_name;
      userResponse.business_logo = business_logo;
      userResponse.address = address;
      userResponse.device_id =
        adminNoDevice || merchantDesktopNoDevice ? null : deviceId;
    } else if (isFinance) {
      userResponse.device_id =
        adminNoDevice || financeNoDevice ? null : deviceId;
    } else {
      userResponse.device_id = adminNoDevice ? null : deviceId;
    }

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 1440,
      },
      user: userResponse,
    });
  } catch (err) {
    console.error("loginUser error:", err);
    return errorResponse(
      res,
      500,
      "Unable to login at this time. Please try again later.",
    );
  }
};

/* ===================== LOGOUT ===================== */
const logoutUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const n = Number(user_id);

    if (!Number.isInteger(n) || n <= 0) {
      return errorResponse(
        res,
        400,
        "Invalid user information. Please try again.",
      );
    }

    const result = await prisma.users.update({
      where: { user_id: n },
      data: { is_verified: false, last_login: new Date() },
    });

    if (!result) {
      return errorResponse(
        res,
        404,
        "Account not found. Please contact support.",
      );
    }

    return res.status(200).json({
      success: true,
      message: "You have been successfully logged out.",
    });
  } catch (err) {
    console.error("Logout error:", err);
    if (err.code === "P2025") {
      return errorResponse(
        res,
        404,
        "Account not found. Please contact support.",
      );
    }
    return errorResponse(
      res,
      500,
      "Unable to logout at this time. Please try again later.",
    );
  }
};

/* ===================== VERIFY ACTIVE SESSION ===================== */
const verifyActiveSession = async (req, res) => {
  const { user_id, device_id } = req.body || {};

  const uid = Number(user_id);
  const deviceId =
    device_id && String(device_id).trim() ? String(device_id).trim() : null;

  if (!Number.isInteger(uid) || uid <= 0) {
    return errorResponse(res, 400, "Invalid user information.");
  }

  if (!deviceId) {
    return errorResponse(res, 400, "Device information is required.");
  }

  try {
    const user = await prisma.users.findUnique({
      where: { user_id: uid },
      select: {
        user_id: true,
        user_name: true,
        phone: true,
        email: true,
        role: true,
        is_active: true,
        is_verified: true,
      },
    });

    if (!user) {
      return errorResponse(res, 404, "Account not found.");
    }

    if (user.is_active === false) {
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: false, last_login: new Date() },
      });
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    if (user.is_verified === false) {
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: false, last_login: new Date() },
      });
      return res.status(200).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    // Block drivers whose registration has not yet been approved
    if (user.role === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: { user_id: uid },
        select: { approval_status: true },
      });

      const status = driverRecord?.approval_status ?? "pending";

      if (status === "pending") {
        return res.status(200).json({
          success: false,
          message:
            "Your registration is under review. You will be notified once approved.",
          approval_status: "pending",
        });
      }

      if (status === "rejected") {
        return res.status(200).json({
          success: false,
          message:
            "Your registration was not approved. Please contact support for more information.",
          approval_status: "rejected",
        });
      }
    }

    const deviceRecord = await prisma.all_device_ids.findUnique({
      where: { user_id: uid },
      select: { device_id: true },
    });

    const dbDeviceId = deviceRecord?.device_id
      ? String(deviceRecord.device_id)
      : null;

    if (!dbDeviceId || dbDeviceId !== deviceId) {
      await prisma.users.update({
        where: { user_id: uid },
        data: { is_verified: false, last_login: new Date() },
      });
      return res.status(200).json({
        success: false,
        message: "Session expired due to device change. Please login again.",
      });
    }

    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (user.role === "merchant") {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: { user_id: uid },
          orderBy: [{ created_at: "desc" }, { business_id: "desc" }],
          select: {
            owner_type: true,
            business_id: true,
            business_name: true,
            business_logo: true,
            address: true,
          },
        });

        if (business) {
          owner_type = business.owner_type ?? null;
          business_id = business.business_id
            ? toNumber(business.business_id)
            : null;
          business_name = business.business_name ?? null;
          business_logo = business.business_logo ?? null;
          address = business.address ?? null;
        }
      } catch (e) {
        console.error("merchant extras fetch failed:", e?.message || e);
      }
    }

    const payload = {
      user_id: toNumber(user.user_id),
      role: user.role,
      phone: String(user.phone || ""),
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });
    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "1440m",
    });

    const userResponse = {
      user_id: toNumber(user.user_id),
      user_name: user.user_name,
      phone: user.phone,
      role: user.role,
      email: user.email,
      is_verified: 1,
      device_id: deviceId,
    };

    if (user.role === "merchant") {
      userResponse.owner_type = owner_type;
      userResponse.business_id = business_id;
      userResponse.business_name = business_name;
      userResponse.business_logo = business_logo;
      userResponse.address = address;
    }

    return res.status(200).json({
      success: true,
      message: "Session verified successfully",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 1440,
      },
      user: userResponse,
    });
  } catch (err) {
    console.error("verifyActiveSession error:", err);
    return errorResponse(
      res,
      500,
      "Unable to verify session. Please try again later.",
    );
  }
};

/* ===================== REFRESH ACCESS TOKEN ===================== */
const refreshAccessToken = async (req, res) => {
  try {
    const bodyToken = req.body?.refresh_token;
    const auth = req.headers.authorization || "";
    const headerToken = auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : null;
    const refreshToken = bodyToken || headerToken;

    if (!refreshToken) {
      return errorResponse(res, 400, "Refresh token is required.");
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (e) {
      return errorResponse(
        res,
        401,
        "Your session has expired. Please login again.",
      );
    }

    const uid = Number(decoded?.user_id);
    if (!Number.isInteger(uid) || uid <= 0) {
      return errorResponse(
        res,
        401,
        "Invalid session information. Please login again.",
      );
    }

    const user = await prisma.users.findUnique({
      where: { user_id: uid },
      select: {
        user_id: true,
        role: true,
        phone: true,
        is_active: true,
        is_verified: true,
      },
    });

    if (!user) {
      return errorResponse(
        res,
        404,
        "Account not found. Please contact support.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    // Allow token refresh for ALL roles regardless of is_verified status
    // Only check if account is active
    const payload = {
      user_id: toNumber(user.user_id),
      role: user.role,
      phone: user.phone,
    };

    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });

    return res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token: refreshToken, // Return the same refresh token
      },
    });
  } catch (err) {
    console.error("refreshAccessToken error:", err);
    return errorResponse(
      res,
      500,
      "Unable to refresh session. Please login again.",
    );
  }
};

module.exports = {
  registerUser,
  loginUser,
  logoutUser,
  verifyActiveSession,
  refreshAccessToken,
};
