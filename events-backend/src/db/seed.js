require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const db = require('./index');

const organizers = [
  { id: uuidv4(), name: 'Grab Events' },
  { id: uuidv4(), name: 'Thimphu Cultural Society' },
  { id: uuidv4(), name: 'Bhutan Entertainment Hub' },
  { id: uuidv4(), name: 'Mountain Echo Productions' },
];

const events = [
  {
    id: uuidv4(),
    title: 'Cinema Premiere: The Thunder Valley',
    category: 'cinema',
    city: 'Thimphu',
    venue_name: 'City Cinema Hall',
    venue_address: 'Norzin Lam, Thimphu',
    organizer_name: 'Grab Events',
    organizer_index: 0,
    cover_image: '/events/covers/thunder-valley.jpg',
    description: 'A thrilling new Bhutanese feature film set against the dramatic landscapes of the Paro Valley. Follow the journey of a young monk who discovers a secret that shakes the foundations of his monastery.',
    start_at: '2026-05-10 18:00:00',
    end_at: '2026-05-10 21:00:00',
    is_live: 0,
    tiers: [
      { name: 'Regular', description: 'Standard seating', price: 200, available_seats: 209 },
      { name: 'VIP', description: 'Best seats + popcorn combo (rows A–D)', price: 400, available_seats: 56 },
      { name: 'Balcony', description: 'Elevated balcony seating with clear view', price: 350, available_seats: 56 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Mountain Echo Music Festival',
    category: 'concert',
    city: 'Thimphu',
    venue_name: 'Changlimithang Stadium',
    venue_address: 'Changlimithang, Thimphu',
    organizer_name: 'Mountain Echo Productions',
    organizer_index: 3,
    cover_image: '/events/covers/mountain-echo.jpg',
    description: 'Bhutan\'s biggest outdoor music festival featuring top local artists, DJ sets, and live traditional folk fusion performances across three stages.',
    start_at: '2026-05-17 14:00:00',
    end_at: '2026-05-17 23:00:00',
    is_live: 1,
    tiers: [
      { name: 'General', description: 'Open ground standing area', price: 300, available_seats: 500 },
      { name: 'Silver', description: 'Reserved seating in the stands', price: 600, available_seats: 200 },
      { name: 'Gold', description: 'Front-row reserved + backstage pass', price: 1200, available_seats: 50 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Thimphu Jazz Night',
    category: 'concert',
    city: 'Thimphu',
    venue_name: 'The Zone',
    venue_address: 'Babesa, Thimphu',
    organizer_name: 'Bhutan Entertainment Hub',
    organizer_index: 2,
    cover_image: '/events/covers/jazz-night.jpg',
    description: 'An intimate evening of jazz and soul featuring Bhutan\'s finest musicians alongside international guest artists. Enjoy the music with cocktails and fine dining.',
    start_at: '2026-05-22 19:30:00',
    end_at: '2026-05-22 23:00:00',
    is_live: 0,
    tiers: [
      { name: 'Standard', description: 'General seating', price: 500, available_seats: 100 },
      { name: 'Premium Table', description: 'Reserved table for 4 with welcome drinks', price: 2500, available_seats: 15 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Tshechu Cultural Festival',
    category: 'festival',
    city: 'Paro',
    venue_name: 'Rinpung Dzong',
    venue_address: 'Paro Dzong Road, Paro',
    organizer_name: 'Thimphu Cultural Society',
    organizer_index: 1,
    cover_image: '/events/covers/tshechu.jpg',
    description: 'Experience the grandeur of the annual Paro Tshechu — a three-day religious festival featuring sacred mask dances (Cham), traditional music, and vibrant costumes performed by monks and laypeople.',
    start_at: '2026-06-01 08:00:00',
    end_at: '2026-06-03 18:00:00',
    is_live: 0,
    tiers: [
      { name: 'Local', description: 'General entry', price: 100, available_seats: 1000 },
      { name: 'Tourist', description: 'Guided viewing with reserved spot', price: 800, available_seats: 200 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Digital Photography Workshop',
    category: 'workshop',
    city: 'Thimphu',
    venue_name: 'Jojo\'s Art Space',
    venue_address: 'Chang Lam, Thimphu',
    organizer_name: 'Grab Events',
    organizer_index: 0,
    cover_image: '/events/covers/photography-workshop.jpg',
    description: 'A full-day hands-on photography workshop covering composition, natural lighting, and post-processing. Perfect for beginners and intermediate photographers who want to capture Bhutan\'s stunning landscapes.',
    start_at: '2026-05-30 09:00:00',
    end_at: '2026-05-30 17:00:00',
    is_live: 0,
    tiers: [
      { name: 'Standard', description: 'Workshop + lunch + digital certificate', price: 1500, available_seats: 25 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Himalayan Archery Experience',
    category: 'experience',
    city: 'Thimphu',
    venue_name: 'National Archery Range',
    venue_address: 'Lower Motithang, Thimphu',
    organizer_name: 'Bhutan Entertainment Hub',
    organizer_index: 2,
    cover_image: '/events/covers/archery.jpg',
    description: 'Try your hand at Bhutan\'s national sport! Learn from champion archers, practice with traditional bamboo bows, and compete in a friendly mini-tournament. All skill levels welcome.',
    start_at: '2026-05-15 10:00:00',
    end_at: '2026-05-15 14:00:00',
    is_live: 0,
    tiers: [
      { name: 'Basic', description: '1-hour lesson + 30 arrows', price: 400, available_seats: 30 },
      { name: 'Full Experience', description: '2-hour lesson + mini tournament + certificate', price: 700, available_seats: 15 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Phuentsholing Film Fest',
    category: 'cinema',
    city: 'Phuentsholing',
    venue_name: 'Lhaki Cinema',
    venue_address: 'Main Street, Phuentsholing',
    organizer_name: 'Bhutan Entertainment Hub',
    organizer_index: 2,
    cover_image: '/events/covers/film-fest.jpg',
    description: 'A week-long celebration of South Asian cinema featuring Bhutanese, Indian, and Nepali films. Includes Q&A sessions with directors and a short film competition open to local filmmakers.',
    start_at: '2026-06-10 10:00:00',
    end_at: '2026-06-16 22:00:00',
    is_live: 0,
    tiers: [
      { name: 'Day Pass', description: 'Access to all screenings on selected day', price: 300, available_seats: 150 },
      { name: 'Festival Pass', description: 'Full week access to all screenings', price: 1500, available_seats: 50 },
    ],
  },
  {
    id: uuidv4(),
    title: 'Traditional Textile Workshop',
    category: 'workshop',
    city: 'Bumthang',
    venue_name: 'Yathra Weaving Centre',
    venue_address: 'Chumey Valley, Bumthang',
    organizer_name: 'Thimphu Cultural Society',
    organizer_index: 1,
    cover_image: '/events/covers/textile-workshop.jpg',
    description: 'Learn the art of traditional Bhutanese Yathra weaving from master weavers. Participants will create their own small textile piece to take home. A unique cultural immersion experience.',
    start_at: '2026-06-05 09:00:00',
    end_at: '2026-06-05 16:00:00',
    is_live: 0,
    tiers: [
      { name: 'Standard', description: 'Materials + lunch + take-home textile piece', price: 1200, available_seats: 12 },
    ],
  },
];

async function seed() {
  console.log('Seeding organizers...');
  for (const org of organizers) {
    await db.query(
      `INSERT INTO organizers (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [org.id, org.name]
    );
  }

  console.log('Seeding events and ticket tiers...');
  for (const event of events) {
    const orgId = organizers[event.organizer_index].id;

    await db.query(
      `INSERT INTO events
         (id, title, category, city, venue_name, venue_address, organizer_name, organizer_id,
          cover_image, description, start_at, end_at, is_live)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title)`,
      [
        event.id, event.title, event.category, event.city,
        event.venue_name, event.venue_address, event.organizer_name, orgId,
        event.cover_image, event.description, event.start_at, event.end_at, event.is_live,
      ]
    );

    for (const tier of event.tiers) {
      const tierId = uuidv4();
      await db.query(
        `INSERT INTO ticket_tiers (id, event_id, name, description, price, available_seats)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tierId, event.id, tier.name, tier.description, tier.price, tier.available_seats]
      );
    }

    console.log(`  ✓ ${event.title}`);
  }

  console.log('\nSeeding complete!');
  await db.pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
