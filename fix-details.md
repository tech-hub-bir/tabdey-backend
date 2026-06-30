# BFS Wallet Backend – Fix Details

## Problem
Every call to `POST /api/wallet/topup/init` was returning `IM` (Invalid Request Received)
from BFS SECURE, causing a 400/500 error before any bank list was returned.

---

## Root Causes Found (3)

### 1. Wrong Signing Key in Production Pods
**File:** Kubernetes Secret `bfs-wallet-keys` (mounted at `/usr/src/app/keys/`)

The secret contained a **Let's Encrypt SSL certificate** (`backend.tabdhey.bt.key/cer`)
instead of the BFS-registered RSA signing key pair. BFS verifies every request's checksum
using the public key registered with them — signing with the wrong key causes every
request to fail with `IM`.

**Fix:** Updated the `bfs-wallet-keys` Kubernetes secret to contain the correct
RMA-issued key pair (`grab.newedge.bt.key` / `grab.newedge.bt.cer`) under the same
filenames the env vars expect (`backend.tabdhey.bt.key/cer`). Pods restarted to pick
up the new secret.

---

### 2. Wrong Amount Format (`toFixed(1)` → `toFixed(2)`)
**File:** `bfs-wallet-backend/src/services/bfsClient.js` — `sendAR()` and `sendAS()`

BFS spec defines `bfs_txnAmount` as `N 16,2` (2 decimal places). The code was sending
`600.0` instead of `600.00`. BFS normalises the amount to 2 decimal places internally
before verifying the checksum, so the computed checksum never matched.

**Fix:**
```js
// Before
bfs_txnAmount: Number(amount).toFixed(1)

// After
bfs_txnAmount: Number(amount).toFixed(2)
```

---

### 3. Timestamp in Wrong Timezone
**File:** `bfs-wallet-backend/src/services/paymentService.js` — `formatTxnTime()`

BFS spec requires `bfs_benfTxnTime` in **BTT (Bhutan Time, UTC+6)**. The server runs
in UTC, so timestamps were 6 hours behind what BFS expects.

**Fix:**
```js
// Before — used server local time
date.getFullYear() + pad(date.getMonth() + 1) + ...

// After — converts to BTT (UTC+6) before formatting
const btt = new Date(date.getTime() + 6 * 60 * 60 * 1000);
btt.getUTCFullYear() + pad(btt.getUTCMonth() + 1) + ...
```

---

## Additional Fixes (Spec Compliance)

### 4. `bfs_orderNo` Max Length (40 chars)
**File:** `paymentService.js` — `generateOrderNo()`

The BFS spec limits `bfs_orderNo` to 40 characters. The order number is built from
`userId + timestamp(13) + random(3)`. If `userId` is long (e.g. a UUID), the total
can exceed 40 chars.

**Fix:** Prefix capped to 24 characters, keeping total ≤ 40.
```js
const prefix = String(userId || "U").slice(0, 24);
return `${prefix}${ts}${rand}`;
```

### 5. `bfs_paymentDesc` Max Length (30 chars)
**File:** `bfsClient.js` — `sendAR()` and `sendAS()`

BFS spec limits `bfs_paymentDesc` to 30 characters. No truncation was applied, so a
long description from the frontend would fail validation.

**Fix:**
```js
bfs_paymentDesc: (paymentDesc || "Wallet topup").slice(0, 30)
```

---

## Deployment
- Files directly patched into Kubernetes pods via `kubectl cp`
- Kubernetes Secret `bfs-wallet-keys` updated via `kubectl apply`
- Pods restarted via `kubectl rollout restart deployment/bfs-wallet-backend`

**To make permanent:** Push `bfsClient.js` and `paymentService.js` to the `main`
branch on GitHub. The existing CI/CD pipeline (GitHub Actions → Docker Hub → k3s)
will rebuild the image and redeploy automatically.

```bash
cd "/path/to/node_backend"
git add bfs-wallet-backend/src/services/bfsClient.js \
        bfs-wallet-backend/src/services/paymentService.js
git commit -m "fix: BFS amount format, BTT timezone, orderNo length, paymentDesc length"
git push origin main
```
