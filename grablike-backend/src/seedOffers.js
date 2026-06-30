// seedOffers.js
import { getConn } from './db/mysql.js';

const sampleOffers = [
  {
    title: 'Up to 20% off Premium',
    sub: 'Limited‑time deals in your city',
    icon: 'ticket-percent-outline',
    cta: 'View offer',
    tint: 'rgba(0,177,79,0.10)',
    category: 'for_you',
    promoCode: 'PREMIUM20',
    deepLink: 'OfferDetail',
    startDate: new Date(),
    expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    for_all: true,
    applicableTiers: JSON.stringify(['bronze', 'silver', 'gold', 'platinum']),
    applicableLocations: JSON.stringify(['Thimphu', 'Paro']),
    user_segment: JSON.stringify(['new', 'regular']),
  },
  {
    title: 'Earn points on every ride',
    sub: 'Redeem for discounts & perks',
    icon: 'star-four-points-outline',
    cta: 'See rewards',
    tint: '#EAF3FF',
    category: 'rewards',
    deepLink: 'Rewards',
    expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    for_all: true,
  },
  {
    title: 'Safer rides, verified drivers',
    sub: 'SOS, live share, and trip checks',
    icon: 'shield-check',
    cta: 'Safety center',
    tint: '#F1FFF6',
    category: 'for_you',
    deepLink: 'SafetyCenter',
    expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    for_all: true,
  },
  {
    title: 'Nu.50 off your next ride',
    sub: 'Use code WELCOME50',
    icon: 'tag-outline',
    cta: 'Copy code',
    tint: '#FFF1E0',
    category: 'vouchers',
    promoCode: 'WELCOME50',
    deepLink: 'OfferDetail',
    expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    for_all: false,
    applicableTiers: JSON.stringify(['bronze']),
    user_segment: JSON.stringify(['new']),
  },
];

async function seed() {
  const conn = await getConn();
  try {
    await conn.execute('DELETE FROM offers');
    for (const offer of sampleOffers) {
      await conn.execute(
        `INSERT INTO offers 
         (title, sub, icon, cta, tint, category, promoCode, deepLink, startDate, expiryDate, for_all, applicableTiers, applicableLocations, user_segment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          offer.title,
          offer.sub,
          offer.icon,
          offer.cta,
          offer.tint,
          offer.category,
          offer.promoCode || null,
          offer.deepLink,
          offer.startDate || new Date(),
          offer.expiryDate,
          offer.for_all,
          offer.applicableTiers || null,
          offer.applicableLocations || null,
          offer.user_segment || null,
        ]
      );
    }
    console.log('Sample offers inserted');
  } catch (err) {
    console.error(err);
  } finally {
    conn.release();
    process.exit();
  }
}

seed();