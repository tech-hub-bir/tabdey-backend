// orders/pointsEngine.js
const db = require("../../config/db");
const { insertUserNotification } = require("./orderNotifications");

const fmtNu = (n) => Number(n || 0).toFixed(2);

async function getActivePointRule(conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT point_id, min_amount_per_point, point_to_award, is_active
      FROM point_system
     WHERE is_active = 1
     ORDER BY created_at DESC
     LIMIT 1
    `,
  );
  return rows[0] || null;
}

async function hasPointsAwardNotification(order_id, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT id
      FROM notifications
     WHERE type = 'points_awarded'
       AND JSON_EXTRACT(data, '$.order_id') = ?
     LIMIT 1
    `,
    [order_id],
  );
  return rows.length > 0;
}

async function awardPointsForCompletedOrder(order_id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.query(
      `SELECT user_id, total_amount, status
         FROM orders
        WHERE order_id = ?
        LIMIT 1`,
      [order_id],
    );

    if (!order) {
      await conn.rollback();
      return { awarded: false, reason: "order_not_found" };
    }

    let status = String(order.status || "").toUpperCase();
    if (status === "COMPLETED") status = "DELIVERED";
    if (status !== "DELIVERED") {
      await conn.rollback();
      return { awarded: false, reason: "not_delivered" };
    }

    if (await hasPointsAwardNotification(order_id, conn)) {
      await conn.rollback();
      return { awarded: false, reason: "already_awarded" };
    }

    const rule = await getActivePointRule(conn);
    if (!rule) {
      await conn.rollback();
      return { awarded: false, reason: "no_active_rule" };
    }

    const totalAmount = Number(order.total_amount || 0);
    const minAmount = Number(rule.min_amount_per_point || 0);
    const perPoint = Number(rule.point_to_award || 0);

    if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
      await conn.rollback();
      return { awarded: false, reason: "invalid_rule_or_amount" };
    }

    const units = Math.floor(totalAmount / minAmount);
    const points = units * perPoint;
    if (points <= 0) {
      await conn.rollback();
      return { awarded: false, reason: "computed_zero" };
    }

    await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
      points,
      order.user_id,
    ]);

    const msg = `You earned ${points} points for order ${order_id} (Nu. ${fmtNu(totalAmount)} spent).`;

    await insertUserNotification(conn, {
      user_id: order.user_id,
      type: "points_awarded",
      title: "Points earned",
      message: msg,
      data: {
        order_id,
        points_awarded: points,
        total_amount: totalAmount,
        min_amount_per_point: Number(minAmount),
        point_to_award: Number(perPoint),
        rule_id: rule.point_id,
      },
      status: "unread",
    });

    await conn.commit();
    return {
      awarded: true,
      points_awarded: points,
      total_amount: totalAmount,
      rule_id: rule.point_id,
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

async function awardPointsForCompletedOrderWithConn(conn, order_id) {
  const [[order]] = await conn.query(
    `SELECT user_id, total_amount, status
       FROM orders
      WHERE order_id = ?
      LIMIT 1`,
    [order_id],
  );
  if (!order) return { awarded: false, reason: "order_not_found" };

  let status = String(order.status || "").toUpperCase();
  if (status === "COMPLETED") status = "DELIVERED";
  if (status !== "DELIVERED")
    return { awarded: false, reason: "not_delivered" };

  if (await hasPointsAwardNotification(order_id, conn))
    return { awarded: false, reason: "already_awarded" };

  const rule = await getActivePointRule(conn);
  if (!rule) return { awarded: false, reason: "no_active_rule" };

  const totalAmount = Number(order.total_amount || 0);
  const minAmount = Number(rule.min_amount_per_point || 0);
  const perPoint = Number(rule.point_to_award || 0);

  if (!(totalAmount > 0 && minAmount > 0 && perPoint > 0)) {
    return { awarded: false, reason: "invalid_rule_or_amount" };
  }

  const units = Math.floor(totalAmount / minAmount);
  const points = units * perPoint;
  if (points <= 0) return { awarded: false, reason: "computed_zero" };

  await conn.query(`UPDATE users SET points = points + ? WHERE user_id = ?`, [
    points,
    order.user_id,
  ]);

  const msg = `You earned ${points} points for order ${order_id} (Nu. ${fmtNu(totalAmount)} spent).`;

  await insertUserNotification(conn, {
    user_id: order.user_id,
    type: "points_awarded",
    title: "Points earned",
    message: msg,
    data: {
      order_id,
      points_awarded: points,
      total_amount: totalAmount,
      min_amount_per_point: Number(minAmount),
      point_to_award: Number(perPoint),
      rule_id: rule.point_id,
    },
    status: "unread",
  });

  return {
    awarded: true,
    points_awarded: points,
    total_amount: totalAmount,
    rule_id: rule.point_id,
  };
}

module.exports = {
  awardPointsForCompletedOrder,
  awardPointsForCompletedOrderWithConn,
};
