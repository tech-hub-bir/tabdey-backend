// Minimal fare computation (dummy): base + distance + time - platform
export function computeFareCents(distance_m, duration_s, base_fare, per_km_rate, per_min_rate) {
  const base = 5000; // 50 Nu
  const perKm = 1200; // 12 Nu per km
  const perMin = 100; // 1 Nu per minute
  const km = Math.max(0, distance_m) / 1000;
  const min = Math.max(0, duration_s) / 60;

  const distance_cents = Math.round(km * perKm);
  const time_cents = Math.round(min * perMin);
  const platform_fee_cents = Math.round((base + distance_cents + time_cents) * 0.23);

  return {
    base_cents: base,
    distance_cents,
    time_cents,
    surge_cents: 0,
    tolls_cents: 0,
    tips_cents: 0,
    other_adj_cents: 0,
    platform_fee_cents,
    tax_cents: 0
  };
}
