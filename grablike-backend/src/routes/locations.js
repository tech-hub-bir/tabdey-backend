// routes/locations.js
import express from 'express';
import crypto from 'crypto';
import Redis from 'ioredis';

const router = express.Router();

// ENV: REDIS_URL=redis://localhost:6379
const redis = new Redis(process.env.REDIS_URL);

// ---- limits ----
const RECENT_LIMIT = 5;   // keep last 5 only
const TOP_LIMIT    = 5;   // return top 5 by count

// ---- helpers ----
const key = {
  recent: (uid, type) => `user:${uid}:loc:recent:${type}`,        // list of ids
  counts: (uid, type) => `user:${uid}:loc:counts:${type}`,        // zset id -> count
  meta:   () => `loc:meta`,                                       // hash id -> json
  geo:    () => `geo:all`,                                        // geo set of id
};

function makeId(address, lat, lng) {
  const raw = `${(address || '').trim()}|${(+lat).toFixed(6)}|${(+lng).toFixed(6)}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function sanitize(s, max = 180) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---- POST /api/rides/locations/log ----
router.post('/log', async (req, res) => {
  try {
    const { user_id, type, address, lat, lng } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
    if (!['pickup', 'dropoff'].includes(type)) {
      return res.status(400).json({ ok: false, error: 'type must be pickup or dropoff' });
    }
    const L = Number(lat), G = Number(lng);
    if (!address || Number.isNaN(L) || Number.isNaN(G)) {
      return res.status(400).json({ ok: false, error: 'address, lat, lng required' });
    }

    const cleanAddr = sanitize(address, 220);
    const id = makeId(cleanAddr, L, G);

    const p = redis.pipeline();

    // 1) Store/refresh metadata (hash of id -> JSON)
    const meta = JSON.stringify({ id, address: cleanAddr, lat: L, lng: G, updated_at: Date.now() });
    p.hset(key.meta(), id, meta);

    // 2) GEO index
    p.geoadd(key.geo(), G, L, id);

    // 3) Per-user popular counts
    p.zincrby(key.counts(user_id, type), 1, id);

    // 4) Per-user recent list (cap RECENT_LIMIT)
    p.lpush(key.recent(user_id, type), id);
    p.ltrim(key.recent(user_id, type), 0, RECENT_LIMIT - 1); // keep only latest N

    // TTLs so stale users roll off (180 days)
    const ttl = 60 * 60 * 24 * 180;
    p.expire(key.counts(user_id, type), ttl);
    p.expire(key.recent(user_id, type), ttl);

    await p.exec();

    res.json({ ok: true, id });
  } catch (e) {
    console.error('locations/log error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---- GET /api/rides/popular/locations/:user_id ----
// Returns top 5 + recent 5
router.get('/popular/locations/:user_id', async (req, res) => {
  try {
    const uid = req.params.user_id;

    const readSide = async (type) => {
      const [top, recents] = await Promise.all([
        // top N with scores
        redis.zrevrange(key.counts(uid, type), 0, TOP_LIMIT - 1, 'WITHSCORES'),
        // recent N (already trimmed to N, but we still bound)
        redis.lrange(key.recent(uid, type), 0, RECENT_LIMIT - 1),
      ]);

      // unpack zrevrange WITHSCORES → [{id,count}]
      const topPairs = [];
      for (let i = 0; i < top.length; i += 2) {
        topPairs.push({ id: top[i], count: Number(top[i + 1]) });
      }

      const ids = Array.from(new Set([...topPairs.map(t => t.id), ...recents]));
      const metas = ids.length ? await redis.hmget(key.meta(), ...ids) : [];
      const metaMap = {};
      ids.forEach((id, idx) => {
        try { metaMap[id] = JSON.parse(metas[idx] || '{}'); }
        catch { metaMap[id] = null; }
      });

      const topArr = topPairs
        .map(t => ({ ...(metaMap[t.id] || { id: t.id }), count: t.count }))
        .filter(x => x && x.address);

      const recentArr = recents
        .map(id => metaMap[id])
        .filter(x => x && x.address);

      return { top: topArr, recents: recentArr };
    };

    const [pick, drop] = await Promise.all([readSide('pickup'), readSide('dropoff')]);

    res.json({
      ok: true,
      top_pickup_locations: pick.top,
      top_dropoff_locations: drop.top,
      recent_pickup: pick.recents,
      recent_dropoff: drop.recents,
    });
  } catch (e) {
    console.error('popular/locations error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
