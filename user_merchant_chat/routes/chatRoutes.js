// File: routes/chatRoutes.js
const express = require("express");
const router = express.Router();

const chat = require("../controllers/chatController");
const upload = require("../middlewares/upload");

function jsonUnlessMultipart() {
  const jsonParser = express.json();

  return function jsonUnlessMultipartMiddleware(req, res, next) {
    const ct = String(req.headers["content-type"] || "").toLowerCase();

    if (ct.includes("multipart/form-data")) {
      return next();
    }

    return jsonParser(req, res, next);
  };
}

function maybeUploadSingle(field) {
  return function maybeUploadSingleMiddleware(req, res, next) {
    const ct = String(req.headers["content-type"] || "").toLowerCase();

    if (!ct.includes("multipart/form-data")) {
      return next();
    }

    if (!upload || typeof upload.single !== "function") {
      return res.status(500).json({
        success: false,
        message: "Upload middleware is not configured correctly.",
      });
    }

    const middleware = upload.single(field);

    if (typeof middleware !== "function") {
      return res.status(500).json({
        success: false,
        message: "Upload middleware did not return a function.",
      });
    }

    return middleware(req, res, next);
  };
}

/* ---------------- controller safety check ---------------- */

const requiredHandlers = [
  "getOrCreateConversationForOrder",
  "listConversations",
  "getMessages",
  "sendMessage",
  "markRead",
];

for (const handlerName of requiredHandlers) {
  if (typeof chat[handlerName] !== "function") {
    throw new Error(
      `chatController.${handlerName} is not exported as a function.`,
    );
  }
}

/* ---------------- routes ---------------- */

// create/get conversation for order
router.post(
  "/conversations/order/:orderId",
  express.json(),
  chat.getOrCreateConversationForOrder,
);

// ✅ LIST CONVERSATIONS
// - CUSTOMER uses x-user-id
// - MERCHANT uses x-business-id or ?business_id=
router.get("/conversations", chat.listConversations);

// get messages
router.get("/messages/:conversationId", chat.getMessages);

// send message: supports JSON text or multipart chat_image
router.post(
  "/messages/:conversationId",
  jsonUnlessMultipart(),
  maybeUploadSingle("chat_image"),
  chat.sendMessage,
);

// mark read
router.post("/read/:conversationId", express.json(), chat.markRead);

module.exports = router;