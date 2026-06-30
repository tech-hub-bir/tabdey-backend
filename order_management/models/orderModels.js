// models/orderModels.js
// ✅ Merge legacy methods + separated modules (controller needs no change)

const legacy = require("./orderModels.legacy");
const { generateOrderId } = require("./orders/helpers");

/* ===================== CRUD (10 separated functions) ===================== */
const create = require("./orders/crud/create");
const findAll = require("./orders/crud/findAll");
const findByBusinessId = require("./orders/crud/findByBusinessId");
const findByOrderIdGrouped = require("./orders/crud/findByOrderIdGrouped");
const findByUserIdForApp = require("./orders/crud/findByUserIdForApp");
const update = require("./orders/crud/update");
const updateStatus = require("./orders/crud/updateStatus");
const del = require("./orders/crud/delete");
const getOrderStatusCountsByBusiness = require("./orders/crud/getOrderStatusCountsByBusiness");
const findByBusinessGroupedByUser = require("./orders/crud/findByBusinessGroupedByUser");

/* ===================== NON-CRUD (new modules used by controller) ===================== */
const {
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,
} = require("./orders/serviceTypeResolver");

const {
  addUserOrderStatusNotification,
  addUserUnavailableItemNotification,
  addUserWalletDebitNotification,
} = require("./orders/orderNotifications");

const {
  awardPointsForCompletedOrder,
  awardPointsForCompletedOrderWithConn,
} = require("./orders/pointsEngine");

const {
  applyUnavailableItemChanges,
} = require("./orders/unavailableItemsProcessor");

const {
  captureOrderFunds,
  captureOrderCODFee,
  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,
  captureOnAccept,
  prefetchTxnIdsBatch,
  computeBusinessSplit,
} = require("./orders/walletCaptureEngine");

const {
  cancelAndArchiveOrder,
  cancelIfStillPending,
  completeAndArchiveDeliveredOrder,
} = require("./orders/orderArchivePipeline");

module.exports = {
  // ✅ keep all old stuff (capture/cancel/archive/notifications/etc.)
  ...legacy,

  // ✅ ensure this exists
  peekNewOrderId: legacy.peekNewOrderId || (() => generateOrderId()),

  // ✅ expose non-crud helpers/pipelines if controller expects them (or for future use)
  getOwnerTypeByBusinessId,
  resolveOrderServiceType,

  addUserOrderStatusNotification,
  addUserUnavailableItemNotification,
  addUserWalletDebitNotification,

  awardPointsForCompletedOrder,
  awardPointsForCompletedOrderWithConn,

  applyUnavailableItemChanges,

  prefetchTxnIdsBatch,
  computeBusinessSplit,
  captureOrderFunds,
  captureOrderCODFee,
  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,
  captureOnAccept,

  cancelAndArchiveOrder,
  cancelIfStillPending,
  completeAndArchiveDeliveredOrder,

  // ✅ override only the 10 you refactored
  create,
  findAll,
  findByBusinessId,
  findByOrderIdGrouped,
  findByUserIdForApp,
  update,
  updateStatus,
  delete: del,
  getOrderStatusCountsByBusiness,
  findByBusinessGroupedByUser,
};
