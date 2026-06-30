// src/db/seeders/seedRideTypes.js
// Run: node src/db/seeders/seedRideTypes.js
import "dotenv/config.js";
import { mysqlPool } from "../mysql.js";

const rideTypes = [
  // ── Economy ──────────────────────────────────────────────────────────────
  {
    name: "Go",
    code: "GO",
    description: "Affordable everyday rides. Suzuki Alto, S-Presso, Tata Tiago.",
    base_fare_cents: 3000,
    per_km_rate_cents: 800,
    min_fare_cents: 2000,
    cancellation_fee_cents: 1000,
    capacity: 4,
    vehicle_type: "Hatchback",
    is_active: 1,
  },
  {
    name: "Bike",
    code: "BIKE",
    description: "Quick solo rides on a motorbike. Honda CB Shine, Hero Splendor, TVS Apache.",
    base_fare_cents: 1500,
    per_km_rate_cents: 500,
    min_fare_cents: 1000,
    cancellation_fee_cents: 500,
    capacity: 1,
    vehicle_type: "Motorbike",
    is_active: 1,
  },

  // ── Standard ─────────────────────────────────────────────────────────────
  {
    name: "Standard",
    code: "STD",
    description: "Comfortable daily rides. Suzuki Swift, Dzire, Hyundai i10, Honda Amaze.",
    base_fare_cents: 4000,
    per_km_rate_cents: 1000,
    min_fare_cents: 2500,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "Hyundai",
    code: "HYUNDAI",
    description: "Hyundai-only fleet. Hyundai i20, Venue.",
    base_fare_cents: 4500,
    per_km_rate_cents: 1100,
    min_fare_cents: 3000,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "Suzuki",
    code: "SUZUKI",
    description: "Suzuki-only fleet. Baleno, Ciaz, Ertiga.",
    base_fare_cents: 4500,
    per_km_rate_cents: 1100,
    min_fare_cents: 3000,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "Honda",
    code: "HONDA",
    description: "Honda-only fleet. Honda City, WR-V, Jazz.",
    base_fare_cents: 4500,
    per_km_rate_cents: 1100,
    min_fare_cents: 3000,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "Tata",
    code: "TATA",
    description: "Tata-only fleet. Nexon, Altroz, Punch.",
    base_fare_cents: 4500,
    per_km_rate_cents: 1100,
    min_fare_cents: 3000,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Hatchback",
    is_active: 1,
  },

  // ── Premium / SUV ─────────────────────────────────────────────────────────
  {
    name: "Premium",
    code: "PREMIUM",
    description: "Premium crossover rides. Kia Seltos, Hyundai Creta, Honda HR-V.",
    base_fare_cents: 7000,
    per_km_rate_cents: 1500,
    min_fare_cents: 5000,
    cancellation_fee_cents: 2000,
    capacity: 4,
    vehicle_type: "Crossover",
    is_active: 1,
  },
  {
    name: "Kia",
    code: "KIA",
    description: "Kia-only fleet. Seltos, Sonet, Carnival.",
    base_fare_cents: 7500,
    per_km_rate_cents: 1600,
    min_fare_cents: 5500,
    cancellation_fee_cents: 2000,
    capacity: 4,
    vehicle_type: "Crossover",
    is_active: 1,
  },
  {
    name: "Toyota",
    code: "TOYOTA",
    description: "Toyota-only fleet. Corolla, Yaris, Raize.",
    base_fare_cents: 7500,
    per_km_rate_cents: 1600,
    min_fare_cents: 5500,
    cancellation_fee_cents: 2000,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "SUV",
    code: "SUV",
    description: "Large SUV for extra space. Hyundai Tucson, Kia Sportage, Toyota RAV4, Tata Harrier.",
    base_fare_cents: 10000,
    per_km_rate_cents: 2000,
    min_fare_cents: 7000,
    cancellation_fee_cents: 2500,
    capacity: 5,
    vehicle_type: "SUV",
    is_active: 1,
  },

  // ── Large / Group ─────────────────────────────────────────────────────────
  {
    name: "XL",
    code: "XL",
    description: "MPV for groups. Toyota Innova, Kia Carnival, Suzuki Ertiga 7-seat.",
    base_fare_cents: 9000,
    per_km_rate_cents: 1800,
    min_fare_cents: 6000,
    cancellation_fee_cents: 2500,
    capacity: 6,
    vehicle_type: "MPV",
    is_active: 1,
  },
  {
    name: "Fortuner",
    code: "FORTUNER",
    description: "Premium 4x4 experience. Toyota Fortuner, Toyota Hilux.",
    base_fare_cents: 12000,
    per_km_rate_cents: 2200,
    min_fare_cents: 8000,
    cancellation_fee_cents: 3000,
    capacity: 7,
    vehicle_type: "4x4",
    is_active: 1,
  },

  // ── Electric (EV) ─────────────────────────────────────────────────────────
  {
    name: "EV",
    code: "EV",
    description: "Eco-friendly electric rides. Tata Nexon EV, MG ZS EV, BYD Atto 3.",
    base_fare_cents: 5000,
    per_km_rate_cents: 1000,
    min_fare_cents: 3000,
    cancellation_fee_cents: 1500,
    capacity: 4,
    vehicle_type: "Electric",
    is_active: 1,
  },
  {
    name: "EV Premium",
    code: "EV_PREMIUM",
    description: "Premium electric vehicles. BYD Seal, Hyundai Ioniq 5, Kia EV6.",
    base_fare_cents: 9000,
    per_km_rate_cents: 1800,
    min_fare_cents: 6000,
    cancellation_fee_cents: 2500,
    capacity: 4,
    vehicle_type: "Electric",
    is_active: 1,
  },

  // ── Intercity / Special ───────────────────────────────────────────────────
  {
    name: "Intercity",
    code: "INTERCITY",
    description: "City-to-city travel across Bhutan. Toyota Corolla, Suzuki Ciaz, Hyundai Elantra.",
    base_fare_cents: 15000,
    per_km_rate_cents: 1200,
    min_fare_cents: 15000,
    cancellation_fee_cents: 5000,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
  {
    name: "Airport",
    code: "AIRPORT",
    description: "Reliable airport transfers. Standard vehicles and above.",
    base_fare_cents: 20000,
    per_km_rate_cents: 1400,
    min_fare_cents: 20000,
    cancellation_fee_cents: 5000,
    capacity: 4,
    vehicle_type: "Sedan",
    is_active: 1,
  },
];

async function seed() {
  const conn = await mysqlPool.getConnection();

  try {
    console.log("Seeding ride types...\n");

    let inserted = 0;
    let skipped = 0;

    for (const rt of rideTypes) {
      // Skip if code already exists
      const [existing] = await conn.execute(
        "SELECT id FROM ride_types WHERE code = ?",
        [rt.code]
      );

      if (existing.length > 0) {
        console.log(`  SKIP  ${rt.code.padEnd(12)} — already exists (id: ${existing[0].id})`);
        skipped++;
        continue;
      }

      const [result] = await conn.execute(
        `INSERT INTO ride_types
          (name, code, description,
           base_fare_cents, per_km_rate_cents,
           min_fare_cents, cancellation_fee_cents,
           capacity, vehicle_type, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rt.name,
          rt.code,
          rt.description,
          rt.base_fare_cents,
          rt.per_km_rate_cents,
          rt.min_fare_cents,
          rt.cancellation_fee_cents,
          rt.capacity,
          rt.vehicle_type,
          rt.is_active,
        ]
      );

      console.log(`  INSERT ${rt.code.padEnd(12)} — id: ${result.insertId}`);
      inserted++;
    }

    console.log(`\nDone. ${inserted} inserted, ${skipped} skipped.`);
  } catch (err) {
    console.error("Seeder error:", err.message);
    process.exit(1);
  } finally {
    conn.release();
    await mysqlPool.end();
  }
}

seed();
