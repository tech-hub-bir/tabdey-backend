require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');

// null = aisle / blocked gap (not inserted as a seat)
// number = seat number printed on the ticket

const HALL_I_BALCONY = {
  name: 'Hall I Balcony',
  section: 'balcony',
  category: 'balcony',
  rows: {
    A: [1, 2, null, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    B: [1, 2, null, 3, 4, 5, 6, null, null, 7, 8, 9, 10, 11, 12, null, null, 13, 14],
    C: [1, 2, null, null, null, null, null, 3, 4, 5, null, null, null, null, null, 6, 7],
    D: [1, 2, null, 3, 4, 5, 6, 7, 8, null, null, 9, 10, 11, 12, 13, 14, null, null, 15, 16],
  },
};

const HALL_I_MAIN = {
  name: 'Hall I',
  section: 'main',
  rows: {
    A: [1, 2, 3, null, null, 6, 7, 8, 9, 10, 11, null, null, 14, 15],
    B: [1, 2, 3, null, null, 6, 7, 8, 9, 10, 11, null, null, 14, 15],
    C: [1, 2, 3, 4, 5, null, null, 8, 9, 10, 11, null, null, 14, 15, 16, 17],
    D: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    E: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    F: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    G: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    H: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    I: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    J: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    K: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    L: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    M: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  },
};

const HALL_II_BALCONY = {
  name: 'Hall II Balcony',
  section: 'balcony',
  category: 'balcony',
  rows: {
    A: [1, 2, null, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    B: [1, 2, null, 3, 4, 5, 6, null, null, 7, 8, 9, 10, 11, 12, null, null, 13, 14],
    C: [1, 2, null, null, null, null, null, 3, 4, 5, null, null, null, null, null, 6, 7],
    D: [1, 2, null, 3, 4, 5, 6, 7, 8, null, null, 9, 10, 11, 12, 13, 14, null, null, 15, 16],
  },
};

const HALL_II_MAIN = {
  name: 'Hall II',
  section: 'main',
  rows: {
    A: [1, 2, null, null, 5, 6, 7, 8, 9, 10, null, null, 13, 14, 15],
    B: [1, 2, null, null, 5, 6, 7, 8, 9, 10, null, null, 13, 14, 15],
    C: [1, 2, null, null, 5, 6, 7, 8, 9, null, null, 12, 13, 14, 15, 16],
    D: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    E: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    F: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    G: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    H: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    I: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    J: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    K: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    L: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    M: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    N: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  },
};

// Premium rows (front) in main halls
const PREMIUM_ROWS = new Set(['A', 'B', 'C', 'D']);

function getCategoryForRow(rowLabel, section) {
  if (section === 'balcony') return 'balcony';
  return PREMIUM_ROWS.has(rowLabel) ? 'premium' : 'regular';
}

async function seedHall(venueName, hallConfig, hallId) {
  const totalSeats = Object.values(hallConfig.rows).reduce(
    (sum, row) => sum + row.filter((s) => s !== null).length,
    0
  );

  await prisma.halls.upsert({
    where: { id: hallId },
    update: { name: hallConfig.name, total_seats: totalSeats },
    create: { id: hallId, venue_name: venueName, name: hallConfig.name, total_seats: totalSeats },
  });

  const seatData = [];
  for (const [rowLabel, cols] of Object.entries(hallConfig.rows)) {
    cols.forEach((seatNum, colIdx) => {
      if (seatNum === null) return;
      const category = hallConfig.category || getCategoryForRow(rowLabel, hallConfig.section);
      seatData.push({
        id: uuidv4(),
        hall_id: hallId,
        row_label: rowLabel,
        seat_number: seatNum,
        column_position: colIdx,
        section: hallConfig.section,
        category,
      });
    });
  }

  // Insert in chunks to avoid query size limits
  const CHUNK = 100;
  for (let i = 0; i < seatData.length; i += CHUNK) {
    await prisma.seats.createMany({ data: seatData.slice(i, i + CHUNK), skipDuplicates: true });
  }

  console.log(`  ✓ ${hallConfig.name} — ${totalSeats} seats`);
  return hallId;
}

async function seed() {
  const VENUE = 'City Cinema Hall';

  // Each hall contains both main + balcony sections
  const HALL_IDS = {
    h1: 'hall-ci-h1m-0000-000000000002',  // Hall I  (265 seats: 209 main + 56 balcony)
    h2: 'hall-ci-h2m-0000-000000000004',  // Hall II (279 seats: 223 main + 56 balcony)
  };

  console.log(`\nSeeding halls for "${VENUE}"...`);

  // Seed all 4 section configs into their respective hall IDs
  await seedHall(VENUE, HALL_I_BALCONY,  HALL_IDS.h1);
  await seedHall(VENUE, HALL_I_MAIN,     HALL_IDS.h1);
  await seedHall(VENUE, HALL_II_BALCONY, HALL_IDS.h2);
  await seedHall(VENUE, HALL_II_MAIN,    HALL_IDS.h2);

  const [h1Count, h2Count] = await Promise.all([
    prisma.seats.count({ where: { hall_id: HALL_IDS.h1 } }),
    prisma.seats.count({ where: { hall_id: HALL_IDS.h2 } }),
  ]);
  console.log(`\nHall I:  ${h1Count} seats (expected 265)`);
  console.log(`Hall II: ${h2Count} seats (expected 279)`);
  console.log('\nHall IDs for API calls:');
  Object.entries(HALL_IDS).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error('Seat seed failed:', err.message);
  process.exit(1);
});
