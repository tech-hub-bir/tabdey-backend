// src/workers/notificationWorker.js
import fetch from 'node-fetch'; // Node 18+ has global fetch, but keep for compatibility

// ⚠️ Replace with your actual push API endpoint (currently returns 404)
const PUSH_API_URL = process.env.PUSH_API_URL;

/**
 * Send a push notification to a specific user (non‑blocking, fire‑and‑forget).
 * Errors are logged but do not throw.
 */
export function sendPushNotification({ user_id, title, body, data = {} }) {
  if (!user_id || !title || !body) {
    console.error('[notificationWorker] Missing required fields for push notification');
    return;
  }

  const payload = {
    user_id: Number(user_id), // API expects integer
    title,
    body,
    ...data,
  };

  fetch(PUSH_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[notificationWorker] Push failed (${res.status}): ${text}`);
      } else {
        console.log(`[notificationWorker] Push sent to user ${user_id}: ${title}`);
      }
    })
    .catch((err) => {
      console.error('[notificationWorker] Push error:', err.message);
    });
}

/**
 * Insert an in‑app notification into the `notifications` table.
 * Must be called inside an active transaction (uses provided connection).
 */
export async function sendInAppNotification(conn, { user_id, type, title, message, data = {} }) {
  if (!conn || !user_id || !type || !title || !message) {
    throw new Error('[notificationWorker] Missing required fields for in‑app notification');
  }

  const notificationData = JSON.stringify(data);
  await conn.query(
    `INSERT INTO notifications (user_id, type, title, message, data)
     VALUES (?, ?, ?, ?, ?)`,
    [user_id, type, title, message, notificationData]
  );
}

/**
 * Convenience: send both in‑app and push notifications in one call.
 * In‑app is awaited (part of the transaction), push is fire‑and‑forget.
 */
export async function sendBothNotifications(conn, { user_id, type, title, message, data = {} }) {
  await sendInAppNotification(conn, { user_id, type, title, message, data });
  sendPushNotification({ user_id, title, body: message, data });
}