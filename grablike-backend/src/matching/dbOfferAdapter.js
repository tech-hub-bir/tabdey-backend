// src/matching/dbOfferAdapter.js
/**
 * This adapter keeps MySQL rides table in sync with matcher offers.
 * It is called by matcher.js via configureMatcher(adapter).
 *
 * Expected rides table fields:
 * - status ENUM(... 'requested','offered_to_driver','accepted','cancelled_*','failed', ...)
 * - offer_driver_id BIGINT
 * - offer_expire_at DATETIME
 * - driver_id BIGINT
 * - accepted_at DATETIME
 */

export function makeDbOfferAdapter({ mysqlPool }) {
  return {
    // called whenever matcher offers to a driver (each step in sequential offer)
    async setOffer({ rideId, driverId, expireAt }) {
      // mark offered_to_driver + offer_driver_id + offer_expire_at
      await mysqlPool.query(
        `
        UPDATE rides
        SET status='offered_to_driver',
            offer_driver_id=?,
            offer_expire_at=?,
            requested_at = COALESCE(requested_at, NOW())
        WHERE ride_id=?
          AND status IN ('requested','matching','scheduled','reserved','offered_to_driver')
        `,
        [Number(driverId), toMysqlDateTime(expireAt), Number(rideId)]
      );
    },

    // called when offer times out/rejected and matcher wants to continue
    async reopenRequested({ rideId }) {
      // keep it "requested" so worker/matcher treat it as alive
      // clear offer_driver_id so next driver can be offered cleanly
      await mysqlPool.query(
        `
        UPDATE rides
        SET status='requested',
            offer_driver_id=NULL,
            offer_expire_at=NULL
        WHERE ride_id=?
          AND status='offered_to_driver'
        `,
        [Number(rideId)]
      );
    },

    // called when matcher finds no candidates at all
    async markNoDrivers({ rideId }) {
      await mysqlPool.query(
        `
        UPDATE rides
        SET status='cancelled_system',
            cancel_reason='NO_DRIVERS',
            cancelled_at=NOW(),
            offer_driver_id=NULL,
            offer_expire_at=NULL
        WHERE ride_id=?
          AND status IN ('requested','matching','scheduled','reserved','offered_to_driver')
        `,
        [Number(rideId)]
      );
    },

    // called when driver accepts (matcher.acceptOffer)
    async finalizeOnAccept({ rideId }) {
      // In your flow, accept endpoint should set driver_id in DB,
      // but we keep this as a safety net (doesn't harm).
      await mysqlPool.query(
        `
        UPDATE rides
        SET status='accepted',
            accepted_at = COALESCE(accepted_at, NOW()),
            offer_driver_id=NULL,
            offer_expire_at=NULL
        WHERE ride_id=?
          AND status IN ('requested','offered_to_driver','matching')
        `,
        [Number(rideId)]
      );
    },

    // optional, not required by your matcher right now
    async clearOffer({ rideId }) {
      await mysqlPool.query(
        `
        UPDATE rides
        SET offer_driver_id=NULL,
            offer_expire_at=NULL
        WHERE ride_id=?
        `,
        [Number(rideId)]
      );
    },
  };
}

function toMysqlDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(
    dt.getHours()
  )}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}
