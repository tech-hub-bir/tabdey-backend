const db = require("../config/db");

/**
 * Compute and save estimated arrival time (TIME) for an order.
 * Frontend sends estimated_minutes (integer)
 */
async function updateEstimatedArrivalTime(order_id, estimated_minutes) {
  try {
    const mins = Number(estimated_minutes);
    if (!Number.isFinite(mins) || mins <= 0)
      throw new Error("Invalid estimated minutes");

    const now = new Date();
    const arrival = new Date(now.getTime() + mins * 60000);

    const hh = String(arrival.getHours()).padStart(2, "0");
    const mm = String(arrival.getMinutes()).padStart(2, "0");
    const ss = String(arrival.getSeconds()).padStart(2, "0");
    const formattedTime = `${hh}:${mm}:${ss}`;

    await db.query(
      `UPDATE orders SET estimated_arrivial_time = ? WHERE order_id = ?`,
      [formattedTime, order_id]
    );

    console.log(
      `✅ estimated_arrivial_time updated for ${order_id} → ${formattedTime} (+${mins} mins)`
    );
  } catch (err) {
    console.error("[updateEstimatedArrivalTime ERROR]", err.message);
  }
}

module.exports = { updateEstimatedArrivalTime };
