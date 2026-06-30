// Login capacity test — fully API-driven, no direct DB access.
//
// setup() seeds throwaway customer accounts via real POST /api/register
// calls (batched for speed), then the load phase ramps to ~1000 concurrent
// virtual users hammering POST /api/login with those accounts.
//
// Run (rate limiter on the target server must be raised first — see runbook):
//   BASE_URL=http://staging-host:3000 k6 run load-test/k6-login-test.js
//
// Tune with env vars: VUS (default 1000), DURATION (default 2m),
// SEED_COUNT (default = VUS).
//
// Cleanup after the run: delete users with phone LIKE '+97502%' (and their
// user_devices rows) — see driver/cleanup-load-test-users.js.

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const VUS = Number(__ENV.VUS || 1000);
const DURATION = __ENV.DURATION || "2m";
const SEED_COUNT = Number(__ENV.SEED_COUNT || VUS);
const SEED_BATCH_SIZE = 50;

const PASSWORD = "LoadTest!2026";
const PHONE_PREFIX = "+97502"; // distinct from k6-register-test.js's +97501

export const options = {
  scenarios: {
    login_storm: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: DURATION, target: VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
  },
};

// Runs once, before any VU starts, in its own (non-distributed) context.
// Seeds SEED_COUNT accounts via the real registration endpoint, batching
// requests for speed, and returns the credentials to every VU.
export function setup() {
  const runId = Date.now().toString().slice(-6);
  const accounts = [];

  for (let start = 0; start < SEED_COUNT; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE, SEED_COUNT);
    const requests = [];
    const meta = [];

    for (let i = start; i < end; i++) {
      const uid = `${runId}${i}`;
      // Full runId/index digits preserved (no truncation) so every seeded
      // account gets a distinct phone number. phone column is VARCHAR(20);
      // 6 (prefix) + 6 (runId) + 4 (index) = 16 chars.
      const phone = `${PHONE_PREFIX}${runId}${String(i).padStart(4, "0")}`;
      const email = `loginseed${uid}@example.test`;
      const deviceId = `loginseed-device-${uid}`;

      requests.push([
        "POST",
        `${BASE_URL}/api/register`,
        JSON.stringify({
          user: {
            user_name: `Login Seed ${uid}`,
            email,
            phone,
            password: PASSWORD,
            role: "customer",
          },
          deviceID: deviceId,
        }),
        { headers: { "Content-Type": "application/json" } },
      ]);
      meta.push({ phone, password: PASSWORD, device_id: deviceId });
    }

    const responses = http.batch(requests);
    responses.forEach((res, idx) => {
      if (res.status === 201) accounts.push(meta[idx]);
    });

    console.log(`Seeded ${accounts.length}/${SEED_COUNT} accounts so far...`);
  }

  if (accounts.length === 0) {
    throw new Error(
      "Seeding failed - no accounts were created. Check BASE_URL and that REGISTER_RATE_LIMIT_MAX is raised on the target server.",
    );
  }

  return { accounts };
}

export default function (data) {
  const account =
    data.accounts[Math.floor(Math.random() * data.accounts.length)];

  const res = http.post(
    `${BASE_URL}/api/login`,
    JSON.stringify({
      phone: account.phone,
      password: account.password,
      device_id: account.device_id,
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
    "not rate limited": (r) => r.status !== 429,
  });

  sleep(1);
}

export function teardown(data) {
  console.log(
    `Test complete. ${data.accounts.length} seeded accounts remain in the DB ` +
      `(phone prefix ${PHONE_PREFIX}) — run driver/cleanup-load-test-users.js to remove them.`,
  );
}
