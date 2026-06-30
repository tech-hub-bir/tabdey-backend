// src/controllers/guestWaypoints.controller.js

const asInt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const x = Math.trunc(n);
  return x > 0 ? x : null;
};

const asNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clampStr = (s, max = 255) => {
  const x = String(s ?? "").trim();
  if (!x) return null;
  return x.length > max ? x.slice(0, max) : x;
};

const isValidLatLng = (lat, lng) =>
  typeof lat === "number" &&
  typeof lng === "number" &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

async function ensureRideExists(conn, rideId) {
  const [[r]] = await conn.query(
    `SELECT ride_id FROM rides WHERE ride_id = ? LIMIT 1`,
    [rideId]
  );
  return !!r;
}

async function ensureJoinedParticipant(conn, rideId, userId) {
  const [[p]] = await conn.query(
    `
    SELECT participant_id
    FROM ride_participants
    WHERE ride_id = ? AND user_id = ? AND join_status = 'joined'
    LIMIT 1
    `,
    [rideId, userId]
  );
  return !!p;
}

export function guestWaypointsController(mysqlPool) {
  if (!mysqlPool?.getConnection) throw new Error("mysqlPool required");

  return {
    // POST /api/rides/:rideId/guest-waypoint
    async upsertGuestWaypoint(req, res) {
      const rideId = asInt(req.params.rideId);
      const userId = asInt(req.body?.user_id);
      const lat = asNum(req.body?.lat);
      const lng = asNum(req.body?.lng);
      const address = clampStr(req.body?.address, 255);

      if (!rideId) return res.status(400).json({ ok: false, error: "Missing rideId" });
      if (!userId) return res.status(400).json({ ok: false, error: "Missing user_id" });
      if (!isValidLatLng(lat, lng))
        return res.status(400).json({ ok: false, error: "Invalid lat/lng" });

      let conn;
      try {
        conn = await mysqlPool.getConnection();
        await conn.beginTransaction();

        // safety: ride exists
        const rideOk = await ensureRideExists(conn, rideId);
        if (!rideOk) {
          await conn.rollback();
          return res.status(404).json({ ok: false, error: "Ride not found" });
        }

        // safety: must be joined participant (host or guest)
        const joinedOk = await ensureJoinedParticipant(conn, rideId, userId);
        if (!joinedOk) {
          await conn.rollback();
          return res.status(403).json({ ok: false, error: "Not a joined participant" });
        }

        // lock existing row if present
        const [[existing]] = await conn.query(
          `
          SELECT id, seq
          FROM ride_guest_waypoints
          WHERE ride_id = ? AND user_id = ?
          FOR UPDATE
          `,
          [rideId, userId]
        );

        if (existing?.id) {
          await conn.query(
            `
            UPDATE ride_guest_waypoints
            SET lat = ?, lng = ?, address = ?, updated_at = NOW()
            WHERE id = ?
            `,
            [lat, lng, address, existing.id]
          );

          await conn.commit();
          return res.json({
            ok: true,
            data: {
              ride_id: rideId,
              user_id: userId,
              lat,
              lng,
              address,
              seq: existing.seq,
              status: "updated",
            },
          });
        }

        // assign next seq (stable order)
        const [[mx]] = await conn.query(
          `
          SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq
          FROM ride_guest_waypoints
          WHERE ride_id = ?
          FOR UPDATE
          `,
          [rideId]
        );
        const nextSeq = Number(mx?.nextSeq || 1);

        await conn.query(
          `
          INSERT INTO ride_guest_waypoints (ride_id, user_id, lat, lng, address, seq)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [rideId, userId, lat, lng, address, nextSeq]
        );

        await conn.commit();
        return res.json({
          ok: true,
          data: {
            ride_id: rideId,
            user_id: userId,
            lat,
            lng,
            address,
            seq: nextSeq,
            status: "created",
          },
        });
      } catch (e) {
        if (conn) await conn.rollback();
        return res.status(500).json({ ok: false, error: e?.message || "Server error" });
      } finally {
        if (conn) conn.release();
      }
    },

    // GET /api/rides/:rideId/guest-waypoints
    async listGuestWaypoints(req, res) {
      const rideId = asInt(req.params.rideId);
      if (!rideId) return res.status(400).json({ ok: false, error: "Missing rideId" });

      let conn;
      try {
        conn = await mysqlPool.getConnection();

        const [rows] = await conn.query(
          `
          SELECT ride_id, user_id, lat, lng, address, seq, created_at, updated_at
          FROM ride_guest_waypoints
          WHERE ride_id = ?
          ORDER BY seq ASC, id ASC
          `,
          [rideId]
        );

        return res.json({ ok: true, data: rows || [] });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e?.message || "Server error" });
      } finally {
        if (conn) conn.release();
      }
    },

    // DELETE /api/rides/:rideId/guest-waypoint
    // body: { user_id }
    async deleteGuestWaypoint(req, res) {
      const rideId = asInt(req.params.rideId);
      const userId = asInt(req.body?.user_id);
      if (!rideId) return res.status(400).json({ ok: false, error: "Missing rideId" });
      if (!userId) return res.status(400).json({ ok: false, error: "Missing user_id" });

      let conn;
      try {
        conn = await mysqlPool.getConnection();
        await conn.beginTransaction();

        const [del] = await conn.query(
          `
          DELETE FROM ride_guest_waypoints
          WHERE ride_id = ? AND user_id = ?
          `,
          [rideId, userId]
        );

        // resequence (optional but keeps seq neat)
        const [rows] = await conn.query(
          `
          SELECT id
          FROM ride_guest_waypoints
          WHERE ride_id = ?
          ORDER BY seq ASC, id ASC
          FOR UPDATE
          `,
          [rideId]
        );

        let seq = 1;
        for (const r of rows || []) {
          await conn.query(
            `UPDATE ride_guest_waypoints SET seq = ? WHERE id = ?`,
            [seq++, r.id]
          );
        }

        await conn.commit();
        return res.json({ ok: true, removed: del?.affectedRows || 0 });
      } catch (e) {
        if (conn) await conn.rollback();
        return res.status(500).json({ ok: false, error: e?.message || "Server error" });
      } finally {
        if (conn) conn.release();
      }
    },
  };
}
