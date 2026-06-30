const { prisma } = require("../lib/prisma.js");

/**
 * Verify (user_id, admin_name) belongs to an admin/superadmin.
 * Uses users.user_name (your schema) and also accepts users.email.
 */
async function findPrivilegedByIdAndName(user_id, admin_name) {
  const roles = ["admin", "superadmin", "super admin", "super-admin"];

  const user = await prisma.users.findFirst({
    where: {
      user_id: Number(user_id),
      OR: [{ user_name: admin_name }, { email: admin_name }],
      role: {
        in: roles,
      },
    },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      role: true,
    },
  });

  if (!user) return null;

  return {
    user_id: Number(user.user_id),
    user_name: user.user_name,
    email: user.email,
    role: user.role,
  };
}

module.exports = { findPrivilegedByIdAndName };
