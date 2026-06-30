const axios = require("axios");

const EXPO_NOTIFICATION_URL = process.env.EXPO_NOTIFICATION_URL;

async function sendUserNotification({ user_id, title, body }) {
  try {
    if (!EXPO_NOTIFICATION_URL) {
      console.warn("⚠️ EXPO_NOTIFICATION_URL not set");
      return;
    }

    await axios.post(
      EXPO_NOTIFICATION_URL,
      {
        user_id,
        title,
        body,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    console.log("📲 Notification sent to user:", user_id);
  } catch (err) {
    console.error("❌ Failed to send notification:", err.message);
  }
}

module.exports = { sendUserNotification };
