// routes/places.js (ESM)
// Free OSM suggestions via Photon (default) or Nominatim.
// Normalizes to: { place_id, description, coords: { latitude, longitude }, raw }

import express from 'express';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';

// If you’re on Node 18+, global fetch exists. If not, uncomment:
// import fetch from 'node-fetch';

const router = express.Router();

/* ====== ENV ====== */
const OSM_PROVIDER   = (process.env.OSM_PROVIDER || 'photon').toLowerCase(); // 'photon' | 'nominatim'
const PHOTON_URL     = process.env.PHOTON_URL    || 'https://photon.komoot.io/api';
const NOMINATIM_URL  = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const OSM_USER_AGENT = process.env.OSM_USER_AGENT || 'YourApp/1.0 (contact@example.com)';
const REDIS_URL      = process.env.REDIS_URL || '';            // optional
const CACHE_TTL      = Number(process.env.CACHE_TTL || 180);   // seconds

/* ====== Rate limit only this router ====== */
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 30_000), // 30s
  max: Number(process.env.RATE_LIMIT_MAX || 60),                // 60 requests / window / IP
});
router.use(limiter);

/* ====== Cache (Redis if provided; else in-memory) ====== */
let memCache = new Map();
let redis = null;
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
  if (Date.now() > entry.expires) {
    memCache.delete(key);
    return null;
  }
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

function normalizePhoton(json) {
  const features = json?.features || [];
  return features.map((f, i) => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [];
    const lon = coords[0], lat = coords[1];
    const parts = [p.name, p.street, p.city, p.state, p.country].filter(Boolean);
    const description = Array.from(new Set(parts)).join(', ') || p.type || 'Unnamed place';
    return {
      place_id: p.osm_id ? `osm:${p.osm_id}` : `photon:${i}`,
      description,
      coords: (lat != null && lon != null) ? { latitude: lat, longitude: lon } : null,
      raw: p,
    };
  });
}

function normalizeNominatim(json) {
  const arr = Array.isArray(json) ? json : [];
  return arr.map((item) => ({
    place_id: String(item.place_id ?? item.osm_id ?? ''),
    description: item.display_name || item.name || 'Unnamed place',
    coords: (item.lat != null && item.lon != null)
      ? { latitude: Number(item.lat), longitude: Number(item.lon) }
      : null,
    raw: item,
  }));
}

/* ====== Provider calls ====== */
async function queryPhoton({ q, lat, lon, limit }) {
  const url = new URL(PHOTON_URL);
  url.searchParams.set('q', q);
  if (lat != null && lon != null) {
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lon);
  }
  url.searchParams.set('limit', limit);
  const res = await fetch(url.toString(), { headers: { 'User-Agent': OSM_USER_AGENT } });
  if (!res.ok) throw new Error(`Photon error ${res.status}`);
  return normalizePhoton(await res.json());
}

async function queryNominatim({ q, lat, lon, limit }) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', limit);
  if (lat != null && lon != null) {
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lon);
  }
  const res = await fetch(url.toString(), { headers: { 'User-Agent': OSM_USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  return normalizeNominatim(await res.json());
}

/* ====== GET /api/places/suggest?q=&lat=&lon=&limit= ====== */
router.get('/suggest', async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim();
    if (qRaw.length < 2) {
      return res.status(400).json({ ok: false, error: 'q must be >= 2 chars' });
    }

    const lat = req.query.lat != null ? Number(req.query.lat) : null;
    const lon = req.query.lon != null ? Number(req.query.lon) : null;
    const limit = clamp(req.query.limit ?? 8, 1, 15);

    const cacheKey = `places:suggest:${OSM_PROVIDER}:${qRaw}:${lat ?? ''}:${lon ?? ''}:${limit}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json({
        ok: true,
        provider: OSM_PROVIDER,
        attribution: OSM_PROVIDER === 'nominatim'
          ? 'Data © OpenStreetMap contributors, search by Nominatim'
          : 'Data © OpenStreetMap contributors, search by Photon (Komoot)',
        items: cached,
        cached: true,
      });
    }

    const args = { q: qRaw, lat, lon, limit };
    const items = (OSM_PROVIDER === 'nominatim')
      ? await queryNominatim(args)
      : await queryPhoton(args);

    await cacheSet(cacheKey, items, CACHE_TTL);

    res.json({
      ok: true,
      provider: OSM_PROVIDER,
      attribution: OSM_PROVIDER === 'nominatim'
        ? 'Data © OpenStreetMap contributors, search by Nominatim'
        : 'Data © OpenStreetMap contributors, search by Photon (Komoot)',
      items,
      cached: false,
    });
  } catch (e) {
    console.error('places/suggest error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
