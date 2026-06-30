const { prisma } = require("../lib/prisma.js");

/* =======================================================
   CREATE MESSAGE
======================================================= */
async function createMessage(data) {
  const result = await prisma.contact_messages.create({
    data: {
      full_name: data.full_name,
      contact_type: data.contact_type,
      contact_value: data.contact_value,
      user_type: data.user_type || null,
      message: data.message,
      status: "new", // default status
      created_at: new Date(),
    },
  });

  return {
    id: Number(result.id),
  };
}

/* =======================================================
   GET ALL MESSAGES (WITH FILTERS)
======================================================= */
async function getAllMessages(filters = {}) {
  const where = {};

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.user_type) {
    where.user_type = filters.user_type;
  }

  const rows = await prisma.contact_messages.findMany({
    where,
    orderBy: {
      created_at: "desc",
    },
  });

  // Convert BigInt to Number
  return rows.map((row) => ({
    ...row,
    id: Number(row.id),
  }));
}

/* =======================================================
   GET MESSAGE BY ID
======================================================= */
async function getMessageById(id) {
  const result = await prisma.contact_messages.findUnique({
    where: { id: Number(id) },
  });

  if (!result) return null;

  return {
    ...result,
    id: Number(result.id),
  };
}

/* =======================================================
   UPDATE STATUS
======================================================= */
async function updateMessageStatus(id, status) {
  const result = await prisma.contact_messages.update({
    where: { id: Number(id) },
    data: {
      status: status,
      updated_at: new Date(),
    },
  });

  return result ? 1 : 0;
}

/* =======================================================
   DELETE MESSAGE
======================================================= */
async function deleteMessage(id) {
  try {
    const result = await prisma.contact_messages.delete({
      where: { id: Number(id) },
    });
    return 1;
  } catch (error) {
    // If record doesn't exist, return 0
    if (error.code === "P2025") {
      return 0;
    }
    throw error;
  }
}

module.exports = {
  createMessage,
  getAllMessages,
  getMessageById,
  updateMessageStatus,
  deleteMessage,
};
