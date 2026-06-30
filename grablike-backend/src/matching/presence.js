// src/matching/presence.js
import { getRedis } from "./redis.js";
import { geoKey, onlineSet, driverHash } from "./redisKeys.js";

const redis = getRedis();

const toStr = (v) => (v == null ? "" : String(v));
const isNum = (n) => Number.isFinite(n);

/**
 * NOTE:
 * - geoKey(cityId, serviceCode) -> geo:drivers:city:${cityId}:${serviceCode}
 * - onlineSet(cityId, serviceCode) -> online:drivers:city:${cityId}:${serviceCode}
 * - We normalize a "codeKey" = serviceCode || serviceType || "default" so
 *   drivers with D-prefixed codes (e.g. D1234) get stored under that code.
 */
export const presence = {
  async setOnline(
    driverId,
    { cityId, serviceType, serviceCode, socketId, lat, lng }
  ) {
    const member = toStr(driverId);

    // ✅ store geo + online sets under FULL serviceCode (e.g. D1234)
    const codeKey = (serviceCode || serviceType ).toString();
    const key = geoKey(cityId, codeKey);          // geo:drivers:city:thimphu:D1234
    const hkey = driverHash(member);
    const oset = onlineSet(cityId, codeKey);      // online:drivers:city:thimphu:D1234

    const pipe = redis.multi();
    if (isNum(lat) && isNum(lng)) {
      pipe.geoadd(key, Number(lng), Number(lat), member);
    }
    pipe.sadd(oset, member);

    pipe.hset(hkey, {
      status: "online",
      cityId,
      serviceType,
      serviceCode: codeKey,
      lastSeen: Date.now(),
      lat: isNum(lat) ? Number(lat) : "",
      lng: isNum(lng) ? Number(lng) : "",
    });
    if (socketId) pipe.sadd(`${hkey}:sockets`, socketId);
    pipe.expire(hkey, 60 * 60);

    await pipe.exec();

    console.log(
      `[presence] driver ${driverId} online at ${lat},${lng} in ${cityId}:${serviceType} ${codeKey}`
    );
  },

  /**
   * If socketId is provided, we remove that socket from the driver's socket set.
   * Only mark fully offline if that set becomes empty.
   */
  async setOffline(driverId, socketId = null) {
    const member = toStr(driverId);
    const hkey = driverHash(member);

    // Remove socket from live set (if any)
    if (socketId) {
      await redis.srem(`${hkey}:sockets`, socketId);
      const remaining = await redis.scard(`${hkey}:sockets`);
      if (remaining > 0) {
        // Still online via other sockets; just mark lastSeen
        await redis.hset(hkey, { lastSeen: Date.now() });
        console.log(
          `[presence] driver ${driverId} still online via ${remaining} socket(s)`
        );
        return;
      }
    }

    const meta = await redis.hgetall(hkey);
    const cityId = meta.cityId || "thimphu";
    const serviceType = meta.serviceType || "bike";
    const codeKey = (
      meta.serviceCode ||
      meta.service_code ||
      serviceType 
    ).toString();

    const key = geoKey(cityId, codeKey);
    const oset = onlineSet(cityId, codeKey);

    const pipe = redis.multi();
    pipe.zrem(key, member);
    pipe.srem(oset, member);
    pipe.hset(hkey, { status: "offline", lastSeen: Date.now() });
    await pipe.exec();

    console.log(
      `[presence] driver ${driverId} offline in ${cityId}:${serviceType} ${codeKey}`
    );
  },

  async updateLocation(driverId, { cityId, serviceType, serviceCode, lat, lng }) {
    if (!isNum(lat) || !isNum(lng)) {
      console.log("[presence.updateLocation] skip invalid", { driverId, lat, lng });
      return 0;
    }

    const member = toStr(driverId);
    const codeKey = (serviceCode || serviceType).toString();
    const key = geoKey(cityId, codeKey);
    const hkey = driverHash(member);

    const pipe = redis.multi();
    pipe.geoadd(key, Number(lng), Number(lat), member);
    pipe.hset(hkey, {
      lat: Number(lat),
      lng: Number(lng),
      lastSeen: Date.now(),
    });
    pipe.expire(hkey, 60 * 60);

    const res = await pipe.exec();
    console.log("[presence.updateLocation] write", {
      key,
      member,
      lat,
      lng,
      res,
    });
    return res;
  },

  // Exact serviceCode lookup (single key)
  async getNearby({
    cityId,
    serviceCode, // full code, e.g. "D1234"
    lat,
    lng,
    radiusM = 5000,
    count = 25,
  }) {
    const key = geoKey(cityId, serviceCode);
    try {
      const res = await redis.geosearch(
        key,
        "FROMLONLAT",
        Number(lng),
        Number(lat),
        "BYRADIUS",
        radiusM,
        "m",
        "ASC",
        "COUNT",
        count,
        "WITHCOORD"
      );
      return res.map(([id, [lon, la]]) => ({
        id,
        lat: parseFloat(la),
        lng: parseFloat(lon),
      }));
    } catch (e) {
      console.warn(
        "[presence.getNearby] geosearch failed, fallback to georadius",
        e.message
      );
      try {
        const legacy = await redis.georadius(
          key,
          Number(lng),
          Number(lat),
          radiusM,
          "m",
          "WITHCOORD",
          "ASC",
          "COUNT",
          count
        );
        return legacy.map(([id, [lon, la]]) => ({
          id,
          lat: parseFloat(la),
          lng: parseFloat(lon),
        }));
      } catch (err) {
        console.error("[presence.getNearby] georadius fallback failed:", err);
        return [];
      }
    }
  },

  // 🔽🔽🔽 NEW HELPER: find drivers whose serviceCode starts with prefix "D" 🔽🔽🔽
  async getNearbyByCodePrefix({
    cityId,          
    lat,
    lng,
    radiusM = 5000,
    count = 25,
    driverCodePrefix = "D",
  }) {
    // 1) Scan all geo keys: geo:drivers:city:thimphu:D*
    const pattern = `geo:drivers:city:${cityId}:${driverCodePrefix}*`;
    let cursor = "0";
    const geoKeys = new Set();

    try {
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          50
        );
        cursor = nextCursor;
        if (Array.isArray(keys)) {
          keys.forEach((k) => geoKeys.add(k));
        }
      } while (cursor !== "0");
    } catch (e) {
      console.error(
        "[presence.getNearbyByCodePrefix] scan error:",
        e?.message || e
      );
    }

    if (!geoKeys.size) {
      console.log(
        "[presence.getNearbyByCodePrefix] no geo keys for prefix",
        driverCodePrefix,
        "in city",
        cityId,
        "pattern=",
        pattern
      );
      return [];
    }

    const results = [];
    const seen = new Set();

    // 2) For each key, do a geo lookup and merge
    for (const key of geoKeys) {
      try {
        let res = [];
        try {
          res = await redis.geosearch(
            key,
            "FROMLONLAT",
            Number(lng),
            Number(lat),
            "BYRADIUS",
            radiusM,
            "m",
            "ASC",
            "COUNT",
            count,
            "WITHCOORD"
          );
        } catch (e) {
          console.warn(
            "[presence.getNearbyByCodePrefix] geosearch failed, fallback to georadius:",
            key,
            e?.message
          );
          const legacy = await redis.georadius(
            key,
            Number(lng),
            Number(lat),
            radiusM,
            "m",
            "WITHCOORD",
            "ASC",
            "COUNT",
            count
          );
          res = legacy;
        }

        for (const row of res) {
          const [id, [lon, la]] = row;
          const idStr = String(id);
          if (seen.has(idStr)) continue;
          seen.add(idStr);

          results.push({
            id: idStr,
            lat: parseFloat(la),
            lng: parseFloat(lon),
            key,
          });
        }
      } catch (e) {
        console.warn(
          "[presence.getNearbyByCodePrefix] geo search error for key",
          key,
          e?.message || e
        );
      }
    }

    console.log(
      "[presence.getNearbyByCodePrefix] found drivers",
      {
        cityId,
        driverCodePrefix,
        count: results.length,
        keys: [...geoKeys],
      }
    );

    return results;
  },
};

export default { presence };
