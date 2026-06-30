const { prisma } = require("../lib/prisma");

/* ---------------- helpers ---------------- */

function toIdArray(input) {
  if (input == null) return [];

  let parts = [];

  if (Array.isArray(input)) {
    parts = input;
  } else {
    const s = String(input).trim();

    if (!s) return [];

    // Supports JSON string: "[1,2,3]"
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        parts = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        parts = s.split(",");
      }
    } else {
      // Supports comma string: "1,2,3"
      parts = s.split(",");
    }
  }

  const out = [];

  for (const p of parts) {
    const n = Number(String(p).trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) {
      out.push(n);
    }
  }

  return out;
}

async function mapTypeNamesToIds(names, client = prisma) {
  if (!names || !names.length) return [];

  const trimmed = names.map((x) => String(x).trim()).filter(Boolean);
  if (!trimmed.length) return [];

  const allBusinessTypes = await client.business_types.findMany();

  const matched = allBusinessTypes.filter((bt) =>
    trimmed.some((name) => bt.name?.toLowerCase() === name.toLowerCase())
  );

  return matched.map((bt) => Number(bt.id));
}

async function filterValidTypeIds(typeIds, client = prisma) {
  if (!typeIds.length) return [];

  const numericIds = typeIds.map((id) => Number(id));

  const validTypes = await client.business_types.findMany({
    where: {
      id: {
        in: numericIds,
      },
    },
    select: {
      id: true,
    },
  });

  const validSet = new Set(validTypes.map((t) => Number(t.id)));

  return numericIds.filter((id) => validSet.has(id));
}

/* ---------------- UPDATE business details ---------------- */

async function updateMerchantBusinessDetails(business_id, updateFields) {
  const allowedFields = [
    "business_name",
    "latitude",
    "longitude",
    "address",
    "business_logo",
    "license_image",
    "delivery_option",
    "complementary",
    "complementary_details",
    "opening_time",
    "closing_time",
    "kitchen_closing_time",
    "holidays",
    "special_celebration",
    "special_celebration_discount_percentage",
    "min_amount_for_fd",
  ];

  const updateData = {};

  for (const field of allowedFields) {
    if (updateFields[field] !== undefined) {
      if (field === "holidays" && Array.isArray(updateFields[field])) {
        updateData[field] = JSON.stringify(updateFields[field]);
      } else if (field === "latitude" || field === "longitude") {
        updateData[field] =
          updateFields[field] === "" || updateFields[field] === null
            ? null
            : Number(updateFields[field]);
      } else if (field === "min_amount_for_fd") {
        const raw = String(updateFields[field] ?? "").trim();
        updateData[field] = raw === "" ? null : Number(raw);
      } else {
        updateData[field] = updateFields[field];
      }
    }
  }

  const hasBusinessTypeUpdate =
    updateFields.business_type_ids !== undefined ||
    updateFields.business_types !== undefined;

  if (Object.keys(updateData).length === 0 && !hasBusinessTypeUpdate) {
    return false;
  }

  return await prisma.$transaction(async (tx) => {
    const existingBusiness = await tx.merchant_business_details.findUnique({
      where: {
        business_id: business_id,
      },
      select: {
        business_id: true,
      },
    });

    if (!existingBusiness) {
      throw new Error("Merchant business not found.");
    }

    if (Object.keys(updateData).length > 0 || hasBusinessTypeUpdate) {
      updateData.updated_at = new Date();

      await tx.merchant_business_details.update({
        where: {
          business_id: business_id,
        },
        data: updateData,
      });
    }

    if (hasBusinessTypeUpdate) {
      let incomingIds = toIdArray(updateFields.business_type_ids);

      if (!incomingIds.length && updateFields.business_types !== undefined) {
        const names = Array.isArray(updateFields.business_types)
          ? updateFields.business_types
          : String(updateFields.business_types)
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);

        const mapped = await mapTypeNamesToIds(names, tx);
        incomingIds = toIdArray(mapped);
      }

      // Empty business_type_ids means do not add anything.
      // It will NOT remove existing business types.
      if (!incomingIds.length) {
        return true;
      }

      const validTypeIds = await filterValidTypeIds(incomingIds, tx);

      if (validTypeIds.length !== incomingIds.length) {
        const invalidIds = incomingIds.filter(
          (id) => !validTypeIds.includes(Number(id))
        );

        throw new Error(
          `Invalid business_type_ids: ${invalidIds.join(
            ", "
          )}. These IDs do not exist.`
        );
      }

      const existingTypes = await tx.merchant_business_types.findMany({
        where: {
          business_id: business_id,
        },
        select: {
          business_type_id: true,
        },
      });

      const existingTypeIds = existingTypes.map((item) =>
        Number(item.business_type_id)
      );

      const newTypeIds = validTypeIds.filter(
        (typeId) => !existingTypeIds.includes(Number(typeId))
      );

      for (const typeId of newTypeIds) {
        await tx.merchant_business_types.create({
          data: {
            business_id: business_id,
            business_type_id: typeId,
          },
        });
      }
    }

    return true;
  });
}

/* ---------------- GET business details ---------------- */

async function getMerchantBusinessDetailsById(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: {
      business_id: business_id,
    },
    include: {
      users: {
        select: {
          user_id: true,
          user_name: true,
          email: true,
          phone: true,
        },
      },
      merchant_business_types: {
        include: {
          business_types: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!business) return null;

  const businessTypes = business.merchant_business_types.map((mbt) => ({
    business_type_id: Number(mbt.business_types.id),
    name: mbt.business_types.name,
  }));

  return {
    business_id: Number(business.business_id),
    user_id: Number(business.user_id),
    business_name: business.business_name,
    business_license_number: business.business_license_number,
    license_image: business.license_image,
    latitude: business.latitude,
    longitude: business.longitude,
    address: business.address,
    business_logo: business.business_logo,
    delivery_option: business.delivery_option,
    complementary: business.complementary,
    complementary_details: business.complementary_details,
    opening_time: business.opening_time,
    closing_time: business.closing_time,
    kitchen_closing_time: business.kitchen_closing_time,
    holidays: business.holidays,
    special_celebration: business.special_celebration,
    special_celebration_discount_percentage:
      business.special_celebration_discount_percentage,
    min_amount_for_fd: business.min_amount_for_fd,
    owner_type: business.owner_type,
    created_at: business.created_at,
    updated_at: business.updated_at,

    user: business.users
      ? {
          user_id: Number(business.users.user_id),
          user_name: business.users.user_name,
          email: business.users.email,
          phone: business.users.phone,
        }
      : null,

    business_type_ids: businessTypes.map((bt) => bt.business_type_id),
    business_types: businessTypes,
  };
}

/* ---------------- CLEAR special celebration ---------------- */

async function clearSpecialCelebrationByBusinessId(business_id) {
  await prisma.merchant_business_details.update({
    where: {
      business_id: business_id,
    },
    data: {
      special_celebration: null,
      special_celebration_discount_percentage: null,
      updated_at: new Date(),
    },
  });

  return true;
}

module.exports = {
  updateMerchantBusinessDetails,
  getMerchantBusinessDetailsById,
  clearSpecialCelebrationByBusinessId,
};