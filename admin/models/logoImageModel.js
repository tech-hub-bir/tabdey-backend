const { prisma } = require("../lib/prisma.js");

/* ---------------- helpers ---------------- */

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPrismaUniqueError(error) {
  return error && error.code === "P2002";
}

function normalizeActorUserId(actorUserId) {
  const n = Number(actorUserId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeAdminName(adminName) {
  const clean = normalizeText(adminName);
  return clean || "System";
}

async function logAdmin(actorUserId, adminName, activity) {
  try {
    const cleanUserId = normalizeActorUserId(actorUserId);
    const cleanAdminName = normalizeAdminName(adminName);

    console.log("[ADMIN LOG INSERT]", {
      user_id: cleanUserId,
      admin_name: cleanAdminName,
      activity,
    });

    await prisma.admin_logs.create({
      data: {
        user_id: cleanUserId,
        admin_name: cleanAdminName,
        activity,
        created_at: new Date(),
      },
    });
  } catch (error) {
    console.error("Error logging admin action:", error);
  }
}

/* ---------------- model ---------------- */

const LogoImageModel = {
  async findByName(name) {
    try {
      const cleanName = normalizeText(name);

      if (!cleanName) return null;

      return await prisma.image_and_icons.findFirst({
        where: {
          name: cleanName,
        },
      });
    } catch (error) {
      console.error("Find logo/image by name error:", error);
      throw error;
    }
  },

  async findDuplicateName(name, excludeId = null) {
    try {
      const cleanName = normalizeText(name);

      if (!cleanName) return null;

      const where = {
        name: cleanName,
      };

      const parsedExcludeId = parseInt(excludeId, 10);

      if (Number.isInteger(parsedExcludeId)) {
        where.id = {
          not: parsedExcludeId,
        };
      }

      return await prisma.image_and_icons.findFirst({
        where,
      });
    } catch (error) {
      console.error("Find duplicate logo/image name error:", error);
      throw error;
    }
  },

  async create(data, actorUserId = null, adminName = null) {
    try {
      const cleanName = normalizeText(data.name);
      const cleanServiceType = normalizeText(data.service_type);
      const cleanImageUrl = normalizeText(data.image_url);

      if (!cleanName) {
        return {
          validation: true,
          message: "Name is required",
        };
      }

      if (!cleanServiceType) {
        return {
          validation: true,
          message: "Service type is required",
        };
      }

      if (!cleanImageUrl) {
        return {
          validation: true,
          message: "Image URL is required",
        };
      }

      const existingName = await this.findByName(cleanName);

      if (existingName) {
        return {
          duplicate: true,
          message: "Logo/Image name already exists",
        };
      }

      const newItem = await prisma.image_and_icons.create({
        data: {
          name: cleanName,
          image_url: cleanImageUrl,
          service_type: cleanServiceType,
        },
      });

      await logAdmin(
        actorUserId,
        adminName,
        `Created logo/image "${newItem.name}" for service "${newItem.service_type}" (id: ${newItem.id})`
      );

      return {
        success: true,
        data: newItem,
      };
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return {
          duplicate: true,
          message: "Logo/Image name already exists",
        };
      }

      console.error("Create logo/image error:", error);
      throw error;
    }
  },

  async findAll({ page = 1, limit = 10, search = "", service_type = "" }) {
    try {
      const currentPage = Math.max(parseInt(page, 10) || 1, 1);
      const pageLimit = Math.max(parseInt(limit, 10) || 10, 1);
      const skip = (currentPage - 1) * pageLimit;

      const cleanSearch = normalizeText(search);
      const cleanServiceType = normalizeText(service_type);

      const where = {};

      if (cleanSearch) {
        where.name = {
          contains: cleanSearch,
        };
      }

      if (cleanServiceType) {
        where.service_type = cleanServiceType;
      }

      const [items, total] = await Promise.all([
        prisma.image_and_icons.findMany({
          where,
          skip,
          take: pageLimit,
          orderBy: {
            created_at: "desc",
          },
        }),
        prisma.image_and_icons.count({
          where,
        }),
      ]);

      return {
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          image_url: item.image_url,
          service_type: item.service_type,
          created_at: item.created_at,
          updated_at: item.updated_at,
        })),
        total,
        page: currentPage,
        limit: pageLimit,
        totalPages: Math.ceil(total / pageLimit),
      };
    } catch (error) {
      console.error("Find all logos/images error:", error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const itemId = parseInt(id, 10);

      if (!Number.isInteger(itemId)) return null;

      const item = await prisma.image_and_icons.findUnique({
        where: {
          id: itemId,
        },
      });

      if (!item) return null;

      return {
        id: item.id,
        name: item.name,
        image_url: item.image_url,
        service_type: item.service_type,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    } catch (error) {
      console.error("Find logo/image by ID error:", error);
      throw error;
    }
  },

  async update(id, data, actorUserId = null, adminName = null) {
    try {
      const itemId = parseInt(id, 10);

      if (!Number.isInteger(itemId)) {
        return {
          notFound: true,
        };
      }

      const existingItem = await prisma.image_and_icons.findUnique({
        where: {
          id: itemId,
        },
      });

      if (!existingItem) {
        return {
          notFound: true,
        };
      }

      const updateData = {
        updated_at: new Date(),
      };

      if (data.name) {
        const cleanName = normalizeText(data.name);

        const duplicateName = await this.findDuplicateName(cleanName, itemId);

        if (duplicateName) {
          return {
            duplicate: true,
            message: "Logo/Image name already exists",
          };
        }

        updateData.name = cleanName;
      }

      if (data.image_url) {
        updateData.image_url = normalizeText(data.image_url);
      }

      if (data.service_type) {
        updateData.service_type = normalizeText(data.service_type);
      }

      const updatedItem = await prisma.image_and_icons.update({
        where: {
          id: itemId,
        },
        data: updateData,
      });

      await logAdmin(
        actorUserId,
        adminName,
        `Updated logo/image "${updatedItem.name}" for service "${updatedItem.service_type}" (id: ${updatedItem.id})`
      );

      return {
        success: true,
        data: updatedItem,
      };
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return {
          duplicate: true,
          message: "Logo/Image name already exists",
        };
      }

      console.error("Update logo/image error:", error);
      throw error;
    }
  },

  async delete(id, actorUserId = null, adminName = null) {
    try {
      const itemId = parseInt(id, 10);

      if (!Number.isInteger(itemId)) {
        return {
          notFound: true,
        };
      }

      const existingItem = await prisma.image_and_icons.findUnique({
        where: {
          id: itemId,
        },
      });

      if (!existingItem) {
        return {
          notFound: true,
        };
      }

      await prisma.image_and_icons.delete({
        where: {
          id: itemId,
        },
      });

      await logAdmin(
        actorUserId,
        adminName,
        `Deleted logo/image "${existingItem.name}" for service "${existingItem.service_type}" (id: ${existingItem.id})`
      );

      return {
        deleted: true,
        data: existingItem,
      };
    } catch (error) {
      console.error("Delete logo/image error:", error);
      throw error;
    }
  },

  async bulkDelete(ids, actorUserId = null, adminName = null) {
    try {
      const parsedIds = (ids || [])
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id));

      if (parsedIds.length === 0) {
        return {
          count: 0,
          items: [],
        };
      }

      const items = await prisma.image_and_icons.findMany({
        where: {
          id: {
            in: parsedIds,
          },
        },
      });

      const result = await prisma.image_and_icons.deleteMany({
        where: {
          id: {
            in: parsedIds,
          },
        },
      });

      await logAdmin(
        actorUserId,
        adminName,
        `Bulk deleted ${result.count} logo(s)/image(s)`
      );

      return {
        count: result.count,
        items,
      };
    } catch (error) {
      console.error("Bulk delete logo/image error:", error);
      throw error;
    }
  },
};

module.exports = LogoImageModel;