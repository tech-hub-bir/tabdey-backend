require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');

const SHOW_TIMES = ['10:00', '13:30', '17:00', '20:30'];

const HALL_IDS = {
  h1main:    'hall-ci-h1m-0000-000000000002',
  h1balcony: 'hall-ci-h1b-0000-000000000001',
  h2main:    'hall-ci-h2m-0000-000000000004',
  h2balcony: 'hall-ci-h2b-0000-000000000003',
};

// Generate dates starting from today for N days
function getDates(startDate, days) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
}

async function seedScreenings() {
  // Only seed for cinema events
  const cinemaEvents = await prisma.events.findMany({
    where: { category: 'cinema' },
    select: { id: true, title: true, venue_name: true, start_at: true },
  });

  if (!cinemaEvents.length) {
    console.log('No cinema events found. Run npm run seed first.');
    return;
  }

  for (const event of cinemaEvents) {
    // Only seed for City Cinema Hall (which has our hall data)
    if (event.venue_name !== 'City Cinema Hall') {
      console.log(`  Skipping "${event.title}" — no hall data for ${event.venue_name}`);
      continue;
    }

    const startDate = new Date(event.start_at).toISOString().slice(0, 10);
    const dates = getDates(startDate, 7); // 7-day run

    const screeningData = [];

    for (const date of dates) {
      for (const time of SHOW_TIMES) {
        // Hall I screenings
        screeningData.push({
          id: uuidv4(),
          event_id: event.id,
          hall_id: HALL_IDS.h1main,
          show_date: new Date(date),
          show_time: new Date(`1970-01-01T${time}:00Z`),
          status: 'active',
        });
        // Hall II screenings
        screeningData.push({
          id: uuidv4(),
          event_id: event.id,
          hall_id: HALL_IDS.h2main,
          show_date: new Date(date),
          show_time: new Date(`1970-01-01T${time}:00Z`),
          status: 'active',
        });
      }
    }

    await prisma.screenings.createMany({ data: screeningData, skipDuplicates: true });
    console.log(`  ✓ "${event.title}" — ${screeningData.length} screenings (${dates.length} days × ${SHOW_TIMES.length} shows × 2 halls)`);
  }

  // Print sample IDs for testing
  const sample = await prisma.screenings.findFirst({
    include: { events: { select: { title: true } }, halls: { select: { name: true } } },
  });
  if (sample) {
    console.log(`\nSample screening ID for testing:`);
    console.log(`  id: ${sample.id}`);
    console.log(`  movie: ${sample.events.title}`);
    console.log(`  hall: ${sample.halls.name}`);
    console.log(`  date: ${sample.show_date.toISOString().slice(0, 10)}`);
  }

  await prisma.$disconnect();
}

seedScreenings().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
