const { prisma } = require("../lib/prisma");
const bcrypt = require("bcryptjs");

/* ------------------------ helpers ------------------------ */

function toIdArray(input) {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : String(input).split(",");
  const out = [];
  for (const p of parts) {
    const n = Number(String(p).trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

async function mapTypeNamesToIds(names) {
  if (!names || !names.length) return [];
  const trimmed = names.map((x) => String(x).trim()).filter(Boolean);
  if (!trimmed.length) return [];

  const allBusinessTypes = await prisma.business_types.findMany();
  const matched = allBusinessTypes.filter((bt) =>
    trimmed.some((name) => bt.name?.toLowerCase() === name.toLowerCase()),
  );
  return matched.map((bt) => bt.id);
}

async function filterValidTypeIds(typeIds) {
  if (!typeIds.length) return [];
  const numericIds = typeIds.map((id) => Number(id));
  const validTypes = await prisma.business_types.findMany({
    where: { id: { in: numericIds } },
    select: { id: true },
  });
  const validSet = new Set(validTypes.map((t) => Number(t.id)));
  return numericIds.filter((id) => validSet.has(id));
}

async function checkScopedUsernameExists(user_name, role, ownerType) {
  const allUsers = await prisma.users.findMany({
    where: { user_name: user_name, role: role },
    include: { merchant_business_details: true },
  });
  const matchingUsers = allUsers.filter(
    (user) => user.user_name?.toLowerCase() === user_name.toLowerCase(),
  );
  return matchingUsers.some((user) =>
    user.merchant_business_details?.some(
      (business) =>
        business.owner_type?.toLowerCase() === ownerType.toLowerCase(),
    ),
  );
}

/* ------------------------ create/register with TRANSACTION ------------------------ */

async function registerMerchantModel(data) {
  // Validate all inputs first (before transaction)
  const {
    user_name,
    email,
    phone,
    cid,
    password,
    business_name,
    business_type_ids,
    business_types,
    business_license_number,
    license_image,
    latitude,
    longitude,
    address,
    business_logo,
    delivery_option,
    owner_type,
    min_amount_for_fd,
    bank_name,
    account_holder_name,
    account_number,
    bank_qr_code_image,
    special_celebration,
    special_celebration_discount_percentage,
  } = data;

  const role = (data.role || "merchant").toLowerCase();
  const ownerType = String(owner_type || "").toLowerCase();
  const cidStr = cid == null ? "" : String(cid).trim();

  // Validation - all required fields
  if (!user_name) throw new Error("user_name is required");
  if (!email) throw new Error("email is required");
  if (!phone) throw new Error("phone is required");
  if (!cidStr) throw new Error("cid is required for merchants");
  if (cidStr.length !== 11)
    throw new Error("cid must be exactly 11 characters long");
  if (!password) throw new Error("password is required");
  if (!business_name) throw new Error("business_name is required");
  if (!ownerType) throw new Error("owner_type is required");
  if (!bank_name) throw new Error("bank_name is required");
  if (!account_holder_name) throw new Error("account_holder_name is required");
  if (!account_number) throw new Error("account_number is required");

  // Business type resolution
  let incomingIds = toIdArray(business_type_ids);
  if (
    !incomingIds.length &&
    Array.isArray(business_types) &&
    business_types.length
  ) {
    const mapped = await mapTypeNamesToIds(business_types);
    incomingIds = toIdArray(mapped);
  }
  if (!incomingIds.length) {
    throw new Error("At least one business type is required.");
  }

  // Validate all business type IDs exist
  const validTypeIds = await filterValidTypeIds(incomingIds);
  if (validTypeIds.length !== incomingIds.length) {
    const invalidIds = incomingIds.filter(
      (id) => !validTypeIds.includes(Number(id)),
    );
    throw new Error(
      `Invalid business_type_ids: ${invalidIds.join(", ")}. These IDs do not exist.`,
    );
  }

  // Check for existing email, phone, username before transaction
  const existingEmail = await prisma.users.findFirst({
    where: { email: email },
  });
  if (existingEmail)
    throw new Error("Email already exists. Please use another email.");

  const existingPhone = await prisma.users.findFirst({
    where: { phone: phone },
  });
  if (existingPhone)
    throw new Error("Phone number already exists. Please use another phone.");

  const usernameExists = await checkScopedUsernameExists(
    user_name,
    role,
    ownerType,
  );
  if (usernameExists) {
    throw new Error(
      "Username already exists for this owner type. Choose another username or change owner_type.",
    );
  }

  // Start transaction for actual database writes
  return await prisma.$transaction(async (tx) => {
    // Create user
    const password_hash = await bcrypt.hash(password, 10);
    const newUser = await tx.users.create({
      data: {
        user_name: user_name,
        email: email,
        phone: phone,
        cid: cidStr,
        password_hash: password_hash,
        role: role,
        is_active: true,
      },
    });
    const user_id = newUser.user_id;

    const minFD =
      min_amount_for_fd !== undefined &&
      min_amount_for_fd !== null &&
      min_amount_for_fd !== ""
        ? Number(min_amount_for_fd)
        : 0;

    // Create business
    const newBusiness = await tx.merchant_business_details.create({
      data: {
        user_id: user_id,
        business_name: business_name,
        business_license_number: business_license_number || null,
        license_image: license_image || null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        address: address || null,
        business_logo: business_logo || null,
        delivery_option: delivery_option || "SELF",
        owner_type: ownerType || null,
        min_amount_for_fd: minFD,
        special_celebration: special_celebration || null,
        special_celebration_discount_percentage:
          special_celebration_discount_percentage || null,
      },
    });
    const business_id = newBusiness.business_id;

    // Add business types
    for (const typeId of validTypeIds) {
      await tx.merchant_business_types.create({
        data: { business_id: business_id, business_type_id: typeId },
      });
    }

    // Create bank details
    await tx.merchant_bank_details.create({
      data: {
        user_id: user_id,
        bank_name: bank_name,
        account_holder_name: account_holder_name,
        account_number: account_number,
        bank_qr_code_image: bank_qr_code_image || null,
      },
    });

    return {
      user_id: Number(user_id),
      business_id: Number(business_id),
      business_type_ids: validTypeIds.map((id) => Number(id)),
    };
  });
}

/* ------------------------ UPDATE: business details ------------------------ */

async function updateMerchantDetailsModel(business_id, data) {
  return await prisma.$transaction(async (tx) => {
    const existingBusiness = await tx.merchant_business_details.findUnique({
      where: { business_id: business_id },
    });
    if (!existingBusiness) throw new Error("Business not found");

    const updateData = {};

    const setIfProvided = (col, val, transform = (v) => v) => {
      if (val !== undefined) updateData[col] = transform(val);
    };

    // Helper for time strings
    const toDateTime = (timeStr) => {
      if (!timeStr) return null;
      const [hours, minutes, seconds = "00"] = timeStr.split(":");
      const date = new Date();
      date.setHours(parseInt(hours, 10));
      date.setMinutes(parseInt(minutes, 10));
      date.setSeconds(parseInt(seconds, 10));
      date.setMilliseconds(0);
      return date;
    };

    setIfProvided("business_name", data.business_name);
    setIfProvided("business_license_number", data.business_license_number);
    setIfProvided("license_image", data.license_image);
    setIfProvided("latitude", data.latitude, (v) =>
      v === "" || v === null ? null : Number(v),
    );
    setIfProvided("longitude", data.longitude, (v) =>
      v === "" || v === null ? null : Number(v),
    );
    setIfProvided("address", data.address);
    setIfProvided("business_logo", data.business_logo);
    setIfProvided("delivery_option", data.delivery_option);
    setIfProvided("owner_type", data.owner_type, (v) =>
      v ? String(v).toLowerCase() : undefined,
    );
    setIfProvided("opening_time", data.opening_time, toDateTime);
    setIfProvided("closing_time", data.closing_time, toDateTime);
    setIfProvided(
      "kitchen_closing_time",
      data.kitchen_closing_time,
      toDateTime,
    );
    setIfProvided("special_celebration", data.special_celebration);
    setIfProvided(
      "special_celebration_discount_percentage",
      data.special_celebration_discount_percentage,
    );
    setIfProvided("min_amount_for_fd", data.min_amount_for_fd, (v) => {
      if (v === "" || v == null) return 0;
      return Number(v);
    });

    // Handle holidays
    if (data.holidays !== undefined) {
      let arr = [];
      if (Array.isArray(data.holidays)) {
        arr = data.holidays;
      } else if (typeof data.holidays === "string") {
        arr = data.holidays
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      updateData.holidays = JSON.stringify(arr);
    }

    if (Object.keys(updateData).length > 0) {
      updateData.updated_at = new Date();
      await tx.merchant_business_details.update({
        where: { business_id: business_id },
        data: updateData,
      });
    }

    // Update business type associations
    let incomingIds = toIdArray(data.business_type_ids);
    if (
      !incomingIds.length &&
      Array.isArray(data.business_types) &&
      data.business_types.length
    ) {
      const mapped = await mapTypeNamesToIds(data.business_types);
      incomingIds = toIdArray(mapped);
    }

    if (
      data.business_type_ids !== undefined ||
      data.business_types !== undefined
    ) {
      const validIds = await filterValidTypeIds(incomingIds);
      if (validIds.length !== incomingIds.length && incomingIds.length > 0) {
        const invalidIds = incomingIds.filter(
          (id) => !validIds.includes(Number(id)),
        );
        throw new Error(
          `Invalid business_type_ids: ${invalidIds.join(", ")}. These IDs do not exist.`,
        );
      }

      await tx.merchant_business_types.deleteMany({
        where: { business_id: business_id },
      });
      for (const typeId of validIds) {
        await tx.merchant_business_types.create({
          data: { business_id: business_id, business_type_id: typeId },
        });
      }
    }

    return { business_id: Number(business_id) };
  });
}

/* ------------------------ FINDERS ------------------------ */

async function findCandidatesByEmail(email) {
  const em = String(email || "").trim();
  if (!em) return [];

  const allUsers = await prisma.users.findMany({
    orderBy: { user_id: "desc" },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      phone: true,
      role: true,
      password_hash: true,
      is_active: true,
    },
  });

  return allUsers.filter(
    (user) => user.email?.toLowerCase() === em.toLowerCase(),
  );
}

module.exports = {
  registerMerchantModel,
  updateMerchantDetailsModel,
  findCandidatesByEmail,
};
