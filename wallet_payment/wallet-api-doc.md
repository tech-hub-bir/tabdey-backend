# Wallet Payment Service — API Documentation

**Base URL:** `http://<host>:<PORT>`  
**Default Port:** `3000`  
**Currency:** Ngultrum (Nu.)  
**Timezone:** Asia/Thimphu (UTC+06:00)

All responses are JSON. Successful responses include `"success": true`; errors include `"success": false` and a `"message"` string.

---

## Table of Contents

1. [Health](#1-health)
2. [Wallet Management](#2-wallet-management)
3. [T-PIN Management](#3-t-pin-management)
4. [Transfers](#4-transfers)
5. [Transaction History](#5-transaction-history)
6. [ID Generation](#6-id-generation)
7. [Platform Fee Rules](#7-platform-fee-rules)
8. [Rate Limits](#8-rate-limits)
9. [Error Reference](#9-error-reference)

---

## 1. Health

### GET `/health`
Returns service status and current DB time.

**Response**
```json
{
  "ok": true,
  "service": "wallet_payment",
  "now": "2025-11-10T03:51:10.000Z"
}
```

### GET `/wallet/health`
Lightweight ping (no DB query).

**Response**
```json
{
  "ok": true,
  "service": "wallet_payment",
  "now": "2025-11-10T03:51:10.000Z"
}
```

---

## 2. Wallet Management

Wallet IDs follow the pattern `TD########` (e.g. `TD12345678`). Each user can have only one wallet.

---

### POST `/wallet/create`
Creates a new wallet for a user.

**Request Body**
```json
{
  "user_id": 42,
  "status": "ACTIVE"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | integer | Yes | Must be a positive integer matching an existing user |
| `status` | string | No | `ACTIVE` or `INACTIVE`. Defaults to `ACTIVE` |

**Responses**

`200 OK`
```json
{
  "success": true,
  "message": "Wallet created.",
  "data": {
    "wallet_id": "TD12345678",
    "user_id": 42,
    "amount": "0.00",
    "status": "ACTIVE",
    "created_at": "10 Nov 2025, 09:51:10 AM",
    "updated_at": "10 Nov 2025, 09:51:10 AM"
  }
}
```

`400` — Invalid `user_id` or `status`  
`404` — User not found  
`409` — Wallet already exists for this user

---

### GET `/wallet/getall`
Lists all wallets with optional pagination and filtering.

**Query Parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | integer | `50` | Number of records to return |
| `offset` | integer | `0` | Records to skip |
| `status` | string | `null` | Filter by `ACTIVE` or `INACTIVE` |

**Response `200 OK`**
```json
{
  "success": true,
  "count": 2,
  "data": [ { "wallet_id": "TD12345678", "user_id": 42, "amount": "150.00", "status": "ACTIVE", "created_at": "...", "updated_at": "..." } ]
}
```

---

### GET `/wallet/getone/:wallet_id`
Fetches a single wallet by wallet ID.

**Path Params:** `wallet_id` — e.g. `TD12345678`

**Response `200 OK`**
```json
{
  "success": true,
  "data": {
    "wallet_id": "TD12345678",
    "user_id": 42,
    "amount": "150.00",
    "status": "ACTIVE",
    "created_at": "10 Nov 2025, 09:51:10 AM",
    "updated_at": "10 Nov 2025, 09:51:10 AM"
  }
}
```

`404` — Wallet not found

---

### GET `/wallet/:wallet_id`
Alias for `GET /wallet/getone/:wallet_id`.

---

### GET `/wallet/getbyuser/:user_id`
Fetches the wallet belonging to a user.

**Path Params:** `user_id` — positive integer

**Response `200 OK`** — same shape as `getone`

`400` — Invalid `user_id`  
`404` — Wallet not found for this user

---

### GET `/wallet/:wallet_id/user-name`
Returns the user name associated with a wallet.

**Path Params:** `wallet_id`

**Response `200 OK`**
```json
{
  "success": true,
  "data": {
    "user_id": 42,
    "user_name": "Dorji Tenzin"
  }
}
```

`400` — Invalid wallet ID  
`404` — Wallet or user not found

---

### GET `/wallet/:user_id/has-tpin`
Checks whether the wallet for a given user has a T-PIN set.

**Path Params:** `user_id` — positive integer

**Response `200 OK`**
```json
{
  "success": true,
  "user_id": 42,
  "has_tpin": true
}
```

`400` — Invalid `user_id`  
`404` — Wallet not found

---

### PUT `/wallet/:wallet_id/:status`
Updates a wallet's status.

**Path Params:**
- `wallet_id` — e.g. `TD12345678`
- `status` — `ACTIVE` or `INACTIVE`

**Response `200 OK`**
```json
{
  "success": true,
  "message": "Wallet status updated.",
  "data": { "wallet_id": "TD12345678", "status": "INACTIVE", "..." : "..." }
}
```

`400` — Invalid status  
`404` — Wallet not found

---

### DELETE `/wallet/delete/:wallet_id`
Deletes a wallet.

**Path Params:** `wallet_id`

**Response `200 OK`**
```json
{ "success": true, "message": "Wallet deleted." }
```

`404` — Wallet not found  
`409` — Cannot delete wallet that has existing transactions

---

## 3. T-PIN Management

A T-PIN is a 4-digit numeric code (`0000`–`9999`) required to authorise transfers. It is stored bcrypt-hashed.

---

### POST `/wallet/:wallet_id/t-pin`
Sets the initial T-PIN for a wallet. Fails if a T-PIN is already set.

**Path Params:** `wallet_id`

**Request Body**
```json
{ "t_pin": "1234" }
```

**Response `200 OK`**
```json
{
  "success": true,
  "message": "T-PIN set successfully.",
  "data": { "wallet_id": "TD12345678", "..." : "..." }
}
```

`400` — Invalid wallet ID or T-PIN format  
`404` — Wallet not found  
`409` — T-PIN already set (use PATCH to change it)

---

### PATCH `/wallet/:wallet_id/t-pin`
Changes an existing T-PIN. Requires the current PIN to be provided.

**Path Params:** `wallet_id`

**Request Body**
```json
{
  "old_t_pin": "1234",
  "new_t_pin": "5678"
}
```

**Response `200 OK`**
```json
{
  "success": true,
  "message": "T-PIN changed successfully.",
  "data": { "..." : "..." }
}
```

`400` — Format error or old and new PIN are the same  
`401` — Old T-PIN is incorrect  
`404` — Wallet not found  
`409` — T-PIN not yet set (use POST to set it first)

---

### POST `/wallet/:wallet_id/forgot-tpin`
Sends a 6-digit OTP to the user's registered **email address** to reset the T-PIN. OTP is valid for **5 minutes**. Requests are rate-limited to one per 30 seconds per wallet.

**Path Params:** `wallet_id`

**Response `200 OK`**
```json
{
  "success": true,
  "message": "OTP has been sent to your registered email address. It is valid for 5 minutes."
}
```

`400` — Invalid wallet ID or invalid email on file  
`404` — Wallet or user email not found  
`429` — Please wait before requesting another OTP

---

### POST `/wallet/:wallet_id/forgot-tpin/verify`
Verifies the email OTP and sets a new T-PIN.

**Path Params:** `wallet_id`

**Request Body**
```json
{
  "otp": "839201",
  "new_t_pin": "5678"
}
```

**Response `200 OK`**
```json
{
  "success": true,
  "message": "T-PIN reset successfully.",
  "data": { "..." : "..." }
}
```

`400` — Invalid OTP or T-PIN format  
`404` — Wallet not found  
`410` — OTP expired or not found

---

### POST `/wallet/:wallet_id/forgot-tpin-sms`
Sends a 6-digit OTP to the user's registered **phone number** (Bhutan +975) to reset the T-PIN. OTP is valid for **5 minutes**.

**Path Params:** `wallet_id`

**Response `200 OK`**
```json
{
  "success": true,
  "message": "OTP has been sent to your registered phone number. It is valid for 10 minutes."
}
```

`400` — Invalid wallet ID or phone number  
`404` — Wallet or user phone not found

---

### POST `/wallet/:wallet_id/forgot-tpin-sms/verify`
Verifies the SMS OTP and sets a new T-PIN.

**Path Params:** `wallet_id`

**Request Body**
```json
{
  "otp": "839201",
  "new_t_pin": "5678"
}
```

**Response `200 OK`**
```json
{
  "success": true,
  "message": "T-PIN reset successfully.",
  "data": { "..." : "..." }
}
```

`400` — Invalid OTP or T-PIN format  
`404` — Wallet not found  
`410` — OTP expired or not found

---

## 4. Transfers

---

### POST `/wallet/transfer`
Transfers Nu. from one user wallet to another. Either a valid T-PIN **or** biometric approval is required.

Every transfer creates two ledger rows linked by a `journal_code`: a `DR` on the sender and a `CR` on the recipient. Push notifications are sent to both parties.

**Rate limit:** 30 requests per 24 hours per IP.

**Request Body**
```json
{
  "sender_wallet_id": "TD12345678",
  "recipient_wallet_id": "TD87654321",
  "amount": 250.00,
  "note": "Lunch split",
  "t_pin": "1234",
  "biometric": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sender_wallet_id` | string | Yes | Must match `TD########` pattern |
| `recipient_wallet_id` | string | Yes | Must match `TD########` pattern, must differ from sender |
| `amount` | number | Yes | Positive number in Nu. |
| `note` | string | No | Optional transfer memo |
| `t_pin` | string | Yes* | 4-digit PIN. Required unless `biometric` is true |
| `biometric` | boolean | No | Pass `true` to skip T-PIN verification |

**Response `200 OK`**
```json
{
  "success": true,
  "message": "Wallet transfer successful.",
  "receipt": {
    "amount": "Nu. 250.00",
    "journal_no": "JRN...",
    "transaction_id": "TNX...",
    "from_account": "TD*****78",
    "to_account": "TD*****21",
    "purpose": "Lunch split",
    "date": "10 Nov 2025",
    "time": "09:51:10 AM",
    "biometric": false
  }
}
```

`400` — Invalid wallet IDs, amount, or T-PIN format  
`400` — Insufficient balance  
`401` — Invalid T-PIN  
`403` — Sender or recipient wallet is not ACTIVE  
`404` — Sender or recipient wallet not found  
`409` — T-PIN not set for sender wallet

---

### POST `/wallet/admin/tip`
Transfers Nu. from an admin wallet to a user (driver) wallet. Records the action in `admin_logs` and marks pending driver ratings as paid.

The admin must have role `admin` or `super admin` in the `users` table. T-PIN verification is always required for admin wallets.

**Request Body**
```json
{
  "admin_name": "Karma Admin",
  "admin_wallet_id": "TD00000001",
  "user_wallet_id": "TD12345678",
  "amount": 500.00,
  "note": "Weekly tip payout",
  "t_pin": "1234"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `admin_name` | string | Yes | Must match a user with role `admin` or `super admin` |
| `admin_wallet_id` | string | Yes | Admin's wallet ID |
| `user_wallet_id` | string | Yes | Recipient driver's wallet ID |
| `amount` | number | Yes | Positive number in Nu. |
| `note` | string | No | Optional memo |
| `t_pin` | string | Yes | Admin wallet T-PIN (4 digits) |

**Response `200 OK`**
```json
{
  "success": true,
  "message": "Tip transferred successfully.",
  "data": {
    "ok": true,
    "journal_code": "JRN...",
    "amount": "500.00",
    "note": "Weekly tip payout",
    "admin_verified": {
      "user_id": 1,
      "user_name": "Karma Admin",
      "role": "admin"
    },
    "from": {
      "wallet_id": "TD00000001",
      "user_id": 1,
      "balance": "4500.00"
    },
    "to": {
      "wallet_id": "TD12345678",
      "user_id": 42,
      "balance": "650.00"
    },
    "transactions": {
      "admin_dr": "TNX...",
      "user_cr": "TNX..."
    }
  }
}
```

`400` — Invalid fields or amount  
`401` — Invalid T-PIN  
`400` — Admin wallet has no T-PIN or is not ACTIVE  
`403` — Admin not found or does not have the required role  
`404` — Admin or user wallet not found  
`409` — Insufficient admin wallet balance

---

## 5. Transaction History

All history endpoints support cursor-based pagination and filtering.

**Common Query Parameters**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | integer | Records per page (default varies) |
| `cursor` | string | Opaque cursor from previous response for next page |
| `start` | string | ISO date filter — records from this date |
| `end` | string | ISO date filter — records up to this date |
| `direction` | string | `CR` or `DR` |
| `journal` | string | Filter by `journal_code` |
| `q` | string | Free-text search |

**Rate limit:** 120 requests per minute (per-wallet and per-user endpoints).

---

### GET `/transactions/wallet/:wallet_id`
Returns paginated transactions for a specific wallet. `direction` is relative to this wallet (CR = money in, DR = money out).

**Response `200 OK`**
```json
{
  "success": true,
  "count": 10,
  "next_cursor": "cursor_token_here",
  "data": [
    {
      "transaction_id": "TNX...",
      "journal_code": "JRN...",
      "direction": "DR",
      "amount": 250.00,
      "wallet_id": "TD12345678",
      "counterparty_wallet_id": "TD87654321",
      "note": "Lunch split",
      "created_at": "2025-11-10T03:51:10.000Z",
      "created_at_local": "10 Nov 2025, 09:51:10 AM"
    }
  ]
}
```

---

### GET `/transactions/user/:user_id`
Returns paginated transactions for the wallet belonging to a given user. Same response shape as `/transactions/wallet/:wallet_id`.

**Path Params:** `user_id` — positive integer

`404` — Wallet not found for this user

---

### GET `/transactions/getall`
Returns all transactions across all wallets (admin use). Response includes raw `tnx_from`, `tnx_to`, and `remark` (CR/DR) fields instead of relative direction.

**Rate limit:** 30 requests per minute.

**Response `200 OK`**
```json
{
  "success": true,
  "count": 5,
  "next_cursor": null,
  "data": [
    {
      "transaction_id": "TNX...",
      "journal_code": "JRN...",
      "tnx_from": "TD00000001",
      "tnx_to": "TD12345678",
      "amount": 500.00,
      "remark": "CR",
      "note": "Weekly tip payout",
      "created_at": "2025-11-10T03:51:10.000Z",
      "created_at_local": "10 Nov 2025, 09:51:10 AM"
    }
  ]
}
```

---

## 6. ID Generation

Internal endpoints used by the transfer flow to produce globally unique, collision-checked transaction and journal IDs.

**Rate limit:** 60 requests per minute.

---

### POST `/ids/transaction`
Generates one or more unique transaction IDs (`TNX...`).

**Request Body**
```json
{ "count": 2 }
```

`count` is optional (default `1`, max `100`).

**Response `200 OK`**
```json
{
  "ok": true,
  "count": 2,
  "data": ["TNX...", "TNX..."]
}
```

---

### POST `/ids/journal`
Generates a single unique journal code (`JRN...`).

**Request Body** — empty `{}`

**Response `200 OK`**
```json
{
  "ok": true,
  "code": "JRN..."
}
```

---

### POST `/ids/both`
Generates a journal code and two transaction IDs in one call. This is what the user transfer flow calls internally.

**Request Body** — empty `{}`

**Response `200 OK`**
```json
{
  "ok": true,
  "data": {
    "transaction_ids": ["TNX...", "TNX..."],
    "journal_code": "JRN..."
  }
}
```

---

## 7. Platform Fee Rules

### GET `/api/platform-fee-rules/percent`
Returns the current platform fee percentage.

**Rate limit:** 240 requests per minute.

**Response `200 OK`**
```json
{
  "success": true,
  "fee_percent_bp": 200,
  "fee_percent": 2
}
```

`fee_percent_bp` is the raw value in basis points (100 bp = 1%).  
`fee_percent` is the rounded integer percentage.

`404` — No platform fee rule configured

---

## 8. Rate Limits

| Endpoint Group | Limit |
|----------------|-------|
| General wallet endpoints (`/wallet/create`, T-PIN, etc.) | 30 req / 2 min |
| `/wallet/transfer` | 30 req / 24 hours |
| `/transactions/wallet/:id`, `/transactions/user/:id` | 120 req / min |
| `/transactions/getall` | 30 req / min |
| `/ids/*` | 60 req / min |
| `/api/platform-fee-rules/percent` | 240 req / min |

When a limit is exceeded the response is `429` with:
```json
{
  "success": false,
  "message": "...",
  "retry_after_seconds": 42
}
```

---

## 9. Error Reference

| HTTP Status | Meaning |
|-------------|---------|
| `400` | Bad request — invalid input, format error, or business rule violation (e.g. insufficient balance) |
| `401` | Unauthorised — T-PIN mismatch |
| `403` | Forbidden — wallet inactive, or caller lacks required role |
| `404` | Resource not found |
| `409` | Conflict — duplicate resource or pre-condition not met |
| `410` | Gone — OTP expired |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

All error responses follow the shape:
```json
{
  "success": false,
  "message": "Human-readable reason."
}
```
