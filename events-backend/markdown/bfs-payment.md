# BFS Wallet Backend — API Reference

Base URL: `http://localhost:<PORT>`

All successful responses share the envelope `{ ok: true, data: ... }`.  
All error responses share the envelope `{ ok: false, error: "<message>" }`.

---

## Health Check

### `GET /`

**Response**
```json
{ "ok": true, "message": "BFS wallet backend up" }
```

---

## Wallet Top-up (BFS Payment Gateway)

### 1. Init Top-up

**`POST /api/wallet/topup/init`**

Starts a top-up transaction with BFS (Authorization Request). Returns the BFS transaction ID and the list of banks.

**Request Body**
```json
{
  "userId": 42,
  "amount": 500,
  "email": "user@example.com",
  "description": "Wallet topup"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | number | Yes | Internal user ID |
| `amount` | number | Yes | Amount in Nu (must be > 0) |
| `email` | string | Yes | Remitter email |
| `description` | string | No | Payment description (default: "Wallet topup") |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "orderNo": "421745678901234567",
    "bfsTxnId": "BFS20240001",
    "bankList": [
      { "id": "1010", "name": "BANK OF BHUTAN LIMITED", "status": "A" },
      { "id": "1020", "name": "Bhutan National Bank Limited", "status": "A" }
    ]
  }
}
```

**Error Response**
```json
{ "ok": false, "error": "Invalid amount" }
```

---

### 2. Account Enquiry

**`POST /api/wallet/topup/account-enquiry`**

Verifies the remitter's bank account (Account Enquiry). Must be called after `/init`.

**Request Body**
```json
{
  "orderNo": "421745678901234567",
  "remitterBankId": "1010",
  "remitterAccNo": "10210123456"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `orderNo` | string | Yes | Order number from `/init` |
| `remitterBankId` | string | Yes | Bank ID selected from bankList |
| `remitterAccNo` | string | Yes | Remitter's bank account number |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "orderNo": "421745678901234567",
    "status": "ACCOUNT_VERIFIED",
    "responseCode": "00",
    "responseDesc": "Account verified successfully"
  }
}
```

**Error Response**
```json
{ "ok": false, "error": "Account verification failed." }
```

---

### 3. Debit with OTP

**`POST /api/wallet/topup/debit`**

Debits the remitter's account using OTP and credits the user's wallet on success.

**Request Body**
```json
{
  "orderNo": "421745678901234567",
  "otp": "123456"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `orderNo` | string | Yes | Order number from `/init` |
| `otp` | string | Yes | OTP sent to the remitter |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "orderNo": "421745678901234567",
    "bfsTxnId": "BFS20240001",
    "status": "SUCCESS",
    "code": "00",
    "message": "Payment successful.",
    "amount": 500
  }
}
```

| `status` | Meaning |
|---|---|
| `SUCCESS` | BFS debit auth code `00` |
| `FAILED` | Any other code |

BFS response codes:

| Code | Message |
|---|---|
| `00` | Payment successful |
| `51` | Insufficient funds |
| `BC` | Payment cancelled by customer |
| `IM` | Invalid request received |
| `45` | Duplicate order number |
| `TO` | Transaction timed out |

---

### 4. Status Check

**`GET /api/wallet/topup/status/:orderNo`**

Fetches the current payment status from BFS.

**Path Parameter**

| Param | Description |
|---|---|
| `orderNo` | Order number from `/init` |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "orderNo": "421745678901234567",
    "status": "SUCCESS",
    "code": "00",
    "message": "Payment successful.",
    "from": "BFS"
  }
}
```

---

## Withdrawals — User APIs

User identity is resolved in priority order: `body.user_id` → `query.user_id` → `x-user-id` header.

### 5. Create Withdrawal

**`POST /api/wallet/withdrawals`**

Submits a new withdrawal request. Immediately debits the wallet (funds are held). Idempotent — duplicate requests with the same `Idempotency-Key` return the existing record.

**Headers**

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | Yes | Unique key per request to prevent duplicates |

**Request Body**
```json
{
  "user_id": 42,
  "amount": 1000.50,
  "bank": {
    "bank_code": "BOB",
    "bank_name": "Bank of Bhutan",
    "account_no": "10210123456",
    "account_name": "John Doe"
  },
  "user_note": "Monthly savings withdrawal"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `user_id` | number | Yes | User ID (or via header/query) |
| `amount` | number | Yes | Amount in Nu (min 1.00, max 500000.00) |
| `bank.bank_code` | string | Yes | Bank code |
| `bank.bank_name` | string | Yes | Bank name |
| `bank.account_no` | string | Yes | Account number (min 6 chars) |
| `bank.account_name` | string | Yes | Account holder name |
| `user_note` | string | No | Optional note from user (max 255 chars) |

**Response `200`** — returns the `withdrawal_requests` DB row
```json
{
  "ok": true,
  "data": {
    "request_id": "wd_abc123",
    "user_id": 42,
    "amount": "1000.50",
    "currency": "BTN",
    "bank_code": "BOB",
    "bank_name": "Bank of Bhutan",
    "account_no": "10210123456",
    "account_name": "John Doe",
    "status": "HELD",
    "user_note": "Monthly savings withdrawal",
    "admin_note": null,
    "idempotency_key": "key-uuid-here",
    "reviewed_by": null,
    "reviewed_at": null,
    "approved_by": null,
    "approved_at": null,
    "paid_by": null,
    "paid_at": null,
    "bank_reference": null,
    "created_at": "2024-01-01T10:00:00.000Z",
    "updated_at": "2024-01-01T10:00:00.000Z"
  }
}
```

---

### 6. List My Withdrawals

**`GET /api/wallet/withdrawals`**

Returns the authenticated user's withdrawal requests.

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `user_id` | number | Yes* | User ID (*or via header) |
| `status` | string | No | Filter by status: `HELD`, `NEEDS_INFO`, `APPROVED`, `REJECTED`, `CANCELLED`, `PAID`, `FAILED` |
| `limit` | number | No | Page size (default 50) |
| `offset` | number | No | Pagination offset (default 0) |

**Response `200`**
```json
{
  "ok": true,
  "data": [
    {
      "request_id": "wd_abc123",
      "user_id": 42,
      "amount": "1000.50",
      "currency": "BTN",
      "bank_code": "BOB",
      "bank_name": "Bank of Bhutan",
      "account_no": "10210123456",
      "account_name": "John Doe",
      "status": "HELD",
      "user_note": null,
      "admin_note": null,
      "created_at": "2024-01-01T10:00:00.000Z",
      "updated_at": "2024-01-01T10:00:00.000Z"
    }
  ]
}
```

---

### 7. Cancel Withdrawal

**`POST /api/wallet/withdrawals/:id/cancel`**

Cancels a withdrawal in `HELD` or `NEEDS_INFO` status. Refunds the held amount back to the wallet.

**Path Parameter**

| Param | Description |
|---|---|
| `id` | `request_id` of the withdrawal |

**Request Body**
```json
{
  "user_id": 42
}
```

**Response `200`** — returns updated `withdrawal_requests` row with `status: "CANCELLED"`

**Error Response**
```json
{ "ok": false, "error": "Cannot cancel at this stage" }
```

---

## Withdrawals — Admin APIs

Admin identity is resolved in priority order: `x-admin-id` header → `body.admin_id` → `query.admin_id`.

### 8. Admin List Withdrawals

**`GET /api/admin/withdrawals`**

Lists all withdrawal requests with optional filters.

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `status` | string | Filter by status |
| `user_id` | number | Filter by user |
| `from` | string | Filter by `created_at >=` (ISO date) |
| `to` | string | Filter by `created_at <=` (ISO date) |
| `limit` | number | Page size (default 50) |
| `offset` | number | Pagination offset (default 0) |

**Response `200`**
```json
{
  "ok": true,
  "data": [ /* array of withdrawal_requests rows */ ]
}
```

---

### 9. Admin — Needs Info

**`POST /api/admin/withdrawals/:id/needs-info`**

Moves a `HELD` request to `NEEDS_INFO` (request more details from user).

**Headers / Body — Admin Identity**

| Field | Where | Description |
|---|---|---|
| `x-admin-id` | Header | Admin user ID |
| `admin_id` | Body | Alternative to header |

**Request Body**
```json
{
  "admin_id": 1,
  "note": "Please provide a copy of your ID"
}
```

**Response `200`** — returns updated row with `status: "NEEDS_INFO"`

---

### 10. Admin — Approve

**`POST /api/admin/withdrawals/:id/approve`**

Approves a `HELD` or `NEEDS_INFO` withdrawal.

**Request Body**
```json
{
  "admin_id": 1,
  "admin_note": "Verified and approved"
}
```

**Response `200`** — returns updated row with `status: "APPROVED"`

---

### 11. Admin — Reject

**`POST /api/admin/withdrawals/:id/reject`**

Rejects a `HELD` or `NEEDS_INFO` withdrawal. Refunds the held amount to the user's wallet.

**Request Body**
```json
{
  "admin_id": 1,
  "reason": "Suspicious activity"
}
```

**Response `200`** — returns updated row with `status: "REJECTED"`

---

### 12. Admin — Mark Paid

**`POST /api/admin/withdrawals/:id/mark-paid`**

Marks an `APPROVED` withdrawal as `PAID` after the manual bank transfer is done.

**Request Body**
```json
{
  "admin_id": 1,
  "bank_reference": "TXN-BANK-20240101-001",
  "note": "Transferred via RTGS"
}
```

| Field | Required | Description |
|---|---|---|
| `bank_reference` | Yes | Bank transfer reference number |
| `note` | No | Optional note |

**Response `200`** — returns updated row with `status: "PAID"`

**Error Response**
```json
{ "ok": false, "error": "Only APPROVED can be marked PAID" }
```

---

### 13. Admin — Fail

**`POST /api/admin/withdrawals/:id/fail`**

Marks a `HELD`, `NEEDS_INFO`, or `APPROVED` withdrawal as `FAILED`. Refunds the held amount to the user's wallet.

**Request Body**
```json
{
  "admin_id": 1,
  "reason": "Bank transfer failed"
}
```

**Response `200`** — returns updated row with `status: "FAILED"`

---

## Withdrawal Status Flow

```
HELD ──► NEEDS_INFO ──► APPROVED ──► PAID
  │           │               │
  │           │               └──► FAILED (refund)
  │           └──► REJECTED (refund)
  └──► CANCELLED (user, refund)
  └──► REJECTED (admin, refund)
  └──► FAILED (admin, refund)
```

---

## RMA / BFS Logs

### 14. List RMA Logs

**`GET /api/rma/logs`**

Returns paginated BFS raw request/response logs.

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `orderNo` | string | Filter by order number |
| `bfsTxnId` | string | Filter by BFS transaction ID |
| `tag` | string | Filter by tag (e.g. `AR-RC`, `AE-EC`, `DR-AC`, `AS-AC`) |
| `page` | number | Page number (default 1) |
| `limit` | number | Page size (default 50, max 200) |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 1,
        "order_no": "421745678901234567",
        "bfs_txn_id": "BFS20240001",
        "tag": "AR-RC",
        "raw_log": "...",
        "created_at": "2024-01-01T10:00:00.000Z"
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 50,
    "pages": 1
  }
}
```

---

### 15. Get Single RMA Log

**`GET /api/rma/logs/:id`**

Returns a single RMA log entry by its numeric ID.

**Path Parameter**

| Param | Description |
|---|---|
| `id` | Numeric log ID |

**Response `200`**
```json
{
  "ok": true,
  "data": {
    "id": 1,
    "order_no": "421745678901234567",
    "bfs_txn_id": "BFS20240001",
    "tag": "AR-RC",
    "raw_log": "...",
    "created_at": "2024-01-01T10:00:00.000Z"
  }
}
```

**Response `404`**
```json
{ "ok": false, "message": "Log not found" }
```

---

## Debug

### 16. Verify JWT

**`GET /api/debug/jwt`**

Decodes and verifies a JWT bearer token.

**Headers**

| Header | Description |
|---|---|
| `Authorization` | `Bearer <token>` |

**Response `200`**
```json
{
  "ok": true,
  "payload": {
    "sub": "42",
    "iat": 1700000000,
    "exp": 1700086400
  }
}
```

**Response `401`**
```json
{ "ok": false, "error": "JWT verify failed", "detail": "invalid signature" }
```
