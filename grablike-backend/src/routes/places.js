// routes/places.js (ESM)
// Serves place autocomplete from local MySQL (OSM data).
// Normalizes to: { place_id, description, coords: { latitude, longitude }, raw }

import express from 'express';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import { mysqlPool } from '../db/mysql.js';

const router = express.Router();

/* ====== ENV ====== */
const REDIS_URL  = process.env.REDIS_URL || '';
const CACHE_TTL  = Number(process.env.CACHE_TTL || 180); // seconds

/* ====== Rate limit only this router ====== */
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 30_000),
  max:      Number(process.env.RATE_LIMIT_MAX       || 60),
});
router.use(limiter);

/* ====== Cache (Redis if provided; else in-memory) ====== */
let memCache = new Map();
let redis    = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
}

async function cacheGet(key) {
  if (redis) {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  }
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { memCache.delete(key); return null; }
  return entry.value;
}

async function cacheSet(key, value, ttlSec = CACHE_TTL) {
  const s = JSON.stringify(value);
  if (redis) {
    await redis.setex(key, ttlSec, s);
  } else {
    memCache.set(key, { value, expires: Date.now() + ttlSec * 1000 });
  }
}

/* ====== Utils ====== */
function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/* ====== MySQL queries ====== */
async function queryLocal({ q, lat, lon, limit }) {
  const booleanQ = q.split(/\s+/).filter(Boolean).map(w => `+${w}*`).join(' ');
  const likeQ    = `%${q}%`;

  let rows;

  if (lat != null && lon != null) {
    // Sort by distance from user location — Haversine (MariaDB-compatible)
    [rows] = await mysqlPool.query(
      `SELECT
         id, name, amenity, tourism, shop, place, lat, lon,
         (6371000 * ACOS(
           LEAST(1,
             COS(RADIANS(?)) * COS(RADIANS(lat)) * COS(RADIANS(lon) - RADIANS(?)) +
             SIN(RADIANS(?)) * SIN(RADIANS(lat))
           )
         )) AS distance_m
       FROM places
       WHERE MATCH(name) AGAINST (? IN BOOLEAN MODE)
          OR name LIKE ?
       ORDER BY distance_m ASC
       LIMIT ?`,
      [lat, lon, lat, booleanQ, likeQ, limit]
    );
  } else {
    // Sort by fulltext relevance
    [rows] = await mysqlPool.query(
      `SELECT id, name, amenity, tourism, shop, place, lat, lon
       FROM places
       WHERE MATCH(name) AGAINST (? IN BOOLEAN MODE)
          OR name LIKE ?
       ORDER BY MATCH(name) AGAINST (? IN BOOLEAN MODE) DESC
       LIMIT ?`,
      [booleanQ, likeQ, booleanQ, limit]
    );
  }

  return rows.map(r => ({
    place_id:    `local:${r.id}`,
    description: [r.name, r.amenity || r.tourism || r.shop || r.place]
                   .filter(Boolean).join(' · '),
    coords:      { latitude: r.lat, longitude: r.lon },
    raw:         r,
  }));
}

/* ====== GET /api/places/suggest?q=&lat=&lon=&limit= ====== */
router.get('/suggest', async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim();
    if (qRaw.length < 2) {
      return res.status(400).json({ ok: false, error: 'q must be >= 2 chars' });
    }

    const lat   = req.query.lat != null ? Number(req.query.lat) : null;
    const lon   = req.query.lon != null ? Number(req.query.lon) : null;
    const limit = clamp(req.query.limit ?? 8, 1, 15);

    const cacheKey = `places:suggest:local:${qRaw}:${lat ?? ''}:${lon ?? ''}:${limit}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) {
      return res.json({ ok: true, provider: 'local-osm', items: cached, cached: true });
    }

    const items = await queryLocal({ q: qRaw, lat, lon, limit });
    await cacheSet(cacheKey, items, CACHE_TTL);

    res.json({
      ok:          true,
      provider:    'local-osm',
      attribution: 'Data © OpenStreetMap contributors',
      items,
      cached:      false,
    });
  } catch (e) {
    console.error('places/suggest error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
