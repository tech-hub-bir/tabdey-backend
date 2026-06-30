// One-off script: deletes the throwaway accounts created by the k6 load
// tests (load-test/k6-register-test.js uses phone prefix +97501,
// load-test/k6-login-test.js uses +97502). Run from inside driver/ so it
// picks up driver/.env via dotenv.
//
// Usage:
//   node cleanup-load-test-users.js

const dotenv = require("dotenv");
dotenv.config();

const { prisma } = require("./lib/prisma.js");

const LOAD_TEST_PHONE_PREFIXES = ["+97501", "+97502"];

async function cleanup() {
  for (const prefix of LOAD_TEST_PHONE_PREFIXES) {
    const users = await prisma.users.findMany({
      where: { phone: { startsWith: prefix } },
      select: { user_id: true },
    });
    const userIds = users.map((u) => u.user_id);

    if (userIds.length === 0) {
      console.log(`No users found with phone prefix ${prefix}.`);
      continue;
    }

    const deletedDevices = await prisma.user_devices.deleteMany({
      where: { user_id: { in: userIds } },
    });
    const deletedUsers = await prisma.users.deleteMany({
      where: { user_id: { in: userIds } },
    });

    console.log(
      `Prefix ${prefix}: deleted ${deletedUsers.count} users and ${deletedDevices.count} device rows.`,
    );
  }
}

cleanup()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
