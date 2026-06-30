# User Account Deletion Request API

## Overview

This feature lets users request deletion of their account and all associated data directly from the app. Requests go into a queue that an admin must review and approve before any data is permanently removed. This two-step flow (request → admin approval → deletion) prevents accidental or malicious deletion and satisfies data-deletion compliance obligations (e.g. GDPR, PDPA).

---

## Database Schema Addition

Add the following table to `prisma/schema.prisma`:

```prisma
model account_deletion_requests {
  request_id   BigInt                              @id @default(autoincrement()) @db.UnsignedBigInt
  user_id      BigInt                              @db.UnsignedBigInt
  reason       String?                             @db.Text
  status       account_deletion_requests_status    @default(pending)
  requested_at DateTime                            @default(now()) @db.Timestamp(0)
  resolved_at  DateTime?                           @db.Timestamp(0)
  resolved_by  BigInt?                             @db.UnsignedBigInt
  reject_note  String?                             @db.VarChar(500)
  users        users                               @relation(fields: [user_id], references: [user_id], onDelete: Cascade, map: "fk_adr_user")

  @@index([status, requested_at], map: "idx_adr_status_date")
  @@index([user_id], map: "idx_adr_user")
}

enum account_deletion_requests_status {
  pending
  approved
  rejected
}
```

Also add the reverse relation to the `users` model:
```prisma
account_deletion_requests account_deletion_requests[]
```

---

## API Endpoints

### 1. User — Submit Deletion Request

**`POST /api/user/account-deletion`**

Authenticated users call this to submit a request to have their account and all associated data permanently deleted.

#### Authentication
Bearer JWT token in `Authorization` header (same token used across the app).

#### Rate Limit
3 requests per user per 24 hours.

#### Request Body
```json
{
  "reason": "I no longer use this service."
}
```

| Field    | Type   | Required | Description                              |
|----------|--------|----------|------------------------------------------|
| `reason` | string | No       | Optional explanation from the user (max 1000 chars). |

#### Success Response — `201 Created`
```json
{
  "success": true,
  "message": "Your account deletion request has been submitted. An admin will review it within 7 business days.",
  "data": {
    "request_id": 42,
    "status": "pending",
    "requested_at": "2026-06-08T10:30:00.000Z"
  }
}
```

#### Error Responses

| Status | Condition | Body |
|--------|-----------|------|
| `400` | User already has a pending request | `{ "success": false, "error": "You already have a pending deletion request." }` |
| `401` | Missing or invalid JWT | `{ "success": false, "error": "Unauthorized." }` |
| `429` | Rate limit exceeded | `{ "success": false, "message": "Too many requests." }` |
| `500` | Server error | `{ "success": false, "error": "Internal Server Error" }` |

---

### 2. Admin — List Deletion Requests

**`GET /api/admin/account-deletion-requests`**

Returns all account deletion requests. Supports filtering by status and pagination.

#### Authentication
Bearer JWT + admin/superadmin role (`auth` + `ensureAdmin` middleware).

#### Query Parameters

| Param    | Type   | Default   | Description                                           |
|----------|--------|-----------|-------------------------------------------------------|
| `status` | string | `pending` | Filter by status: `pending`, `approved`, `rejected`, or `all`. |
| `page`   | number | `1`       | Page number (1-based).                                |
| `limit`  | number | `20`      | Items per page (max 100).                             |

#### Success Response — `200 OK`
```json
{
  "success": true,
  "total": 3,
  "page": 1,
  "limit": 20,
  "data": [
    {
      "request_id": 42,
      "user_id": 1001,
      "user_name": "John Doe",
      "email": "john@example.com",
      "phone": "+97512345678",
      "reason": "I no longer use this service.",
      "status": "pending",
      "requested_at": "2026-06-08T10:30:00.000Z",
      "resolved_at": null,
      "resolved_by": null,
      "reject_note": null
    }
  ]
}
```

#### Error Responses

| Status | Condition | Body |
|--------|-----------|------|
| `401` | Missing or invalid JWT | `{ "success": false, "error": "Unauthorized." }` |
| `403` | Not an admin | `{ "success": false, "error": "Forbidden: admin/superadmin required." }` |
| `500` | Server error | `{ "success": false, "error": "Internal Server Error" }` |

---

### 3. Admin — Approve Deletion Request

**`POST /api/admin/account-deletion-requests/:request_id/approve`**

Approves the request and **permanently deletes** the user's account and all associated data. This action is irreversible.

#### Authentication
Bearer JWT + admin/superadmin role.

#### URL Parameters

| Param        | Type   | Description              |
|--------------|--------|--------------------------|
| `request_id` | number | The deletion request ID. |

#### Request Body
_(empty — no body required)_

#### Data Deleted

The following data is permanently removed when a request is approved:

| Data | Table(s) |
|------|----------|
| User account | `users` |
| Device tokens | `all_device_ids`, `user_devices`, `driver_devices` |
| App ratings | `app_ratings` |
| Event bookings | `bookings`, `event_bookings`, `event_seat_holds`, `event_wishlists`, `event_reviews`, `event_review_helpful`, `event_payment_sessions` |
| Event organizer profile | `event_organizers`, `organizer_revenue_share` |
| Food/mart ratings | `food_ratings`, `mart_ratings` |
| Merchant profile | `merchant_business_details`, `merchant_bank_details` |
| Reviews & wishlists | `reviews`, `wishlists` |
| Push notifications | `system_notifications` |
| Verification records | `user_verification` |
| Wallet | `wallets`, `wallet_ledger`, `wallet_transactions`, `wallet_holds` |
| Driver profile | `drivers` |
| Admin log entries | `admin_logs` (user_id set to NULL, entries retained for audit) |

#### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "User account and all associated data have been permanently deleted.",
  "data": {
    "request_id": 42,
    "deleted_user_id": 1001,
    "resolved_at": "2026-06-08T11:00:00.000Z"
  }
}
```

#### Error Responses

| Status | Condition | Body |
|--------|-----------|------|
| `400` | Request already resolved | `{ "success": false, "error": "This request has already been resolved." }` |
| `401` | Missing or invalid JWT | `{ "success": false, "error": "Unauthorized." }` |
| `403` | Not an admin | `{ "success": false, "error": "Forbidden: admin/superadmin required." }` |
| `404` | Request not found | `{ "success": false, "error": "Deletion request not found." }` |
| `500` | Server error | `{ "success": false, "error": "Internal Server Error" }` |

---

### 4. Admin — Reject Deletion Request

**`POST /api/admin/account-deletion-requests/:request_id/reject`**

Rejects the request. The user's account is not affected.

#### Authentication
Bearer JWT + admin/superadmin role.

#### URL Parameters

| Param        | Type   | Description              |
|--------------|--------|--------------------------|
| `request_id` | number | The deletion request ID. |

#### Request Body
```json
{
  "reject_note": "Unable to process: account has an active subscription."
}
```

| Field         | Type   | Required | Description                                 |
|---------------|--------|----------|---------------------------------------------|
| `reject_note` | string | Yes      | Reason for rejection shown to the user (max 500 chars). |

#### Success Response — `200 OK`
```json
{
  "success": true,
  "message": "Deletion request rejected.",
  "data": {
    "request_id": 42,
    "status": "rejected",
    "reject_note": "Unable to process: account has an active subscription.",
    "resolved_at": "2026-06-08T11:05:00.000Z"
  }
}
```

#### Error Responses

| Status | Condition | Body |
|--------|-----------|------|
| `400` | `reject_note` missing or blank | `{ "success": false, "error": "reject_note is required." }` |
| `400` | Request already resolved | `{ "success": false, "error": "This request has already been resolved." }` |
| `401` | Missing or invalid JWT | `{ "success": false, "error": "Unauthorized." }` |
| `403` | Not an admin | `{ "success": false, "error": "Forbidden: admin/superadmin required." }` |
| `404` | Request not found | `{ "success": false, "error": "Deletion request not found." }` |
| `500` | Server error | `{ "success": false, "error": "Internal Server Error" }` |

---

### 5. User — Check Deletion Request Status

**`GET /api/user/account-deletion`**

Allows a user to check the current status of their own deletion request.

#### Authentication
Bearer JWT token.

#### Success Response — `200 OK` (request exists)
```json
{
  "success": true,
  "data": {
    "request_id": 42,
    "status": "pending",
    "requested_at": "2026-06-08T10:30:00.000Z",
    "resolved_at": null,
    "reject_note": null
  }
}
```

#### Success Response — `200 OK` (no request)
```json
{
  "success": true,
  "data": null
}
```

---

## Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `admin/models/accountDeletionModel.js` | DB queries for deletion requests and cascaded user deletion |
| `admin/controllers/accountDeletionController.js` | Request handlers for all 5 endpoints |
| `admin/routes/accountDeletionRoutes.js` | Route definitions with auth and rate-limit middleware |

### Modified files

| File | Change |
|------|--------|
| `admin/server.js` | Mount `accountDeletionRoutes` under `/api/admin` and `/api/user` |
| `prisma/schema.prisma` | Add `account_deletion_requests` model |

---

## Implementation Notes

- The approve action should be wrapped in a Prisma transaction so partial failures don't leave the DB in an inconsistent state. Delete child records first (or rely on `onDelete: Cascade`), then delete the `users` row last.
- `admin_logs` rows reference `user_id` with a nullable FK — set them to `NULL` (not deleted) so the audit trail is preserved.
- `wallet_ledger` and `wallet_transactions` are financial records; confirm with compliance whether these should be anonymised rather than deleted before proceeding.
- Only one `pending` request is allowed per user at a time. Check before inserting.
- The deletion request record itself (`account_deletion_requests`) is retained after approval for audit purposes (the user row is gone but the log remains).
