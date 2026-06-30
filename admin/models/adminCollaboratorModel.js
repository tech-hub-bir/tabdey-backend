const { prisma } = require("../lib/prisma.js");

function toDbRow(payload = {}) {
  const { full_name, contact, email, service, role, current_address, cid } =
    payload;
  return { full_name, contact, email, service, role, current_address, cid };
}

async function create(collab) {
  const row = toDbRow(collab);

  const result = await prisma.admin_collaborators.create({
    data: {
      full_name: row.full_name,
      contact: row.contact,
      email: row.email,
      service: row.service,
      role: row.role,
      current_address: row.current_address,
      cid: row.cid,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  // Convert BigInt to Number
  return {
    ...result,
    collaborator_id: Number(result.collaborator_id),
  };
}

async function findById(id) {
  const result = await prisma.admin_collaborators.findUnique({
    where: { collaborator_id: Number(id) },
  });

  if (!result) return null;

  return {
    ...result,
    collaborator_id: Number(result.collaborator_id),
  };
}

async function existsByEmailOrCid(email, cid, excludeId = null) {
  const where = {
    OR: [{ email: email }, { cid: cid }],
  };

  if (excludeId) {
    where.NOT = {
      collaborator_id: Number(excludeId),
    };
  }

  const result = await prisma.admin_collaborators.findFirst({
    where,
    select: { collaborator_id: true },
  });

  return !!result;
}

async function list() {
  const rows = await prisma.admin_collaborators.findMany({
    orderBy: {
      created_at: "desc",
    },
  });

  const data = rows.map((row) => ({
    ...row,
    collaborator_id: Number(row.collaborator_id),
  }));

  return { data, total: data.length };
}

async function updateById(id, changes) {
  const row = toDbRow(changes);

  // Build data object with only provided fields
  const data = {};
  Object.entries(row).forEach(([k, v]) => {
    if (v !== undefined) {
      data[k] = v;
    }
  });

  if (Object.keys(data).length === 0) {
    return findById(id);
  }

  // Add updated_at
  data.updated_at = new Date();

  const result = await prisma.admin_collaborators.update({
    where: { collaborator_id: Number(id) },
    data,
  });

  return {
    ...result,
    collaborator_id: Number(result.collaborator_id),
  };
}

async function removeById(id) {
  try {
    const result = await prisma.admin_collaborators.delete({
      where: { collaborator_id: Number(id) },
    });
    return true;
  } catch (error) {
    // If record doesn't exist, return false
    if (error.code === "P2025") {
      return false;
    }
    throw error;
  }
}

module.exports = {
  create,
  findById,
  list,
  updateById,
  removeById,
  existsByEmailOrCid,
};
