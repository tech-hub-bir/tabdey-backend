const { prisma } = require("../lib/prisma.js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const redis = require("../models/redisClient");

// Helper function to convert BigInt safely
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return value;
}

// Helper function for consistent error responses
function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({
    success: false,
    message,
  });
}

// Phone numbers that skip the single-device lock
const DEMO_BYPASS_PHONES = ["+97517368132"];

function isDemoBypassPhone(phone) {
  return Boolean(phone) && DEMO_BYPASS_PHONES.includes(phone);
}

function normalizeBhutanPhone(raw) {
  if (raw == null) return null;

  let value = String(raw)
    .trim()
    .replace(/[^\d+]/g, "");

  if (!value) return null;

  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (value.startsWith("+975")) return value;
  if (value.startsWith("975")) return `+${value}`;
  if (value.startsWith("+")) return value;

  return `+975${value}`;
}

function normalizeEmail(raw) {
  if (raw == null) return null;

  const value = String(raw).trim().toLowerCase();

  return value || null;
}

function normalizeRole(raw) {
  if (raw == null) return null;

  const value = String(raw).trim().toLowerCase();

  const aliases = {
    superadmin: "super_admin",
    "super admin": "super_admin",
  };

  return aliases[value] || value || null;
}

function normalizeCid(raw) {
  if (raw == null) return null;

  const value = String(raw).trim();

  return value || null;
}

function safeDeviceId(raw) {
  const value = raw == null ? "" : String(raw).trim();

  return value || null;
}

function truthy(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;

  const normalized = String(value).trim().toLowerCase();

  return ["true", "1", "yes", "y"].includes(normalized);
}

function isAdminRole(role) {
  const normalizedRole = normalizeRole(role);

  return ["admin", "super_admin", "finance"].includes(normalizedRole);
}

const ALLOWED_REGISTRATION_ROLES = [
  "user",
  "merchant",
  "driver",
  "organizer",
  "finance",
  "admin",
];

const ALLOWED_LOGIN_ROLES = [...ALLOWED_REGISTRATION_ROLES, "super_admin"];

/* ===================== REGISTER ===================== */
const registerUser = async (req, res) => {
  let userId = null;
  let driverId = null;
  let requestedRole = null;

  try {
    const { user, driver, documents, vehicle } = req.body || {};

    requestedRole = normalizeRole(user?.role);

    const normalizedEmail = normalizeEmail(user?.email);
    const normalizedPhone = normalizeBhutanPhone(user?.phone);
    const normalizedCid = normalizeCid(user?.cid);

    const normalizedUserName = user?.user_name
      ? String(user.user_name).trim()
      : null;

    const password = user?.password != null ? String(user.password) : null;

    if (
      !user ||
      !normalizedUserName ||
      !normalizedEmail ||
      !normalizedPhone ||
      !password ||
      !requestedRole
    ) {
      return errorResponse(
        res,
        400,
        "User name, email, phone number, password and role are required.",
      );
    }

    if (!ALLOWED_REGISTRATION_ROLES.includes(requestedRole)) {
      return errorResponse(
        res,
        400,
        "Invalid role. Allowed roles are user, merchant, driver, organizer, finance and admin.",
      );
    }

    /*
     * Check duplicates only within the requested role.
     *
     * Same email, phone, or CID with another role is allowed.
     * Same email, phone, or CID with the same role is rejected.
     */
    const existingAccounts = await prisma.$queryRaw`
      SELECT
        user_id,
        email,
        phone,
        cid,
        role
      FROM users
      WHERE LOWER(role) = ${requestedRole}
        AND (
          LOWER(email) = ${normalizedEmail}
          OR phone = ${normalizedPhone}
          OR (
            ${normalizedCid} IS NOT NULL
            AND cid = ${normalizedCid}
          )
        )
      LIMIT 10
    `;

    const emailAlreadyExists = existingAccounts.some(
      (account) =>
        normalizeEmail(account.email) === normalizedEmail &&
        normalizeRole(account.role) === requestedRole,
    );

    if (emailAlreadyExists) {
      return errorResponse(
        res,
        409,
        `This email is already registered under the ${requestedRole} role.`,
      );
    }

    const phoneAlreadyExists = existingAccounts.some(
      (account) =>
        normalizeBhutanPhone(account.phone) === normalizedPhone &&
        normalizeRole(account.role) === requestedRole,
    );

    if (phoneAlreadyExists) {
      return errorResponse(
        res,
        409,
        `This phone number is already registered under the ${requestedRole} role.`,
      );
    }

    const cidAlreadyExists =
      normalizedCid &&
      existingAccounts.some(
        (account) =>
          normalizeCid(account.cid) === normalizedCid &&
          normalizeRole(account.role) === requestedRole,
      );

    if (cidAlreadyExists) {
      return errorResponse(
        res,
        409,
        `This CID is already registered under the ${requestedRole} role.`,
      );
    }

    const deviceID = safeDeviceId(
      driver?.device_id ??
        req.body?.device_id ??
        req.body?.deviceID ??
        req.body?.deviceId ??
        req.body?.deviceid ??
        null,
    );

    // Admin, finance and organizer accounts do not require a device
    const requiresDevice = !["admin", "finance", "organizer"].includes(
      requestedRole,
    );

    if (requiresDevice && !deviceID) {
      return errorResponse(res, 400, "Device ID is required for registration.");
    }

    /*
     * Server-side OTP gate.
     *
     * The client must have already completed phone OTP verification
     * (POST /driver/api/sms-otp/verify-otp-sms) which sets this Redis flag.
     * The flag is never trusted from client-supplied fields and is
     * consumed (deleted) below so it cannot be replayed.
     */
    // smsOtpController.js stores/reads "verified_sms:{phone}" using a
    // plus-less digit format (e.g. "975XXXXXXXX"), while normalizeBhutanPhone
    // keeps the "+" for storage/display. Strip it here so the OTP lookup key
    // actually matches what verify-otp-sms wrote.
    const otpPhoneKey = normalizedPhone
      ? normalizedPhone.replace(/^\+/, "")
      : null;
    const verifiedSmsFlag = otpPhoneKey
      ? await redis.get(`verified_sms:${otpPhoneKey}`)
      : null;

    if (!verifiedSmsFlag) {
      return errorResponse(
        res,
        401,
        "Phone number not verified. Please verify the OTP sent to your phone before registering.",
      );
    }

    await prisma.$transaction(async (prismaTx) => {
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await prismaTx.users.create({
        data: {
          user_name: normalizedUserName,
          email: normalizedEmail,
          phone: normalizedPhone,
          cid: normalizedCid,
          password_hash: hashedPassword,
          is_verified: false,
          is_active: true,
          role: requestedRole,
        },
      });

      userId = toNumber(newUser.user_id);

      if (requiresDevice) {
        if (requestedRole === "driver") {
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

      // Driver-specific registration
      if (requestedRole === "driver") {
        if (
          !driver ||
          !Array.isArray(driver.current_location?.coordinates) ||
          driver.current_location.coordinates.length < 2 ||
          !driver.license_number ||
          !driver.license_expiry
        ) {
          throw new Error("missing_driver_fields");
        }

        if (!vehicle || !vehicle.capacity || !vehicle.vehicle_type) {
          throw new Error("missing_vehicle_fields");
        }

        const lng = Number(driver.current_location.coordinates[0]);

        const lat = Number(driver.current_location.coordinates[1]);

        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          throw new Error("invalid_driver_location");
        }

        const licenseExpiry = new Date(driver.license_expiry);

        if (Number.isNaN(licenseExpiry.getTime())) {
          throw new Error("invalid_license_expiry");
        }

        await prismaTx.$executeRaw`
          INSERT INTO drivers (
            user_id,
            license_number,
            license_expiry,
            approval_status,
            is_approved,
            rating,
            total_rides,
            is_online,
            current_location,
            current_location_updated_at
          ) VALUES (
            ${newUser.user_id},
            ${driver.license_number},
            ${licenseExpiry},
            'pending',
            0,
            0.00,
            0,
            0,
            ST_GeomFromText(${`POINT(${lng} ${lat})`}, 4326),
            NOW()
          )
        `;

        const newDriver = await prismaTx.drivers.findFirst({
          where: {
            user_id: newUser.user_id,
          },
          select: {
            driver_id: true,
          },
          orderBy: {
            driver_id: "desc",
          },
        });

        if (!newDriver) {
          throw new Error("driver_insert_failed");
        }

        driverId = toNumber(newDriver.driver_id);

        if (Array.isArray(documents) && documents.length > 0) {
          for (const document of documents) {
            if (!document?.document_type || !document?.document_url) {
              throw new Error("invalid_driver_document");
            }

            await prismaTx.driver_documents.create({
              data: {
                driver_id: newDriver.driver_id,
                document_type: document.document_type,
                document_url: document.document_url,
              },
            });
          }
        }

        const insuranceExpiry = vehicle.insurance_expiry
          ? new Date(vehicle.insurance_expiry)
          : null;

        if (insuranceExpiry && Number.isNaN(insuranceExpiry.getTime())) {
          throw new Error("invalid_insurance_expiry");
        }

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
              const features = vehicle.features;

              if (features == null) return null;

              if (Array.isArray(features)) {
                return features.join(",");
              }

              if (typeof features === "object") {
                return Object.values(features).join(",");
              }

              return String(features);
            })(),

            insurance_expiry: insuranceExpiry,
            code: vehicle.code ?? null,
          },
        });
      }
    });

    // OTP flag is single-use — consume it now that the account exists.
    if (otpPhoneKey) await redis.del(`verified_sms:${otpPhoneKey}`);

    const registrationMessages = {
      user: "User registration successful",
      merchant: "Merchant registration successful",
      driver: "Driver registration successful",
      organizer: "Organizer registration successful",
      finance: "Finance registration successful",
      admin: "Admin registration successful",
    };

    return res.status(201).json({
      success: true,

      message: registrationMessages[requestedRole] || "Registration successful",

      user_id: userId,
      email: normalizedEmail,
      phone: normalizedPhone,
      role: requestedRole,

      ...(normalizedCid
        ? {
            cid: normalizedCid,
          }
        : {}),

      ...(requestedRole === "driver" && driverId
        ? {
            driver_id: driverId,
          }
        : {}),
    });
  } catch (err) {
    console.error("Registration error:", err?.message || err);

    console.error("Registration error code:", err?.code, "meta:", err?.meta);

    /*
     * Composite database unique indexes protect against
     * simultaneous duplicate registration requests.
     */
    if (err?.code === "P2002") {
      const targetValue = err.meta?.target;

      const target = Array.isArray(targetValue)
        ? targetValue
        : targetValue
          ? [String(targetValue)]
          : [];

      const targetText = target.join(",").toLowerCase();

      if (targetText.includes("email")) {
        return errorResponse(
          res,
          409,
          `This email is already registered under the ${
            requestedRole || "selected"
          } role.`,
        );
      }

      if (targetText.includes("phone")) {
        return errorResponse(
          res,
          409,
          `This phone number is already registered under the ${
            requestedRole || "selected"
          } role.`,
        );
      }

      if (targetText.includes("cid")) {
        return errorResponse(
          res,
          409,
          `This CID is already registered under the ${
            requestedRole || "selected"
          } role.`,
        );
      }

      return errorResponse(
        res,
        409,
        `An account already exists with this information under the ${
          requestedRole || "selected"
        } role.`,
      );
    }

    if (err?.message === "missing_driver_fields") {
      return errorResponse(
        res,
        400,
        "Please provide all required driver information, including licence and current location.",
      );
    }

    if (err?.message === "missing_vehicle_fields") {
      return errorResponse(
        res,
        400,
        "Please provide all required vehicle information.",
      );
    }

    if (err?.message === "invalid_driver_location") {
      return errorResponse(
        res,
        400,
        "The supplied driver location is invalid.",
      );
    }

    if (err?.message === "invalid_license_expiry") {
      return errorResponse(
        res,
        400,
        "The supplied licence expiry date is invalid.",
      );
    }

    if (err?.message === "invalid_insurance_expiry") {
      return errorResponse(
        res,
        400,
        "The supplied insurance expiry date is invalid.",
      );
    }

    if (err?.message === "invalid_driver_document") {
      return errorResponse(
        res,
        400,
        "Each driver document must include document_type and document_url.",
      );
    }

    if (err?.message === "driver_insert_failed") {
      return errorResponse(
        res,
        500,
        "Failed to create driver record. Please try again.",
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
  try {
    const body = req.body || {};

    const phone = normalizeBhutanPhone(body.phone);
    const email = normalizeEmail(body.email);
    const role = normalizeRole(body.role);

    const password = body.password != null ? String(body.password) : null;

    if (!role) {
      return errorResponse(res, 400, "Role is required to login.");
    }

    if (!ALLOWED_LOGIN_ROLES.includes(role)) {
      return errorResponse(res, 400, "Invalid account role.");
    }

    if (!password) {
      return errorResponse(res, 400, "Password is required.");
    }

    if (!phone && !email) {
      return errorResponse(
        res,
        400,
        "Please provide either an email address or phone number.",
      );
    }

    const desktop = truthy(body.desktop);

    const deviceId = safeDeviceId(
      body.device_id ?? body.deviceID ?? body.deviceId ?? body.deviceid ?? null,
    );

    /*
     * Login is role-scoped.
     *
     * The backend searches only:
     * email + requested role
     * or
     * phone + requested role
     */
    let candidates;

    if (email) {
      candidates = await prisma.$queryRaw`
        SELECT
          user_id,
          user_name,
          phone,
          email,
          role,
          is_active,
          is_verified,
          password_hash
        FROM users
        WHERE LOWER(email) = ${email}
          AND LOWER(role) = ${role}
        ORDER BY user_id DESC
        LIMIT 1
      `;
    } else {
      candidates = await prisma.$queryRaw`
        SELECT
          user_id,
          user_name,
          phone,
          email,
          role,
          is_active,
          is_verified,
          password_hash
        FROM users
        WHERE phone = ${phone}
          AND LOWER(role) = ${role}
        ORDER BY user_id DESC
        LIMIT 1
      `;
    }

    const picked = candidates?.[0] || null;

    // Generic message shared by "no such account" and "wrong password" so a
    // caller cannot enumerate which phone/email numbers have registered accounts.
    const invalidCredentialsMessage = "Incorrect email/phone or password.";

    if (!picked) {
      return errorResponse(res, 401, invalidCredentialsMessage);
    }

    if (!picked.password_hash) {
      return errorResponse(res, 401, invalidCredentialsMessage);
    }

    /*
     * Compare the submitted password only with the account
     * found under the selected role.
     */
    const passwordMatches = await bcrypt.compare(
      password,
      picked.password_hash,
    );

    if (!passwordMatches) {
      return errorResponse(res, 401, invalidCredentialsMessage);
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: toNumber(picked.user_id),
      },
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

    /*
     * Defence-in-depth check.
     * Never issue a token for a role different from the role requested.
     */
    if (normalizeRole(user.role) !== role) {
      return errorResponse(
        res,
        403,
        "The selected role does not match this account.",
      );
    }

    if (user.is_active === false) {
      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support for assistance.",
      );
    }

    // Block drivers whose registration has not been approved
    if (role === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: {
          user_id: user.user_id,
        },
        select: {
          approval_status: true,
        },
      });

      const status = String(
        driverRecord?.approval_status || "pending",
      ).toLowerCase();

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

    const roleLower = normalizeRole(user.role);

    const isMerchant = roleLower === "merchant";
    const isFinance = roleLower === "finance";
    const adminNoDevice = isAdminRole(roleLower);

    const merchantDesktopNoDevice = isMerchant && desktop;

    const financeNoDevice = isFinance && desktop;

    // Device conflict check
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      !isDemoBypassPhone(user.phone) &&
      user.is_verified === true &&
      deviceId
    ) {
      const deviceRecord = await prisma.all_device_ids.findUnique({
        where: {
          user_id: user.user_id,
        },
        select: {
          device_id: true,
        },
      });

      const databaseDeviceId = deviceRecord?.device_id
        ? String(deviceRecord.device_id)
        : null;

      if (!databaseDeviceId || databaseDeviceId !== deviceId) {
        return errorResponse(
          res,
          409,
          "You are already logged in on another device. Please logout from that device first.",
        );
      }
    }

    // Save or update device ID
    if (
      !adminNoDevice &&
      !merchantDesktopNoDevice &&
      !financeNoDevice &&
      deviceId
    ) {
      try {
        await prisma.all_device_ids.upsert({
          where: {
            user_id: user.user_id,
          },
          update: {
            device_id: deviceId,
            last_seen: new Date(),
          },
          create: {
            user_id: user.user_id,
            device_id: deviceId,
            last_seen: new Date(),
          },
        });
      } catch (deviceError) {
        console.error(
          "device_id save failed:",
          deviceError?.message || deviceError,
        );
      }
    }

    if (phone && user.phone && user.phone !== phone) {
      try {
        await prisma.users.update({
          where: {
            user_id: user.user_id,
          },
          data: {
            phone,
          },
        });

        user.phone = phone;
      } catch (phoneError) {
        console.error(
          "phone normalize update failed:",
          phoneError?.message || phoneError,
        );
      }
    }

    try {
      await prisma.users.update({
        where: {
          user_id: user.user_id,
        },
        data: {
          is_verified: true,
          last_login: new Date(),
        },
      });

      user.is_verified = true;
    } catch (verificationError) {
      console.error(
        "is_verified update failed:",
        verificationError?.message || verificationError,
      );
    }

    let owner_type = null;
    let business_id = null;
    let business_name = null;
    let business_logo = null;
    let address = null;

    if (isMerchant) {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: {
            user_id: user.user_id,
          },
          orderBy: [
            {
              created_at: "desc",
            },
            {
              business_id: "desc",
            },
          ],
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
      } catch (businessError) {
        console.error(
          "merchant extras fetch failed:",
          businessError?.message || businessError,
        );
      }
    }

    const payload = {
      user_id: toNumber(user.user_id),
      role: roleLower,
      user_name: user.user_name,
      phone: user.phone,
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
      role: roleLower,
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
      where: {
        user_id: n,
      },
      data: {
        is_verified: false,
        last_login: new Date(),
      },
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
      where: {
        user_id: uid,
      },
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
        where: {
          user_id: uid,
        },
        data: {
          is_verified: false,
          last_login: new Date(),
        },
      });

      return errorResponse(
        res,
        403,
        "Your account has been deactivated. Please contact support.",
      );
    }

    if (user.is_verified === false) {
      await prisma.users.update({
        where: {
          user_id: uid,
        },
        data: {
          is_verified: false,
          last_login: new Date(),
        },
      });

      return res.status(200).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    // Block drivers whose registration is not approved
    if (normalizeRole(user.role) === "driver") {
      const driverRecord = await prisma.drivers.findFirst({
        where: {
          user_id: uid,
        },
        select: {
          approval_status: true,
        },
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
      where: {
        user_id: uid,
      },
      select: {
        device_id: true,
      },
    });

    const databaseDeviceId = deviceRecord?.device_id
      ? String(deviceRecord.device_id)
      : null;

    if (!databaseDeviceId || databaseDeviceId !== deviceId) {
      await prisma.users.update({
        where: {
          user_id: uid,
        },
        data: {
          is_verified: false,
          last_login: new Date(),
        },
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

    if (normalizeRole(user.role) === "merchant") {
      try {
        const business = await prisma.merchant_business_details.findFirst({
          where: {
            user_id: uid,
          },
          orderBy: [
            {
              created_at: "desc",
            },
            {
              business_id: "desc",
            },
          ],
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
      } catch (businessError) {
        console.error(
          "merchant extras fetch failed:",
          businessError?.message || businessError,
        );
      }
    }

    const normalizedRole = normalizeRole(user.role);

    const payload = {
      user_id: toNumber(user.user_id),
      role: normalizedRole,
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
      role: normalizedRole,
      email: user.email,
      is_verified: 1,
      device_id: deviceId,
    };

    if (normalizedRole === "merchant") {
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

    const authorization = req.headers.authorization || "";

    const headerToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : null;

    const refreshToken = bodyToken || headerToken;

    if (!refreshToken) {
      return errorResponse(res, 400, "Refresh token is required.");
    }

    let decoded;

    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (verificationError) {
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
      where: {
        user_id: uid,
      },
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

    const payload = {
      user_id: toNumber(user.user_id),
      role: normalizeRole(user.role),
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
        refresh_token: refreshToken,
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
