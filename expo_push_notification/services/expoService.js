// Remove this line:
// const fetch = require("node-fetch");

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";

function isExpoToken(t) {
  return (
    typeof t === "string" &&
    (t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken["))
  );
}

async function sendPushMessages(messages) {
  if (!messages || messages.length === 0) {
    return { success: false, error: "No messages to send" };
  }

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  console.log(`📤 Sending ${messages.length} notifications individually...`);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    try {
      // fetch is now built-in in Node.js 20
      const response = await fetch(EXPO_SEND_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      const json = await response.json();

      results.push({
        to: message.to,
        status: response.status,
        ok: response.ok,
        response: json,
      });

      if (response.ok) {
        successCount++;
        console.log(`✅ [${i + 1}/${messages.length}] Sent successfully`);
      } else {
        failureCount++;
        console.log(
          `❌ [${i + 1}/${messages.length}] Failed: ${json.errors?.[0]?.message || "Unknown error"}`,
        );
      }

      if (i < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`❌ [${i + 1}/${messages.length}] Error:`, error.message);
      results.push({
        to: message.to,
        ok: false,
        error: error.message,
      });
      failureCount++;
    }
  }

  console.log(`\n📊 Summary: ${successCount} sent, ${failureCount} failed`);

  return {
    success: failureCount === 0,
    results,
    total_messages: messages.length,
    success_count: successCount,
    failure_count: failureCount,
  };
}

module.exports = {
  isExpoToken,
  sendPushMessages,
};
