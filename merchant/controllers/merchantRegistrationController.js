const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { prisma } = require("../lib/prisma");
const cache = require("../services/cacheService");
const { getRedis } = require("../config/redis");

const {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByEmail,
} = require("../models/merchantRegistrationModel");

/* ---------------- file path helpers ---------------- */

const toRelPath = (fileObj) => {
  if (!fileObj) return null;
  let p = String(fileObj.path || "").replace(/\\/g, "/");
  const i = p.lastIndexOf("uploads/");
  if (i !== -1) p = p.slice(i);
  p = p.replace(/^\/+/, "");
  return `/${p}`;
};

const fromBodyToStoredPath = (val) => {
  if (!val) return null;
  const s = String(val).trim();
  if (s.startsWith("/uploads/")) return s;
  if (s.startsWith("uploads/")) return `/${s}`;
  try {
    const u = new URL(s);
    return u.pathname || null;
  } catch {
    return null;
  }
};

/* ---------------- register ---------------- */

async function registerMerchant(req, res) {
  try {
    const f = req.files || {};
    const b = req.body || {};

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

    const toNumOrNull = (val) => {
      if (val === undefined || val === null) return null;
      const s = String(val).trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    const toLowerOrDefault = (val, def) => {
      const s = val !== undefined && val !== null ? String(val).trim() : "";
      return (s || def).toLowerCase();
    };

    const license_image = f.license_image?.[0]
      ? toRelPath(f.license_image[0])
      : fromBodyToStoredPath(b.license_image);

    const business_logo = f.business_logo?.[0]
      ? toRelPath(f.business_logo[0])
      : fromBodyToStoredPath(b.business_logo);

    const bank_qr_code_image = f.bank_qr_code_image?.[0]
      ? toRelPath(f.bank_qr_code_image[0])
      : fromBodyToStoredPath(b.bank_qr_code_image);

    const normalizedPhone = normalizeBhutanPhone(b.phone);
    const normalizedEmailForOtp = String(b.email || "").trim().toLowerCase();

    /*
     * Server-side OTP gate.
     *
     * The registration wizard lets the merchant verify via either channel:
     *   - SMS:   POST /driver/api/sms-otp/send-otp-sms + verify-otp-sms
     *            -> sets Redis "verified_sms:{phone}"
     *   - Email: POST /driver/api/auth/send-otp + verify-otp
     *            -> sets Redis "verified:{email}"
     * Accept either flag (never trusted from client fields), and consume
     * whichever one was actually set so it cannot be replayed.
     */
    const redis = getRedis();

    const [verifiedSmsFlag, verifiedEmailFlag] = await Promise.all([
      redis.get(`verified_sms:${normalizedPhone}`),
      normalizedEmailForOtp
        ? redis.get(`verified:${normalizedEmailForOtp}`)
        : null,
    ]);

    if (!verifiedSmsFlag && !verifiedEmailFlag) {
      return res.status(401).json({
        error:
          "Phone or email not verified. Please verify the OTP sent to you before registering.",
      });
    }

    const payload = {
      user_name: b.user_name,
      email: b.email,
      phone: normalizedPhone,
      cid: b.cid,
      password: b.password,
      // This endpoint only ever creates merchant accounts — a client-supplied
      // role (e.g. "admin") must never be trusted (privilege escalation).
      role: "merchant",
      business_name: b.business_name,
      business_type_ids: b.business_type_ids ?? null,
      business_types: Array.isArray(b.business_types)
        ? b.business_types
        : typeof b.business_types === "string" && b.business_types.trim()
          ? b.business_types
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : undefined,
      business_license_number: b.business_license_number,
      license_image,
      latitude: toNumOrNull(b.latitude),
      longitude: toNumOrNull(b.longitude),
      address: b.address || null,
      business_logo,
      delivery_option: b.delivery_option,
      owner_type: toLowerOrDefault(b.owner_type, "individual"),
      min_amount_for_fd:
        b.min_amount_for_fd !== undefined && b.min_amount_for_fd !== ""
          ? Number(b.min_amount_for_fd)
          : 0,
      bank_name: b.bank_name,
      account_holder_name: b.account_holder_name,
      account_number: b.account_number,
      bank_qr_code_image,
      special_celebration: b.special_celebration || null,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage || null,
    };

    const result = await registerMerchantModel(payload);

    // OTP flags are single-use — consume whichever one was set now that the
    // account exists.
    await Promise.all([
      redis.del(`verified_sms:${normalizedPhone}`),
      normalizedEmailForOtp
        ? redis.del(`verified:${normalizedEmailForOtp}`)
        : null,
    ]);

    return res.status(201).json({
      message: "Merchant registered successfully",
      user_id: result.user_id,
      business_id: result.business_id,
      business_type_ids: result.business_type_ids,
      phone: normalizedPhone,
    });
  } catch (err) {
    console.error("Register error:", err.message);
    const isClientErr =
      /exists|required|invalid|username|business_type_ids/i.test(
        err.message || "",
      );
    return res
      .status(isClientErr ? 400 : 500)
      .json({ error: err.message || "Merchant registration failed" });
  }
}

/* ---------------- update business details ---------------- */

async function updateMerchant(req, res) {
  try {
    const business_id = Number(req.params.businessId);
    if (!Number.isInteger(business_id) || business_id <= 0) {
      return res.status(400).json({ error: "Invalid businessId" });
    }

    const f = req.files || {};
    const b = req.body || {};

    const newLicenseImage = f.license_image?.[0]
      ? toRelPath(f.license_image[0])
      : fromBodyToStoredPath(b.license_image);
    const newBusinessLogo = f.business_logo?.[0]
      ? toRelPath(f.business_logo[0])
      : fromBodyToStoredPath(b.business_logo);

    const updatePayload = {};

    [
      "business_name",
      "business_license_number",
      "address",
      "delivery_option",
      "owner_type",
      "opening_time",
      "closing_time",
      "kitchen_closing_time",
      "special_celebration",
      "special_celebration_discount_percentage",
    ].forEach((k) => {
      if (b[k] !== undefined) {
        updatePayload[k] =
          k === "owner_type" ? String(b[k]).toLowerCase() : b[k];
      }
    });

    if (b.license_image !== undefined || f.license_image?.length) {
      updatePayload.license_image = newLicenseImage;
    }

    if (b.business_logo !== undefined || f.business_logo?.length) {
      updatePayload.business_logo = newBusinessLogo;
    }

    if (typeof b.latitude !== "undefined") {
      updatePayload.latitude = b.latitude === "" ? null : Number(b.latitude);
    }

    if (typeof b.longitude !== "undefined") {
      updatePayload.longitude = b.longitude === "" ? null : Number(b.longitude);
    }

    // Handle holidays field
    if (b.holidays !== undefined) {
      const validDays = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      let holidays = [];
      if (Array.isArray(b.holidays)) {
        holidays = b.holidays.filter((day) => validDays.includes(day));
      } else if (typeof b.holidays === "string") {
        holidays = b.holidays
          .split(",")
          .map((s) => s.trim())
          .filter((day) => validDays.includes(day));
      }
      updatePayload.holidays = JSON.stringify(holidays);
    }

    if (b.business_type_ids !== undefined)
      updatePayload.business_type_ids = b.business_type_ids;

    if (b.business_types !== undefined) {
      updatePayload.business_types = Array.isArray(b.business_types)
        ? b.business_types
        : String(b.business_types)
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
    }

    if (b.min_amount_for_fd !== undefined) {
      updatePayload.min_amount_for_fd = Number(b.min_amount_for_fd);
    }

    const out = await updateMerchantDetailsModel(business_id, updatePayload);

    return res.status(200).json({
      message: "Business details updated",
      business_id: out.business_id,
    });
  } catch (err) {
    console.error("updateMerchant error:", err.message);
    const isClientErr = /not found|invalid/i.test(err.message || "");
    return res
      .status(isClientErr ? 404 : 500)
      .json({ error: err.message || "Update failed" });
  }
}

/* ---------------- login (email + password ONLY) ---------------- */

async function loginByEmail(req, res) {
  try {
    const { email, password, device_id } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const deviceId =
      device_id && String(device_id).trim() ? String(device_id).trim() : null;

    if (!deviceId) {
      return res.status(400).json({ error: "device_id is required" });
    }

    // Generic message shared by "no such account" and "wrong password" so a
    // caller cannot enumerate which email addresses have registered accounts.
    const invalidCredentialsError = "Incorrect email or password.";

    const candidates = await findCandidatesByEmail(email);
    if (!candidates.length) {
      return res.status(401).json({ error: invalidCredentialsError });
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
      return res.status(401).json({ error: invalidCredentialsError });
    }

    const user = await prisma.users.findUnique({
      where: { user_id: picked.user_id },
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

    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.is_active === false)
      return res
        .status(403)
        .json({ error: "Account is deactivated. Please contact support." });

    if (user.is_verified === true) {
      const deviceRecord = await prisma.all_device_ids.findUnique({
        where: { user_id: user.user_id },
        select: { device_id: true },
      });
      const dbDeviceId = deviceRecord?.device_id
        ? String(deviceRecord.device_id)
        : null;
      if (!dbDeviceId || dbDeviceId !== deviceId) {
        return res.status(409).json({
          error:
            "This account appears to be logged in on another device. Please log out from the other device first.",
        });
      }
    }

    await prisma.all_device_ids.upsert({
      where: { user_id: user.user_id },
      update: { device_id: deviceId, last_seen: new Date() },
      create: {
        user_id: user.user_id,
        device_id: deviceId,
        last_seen: new Date(),
      },
    });

    await prisma.users.update({
      where: { user_id: user.user_id },
      data: { is_verified: true, last_login: new Date() },
    });

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

    const payload = {
      user_id: Number(user.user_id),
      role: user.role,
      user_name: user.user_name,
    };
    const access_token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, {
      expiresIn: "60m",
    });
    const refresh_token = jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, {
      expiresIn: "1440m",
    });

    return res.status(200).json({
      message: "Login successful",
      token: {
        access_token,
        access_token_time: 60,
        refresh_token,
        refresh_token_time: 10,
      },
      user: {
        user_id: Number(user.user_id),
        user_name: user.user_name,
        phone: user.phone,
        role: user.role,
        email: user.email,
        is_verified: 1,
        device_id: deviceId,
        owner_type: business?.owner_type ?? null,
        business_id: business?.business_id
          ? Number(business.business_id)
          : null,
        business_name: business?.business_name ?? null,
        business_logo: business?.business_logo ?? null,
        address: business?.address ?? null,
      },
    });
  } catch (err) {
    console.error("loginByEmail error:", err.message);
    return res.status(500).json({ error: "Login failed due to server error" });
  }
}

/* ---------------- owners list ---------------- */

function parseOwnersQuery(req) {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const limit = Math.min(
    Math.max(parseInt(req.query.limit || "50", 10), 1),
    200,
  );
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  return { q, limit, offset };
}

// async function listFoodOwners(req, res) {
//   try {
//     const { q, limit, offset } = parseOwnersQuery(req);
//     const whereCondition = {};
//     if (q) {
//       whereCondition.OR = [
//         { business_name: { contains: q, mode: "insensitive" } },
//         { users: { user_name: { contains: q, mode: "insensitive" } } },
//       ];
//     }

//     const businesses = await prisma.merchant_business_details.findMany({
//       where: { owner_type: "food", ...whereCondition },
//       include: {
//         users: { select: { user_id: true, user_name: true, email: true, phone: true, profile_image: true } },
//         merchant_business_types: { include: { business_types: { select: { id: true, name: true } } } },
//       },
//       orderBy: { created_at: "desc" },
//       skip: offset,
//       take: limit,
//     });

//     const businessIds = businesses.map(b => b.business_id);
//     const ratings = await prisma.food_ratings.groupBy({
//       by: ["business_id"],
//       where: { business_id: { in: businessIds } },
//       _avg: { rating: true },
//       _count: { rating: true },
//     });

//     const ratingsMap = new Map();
//     for (const rating of ratings) {
//       ratingsMap.set(rating.business_id, {
//         avg_rating: rating._avg.rating || 0,
//         total_comments: rating._count.rating || 0,
//       });
//     }

//     const data = businesses.map(b => ({
//       business_id: Number(b.business_id),
//       owner_type: b.owner_type,
//       business_name: b.business_name,
//       business_license_number: b.business_license_number,
//       license_image: b.license_image,
//       latitude: b.latitude,
//       longitude: b.longitude,
//       address: b.address,
//       business_logo: b.business_logo,
//       delivery_option: b.delivery_option,
//       min_amount_for_fd: b.min_amount_for_fd,
//       special_celebration: b.special_celebration,
//       special_celebration_discount_percentage: b.special_celebration_discount_percentage,
//       opening_time: b.opening_time,
//       closing_time: b.closing_time,
//       holidays: b.holidays,
//       complement: b.complementary,
//       complement_details: b.complementary_details,
//       created_at: b.created_at,
//       updated_at: b.updated_at,
//       user: {
//         user_id: Number(b.users.user_id),
//         user_name: b.users.user_name,
//         email: b.users.email,
//         phone: b.users.phone,
//         profile_image: b.users.profile_image || null,
//       },
//       business_types: b.merchant_business_types.map(mbt => ({
//         business_type_id: Number(mbt.business_types.id),
//         name: mbt.business_types.name,
//       })),
//       avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
//       total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
//     }));

//     return res.status(200).json({ success: true, kind: "food", count: data.length, data });
//   } catch (err) {
//     console.error("listFoodOwners error:", err);
//     return res.status(500).json({ success: false, message: "Failed to fetch food owners." });
//   }
// }

// Add this at the top of the file to test
let requestCount = 0;

async function listFoodOwners(req, res) {
  const startTime = Date.now();
  requestCount++;
  const requestNumber = requestCount;

  try {
    const { q, limit, offset } = parseOwnersQuery(req);

    // Generate unique cache key
    const cacheKey = `food_owners:q:${q || "none"}:limit:${limit}:offset:${offset}`;

    console.log(`\n📊 Request #${requestNumber} - ${new Date().toISOString()}`);
    console.log(`🔍 Cache Key: ${cacheKey}`);

    // 🔍 TRY TO GET FROM CACHE FIRST
    const cachedData = await cache.get(cacheKey);

    if (cachedData) {
      const responseTime = Date.now() - startTime;
      console.log(`✅ CACHE HIT! Response time: ${responseTime}ms 🚀`);

      return res.status(200).json({
        success: true,
        kind: "food",
        count: cachedData.count,
        data: cachedData.data,
        fromCache: true,
        responseTimeMs: responseTime,
        requestNumber: requestNumber,
      });
    }

    console.log(`❌ CACHE MISS! Fetching from database...`);
    const dbStartTime = Date.now();

    // 📊 FETCH FROM DATABASE
    const whereCondition = {};
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "food", ...whereCondition },
      include: {
        users: {
          select: {
            user_name: true,
            profile_image: true,
          },
        },
        merchant_business_types: {
          include: { business_types: { select: { id: true, name: true } } },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const businessIds = businesses.map((b) => b.business_id);
    const ratings = await prisma.food_ratings.groupBy({
      by: ["business_id"],
      where: { business_id: { in: businessIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingsMap = new Map();
    for (const rating of ratings) {
      ratingsMap.set(rating.business_id, {
        avg_rating: rating._avg.rating || 0,
        total_comments: rating._count.rating || 0,
      });
    }

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      owner_type: b.owner_type,
      business_name: b.business_name,
      latitude: b.latitude,
      longitude: b.longitude,
      address: b.address,
      business_logo: b.business_logo,
      delivery_option: b.delivery_option,
      min_amount_for_fd: b.min_amount_for_fd,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      opening_time: b.opening_time,
      closing_time: b.closing_time,
      holidays: b.holidays,
      complement: b.complementary,
      complement_details: b.complementary_details,
      created_at: b.created_at,
      updated_at: b.updated_at,
      user: {
        user_name: b.users.user_name,
        profile_image: b.users.profile_image || null,
      },
      business_types: b.merchant_business_types.map((mbt) => ({
        business_type_id: Number(mbt.business_types.id),
        name: mbt.business_types.name,
      })),
      avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
      total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
    }));

    const dbTime = Date.now() - dbStartTime;
    console.log(`📊 Database query took: ${dbTime}ms`);

    // 💾 STORE IN CACHE (5 minutes TTL)
    const responseData = {
      count: data.length,
      data: data,
    };

    await cache.set(cacheKey, responseData, 300);

    const totalTime = Date.now() - startTime;
    console.log(`💾 Cached for next request. Total time: ${totalTime}ms`);

    return res.status(200).json({
      success: true,
      kind: "food",
      count: data.length,
      data: data,
      fromCache: false,
      dbTimeMs: dbTime,
      totalTimeMs: totalTime,
      requestNumber: requestNumber,
    });
  } catch (err) {
    console.error("listFoodOwners error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch food owners.",
      error: err.message,
    });
  }
}
async function listMartOwners(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {};
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "mart", ...whereCondition },
      include: {
        users: {
          select: {
            user_name: true,
            profile_image: true,
          },
        },
        merchant_business_types: {
          include: { business_types: { select: { id: true, name: true } } },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const businessIds = businesses.map((b) => b.business_id);
    const ratings = await prisma.mart_ratings.groupBy({
      by: ["business_id"],
      where: { business_id: { in: businessIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    const ratingsMap = new Map();
    for (const rating of ratings) {
      ratingsMap.set(rating.business_id, {
        avg_rating: rating._avg.rating || 0,
        total_comments: rating._count.rating || 0,
      });
    }

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      owner_type: b.owner_type,
      business_name: b.business_name,
      latitude: b.latitude,
      longitude: b.longitude,
      address: b.address,
      business_logo: b.business_logo,
      delivery_option: b.delivery_option,
      min_amount_for_fd: b.min_amount_for_fd,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      opening_time: b.opening_time,
      closing_time: b.closing_time,
      holidays: b.holidays,
      complement: b.complementary,
      complement_details: b.complementary_details,
      created_at: b.created_at,
      updated_at: b.updated_at,
      user: {
        user_name: b.users.user_name,
        profile_image: b.users.profile_image || null,
      },
      business_types: b.merchant_business_types.map((mbt) => ({
        business_type_id: Number(mbt.business_types.id),
        name: mbt.business_types.name,
      })),
      avg_rating: ratingsMap.get(b.business_id)?.avg_rating || 0,
      total_comments: ratingsMap.get(b.business_id)?.total_comments || 0,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "mart", count: data.length, data });
  } catch (err) {
    console.error("listMartOwners error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch mart owners." });
  }
}

async function listFoodOwnersWithCelebration(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {
      special_celebration_discount_percentage: { not: null },
    };
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "food", ...whereCondition },
      include: {
        users: { select: { user_name: true } },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      business_name: b.business_name,
      business_logo: b.business_logo,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      address: b.address,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "food", count: data.length, data });
  } catch (err) {
    console.error("listFoodOwnersWithCelebration error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch food owners." });
  }
}

async function listMartOwnersWithCelebration(req, res) {
  try {
    const { q, limit, offset } = parseOwnersQuery(req);
    const whereCondition = {
      special_celebration_discount_percentage: { not: null },
    };
    if (q) {
      whereCondition.OR = [
        { business_name: { contains: q, mode: "insensitive" } },
        { users: { user_name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const businesses = await prisma.merchant_business_details.findMany({
      where: { owner_type: "mart", ...whereCondition },
      include: {
        users: { select: { user_name: true } },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    });

    const data = businesses.map((b) => ({
      business_id: Number(b.business_id),
      business_name: b.business_name,
      business_logo: b.business_logo,
      special_celebration: b.special_celebration,
      special_celebration_discount_percentage:
        b.special_celebration_discount_percentage,
      address: b.address,
    }));

    return res
      .status(200)
      .json({ success: true, kind: "mart", count: data.length, data });
  } catch (err) {
    console.error("listMartOwnersWithCelebration error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch mart owners." });
  }
}

module.exports = {
  registerMerchant,
  updateMerchant,
  loginByEmail,
  listFoodOwners,
  listMartOwners,
  listFoodOwnersWithCelebration,
  listMartOwnersWithCelebration,
};
