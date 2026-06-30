// src/services/push.js
import { Expo } from 'expo-server-sdk';

// Create a single instance of the Expo client
let expo = new Expo();

/**
 * Send push notifications to multiple Expo tokens.
 * @param {string[]} pushTokens - Array of Expo push tokens.
 * @param {Object} message - The notification payload.
 * @param {string} [message.title] - Notification title.
 * @param {string} [message.body] - Notification body.
 * @param {Object} [message.data] - Custom data to send with the notification.
 * @param {string} [message.sound='default'] - Sound to play.
 * @returns {Promise<void>}
 */
export async function sendPushToTokens(pushTokens, message = {}) {
  if (!pushTokens || pushTokens.length === 0) {
    return;
  }

  // Build messages for each valid token
  const messages = [];
  for (const token of pushTokens) {
    if (!Expo.isExpoPushToken(token)) {
      console.warn(`[push] Invalid Expo push token: ${token}`);
      continue;
    }
    messages.push({
      to: token,
      sound: message.sound || 'default',
      title: message.title,
      body: message.body,
      data: message.data,
    });
  }

  if (messages.length === 0) {
    return;
  }

  // Expo SDK automatically batches up to 100 messages per request
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log(`[push] Sent ${ticketChunk.length} notifications`);
      // Optionally handle receipts (e.g., log errors, delete invalid tokens)
      // For a production system, you would want to store the tickets and later
      // check receipts to clean up invalid tokens.
    } catch (error) {
      console.error('[push] Error sending notification chunk:', error);
    }
  }
}

/**
 * Send a push notification to a single token (convenience wrapper).
 * @param {string} pushToken - Single Expo push token.
 * @param {Object} message - Notification payload.
 */
export async function sendPushToToken(pushToken, message) {
  if (!pushToken) return;
  return sendPushToTokens([pushToken], message);
}