// src/services/offerAdapter.js  (ESM) — Option B: no ENUM change
export function makeOfferAdapter(mysqlPool) {
  return {
    /**
     * Persist that ride is currently offered to driverId until expireAt (Date).
     * Also moves the row to 'offered_to_driver'.
     */
    async setOffer({ rideId, driverId, expireAt }) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.execute(
          `
          UPDATE rides
             SET status='offered_to_driver',
                 offer_driver_id=?,
                 offer_expire_at=?
           WHERE ride_id=? AND status IN ('requested','offered_to_driver')
          `,
          [driverId, expireAt, rideId]
        );
      } finally {
        try { conn.release(); } catch {}
      }
    },

    /**
     * Clear offer fields (used rarely; most flows use reopenRequested/finalizeOnAccept).
     */
    async clearOffer({ rideId }) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.execute(
          `
          UPDATE rides
             SET offer_driver_id=NULL,
                 offer_expire_at=NULL
           WHERE ride_id=?
          `,
          [rideId]
        );
      } finally {
        try { conn.release(); } catch {}
      }
    },

    /**
     * Reopen the ride to 'requested' after a reject/timeout so the next driver can be offered.
     */
    async reopenRequested({ rideId }) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.execute(
          `
          UPDATE rides
             SET status='requested',
                 offer_driver_id=NULL,
                 offer_expire_at=NULL
           WHERE ride_id=? AND status='offered_to_driver'
          `,
          [rideId]
        );
      } finally {
        try { conn.release(); } catch {}
      }
    },

    /**
     * End of funnel: no drivers accepted — mark as system-cancelled with reason.
     */
    async markNoDrivers({ rideId }) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.execute(
          `
          UPDATE rides
             SET status='cancelled_system',
                 cancel_reason='no_drivers',
                 cancelled_at=NOW(),
                 offer_driver_id=NULL,
                 offer_expire_at=NULL
           WHERE ride_id=? AND status IN ('requested','offered_to_driver')
          `,
          [rideId]
        );
      } finally {
        try { conn.release(); } catch {}
      }
    },

    /**
     * Clear offer fields on accept (acceptRide service sets accepted + driver_id).
     */
    async finalizeOnAccept({ rideId }) {
      const conn = await mysqlPool.getConnection();
      try {
        await conn.execute(
          `
          UPDATE rides
             SET offer_driver_id=NULL,
                 offer_expire_at=NULL
           WHERE ride_id=?
          `,
          [rideId]
        );
      } finally {
        try { conn.release(); } catch {}
      }
    },
  };
}
