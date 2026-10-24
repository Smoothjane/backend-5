# API reference

Base URL: `http://localhost:3000/api/v1`. Send JSON with
`Content-Type: application/json`. Authenticated routes need
`Authorization: Bearer <token>` from `/auth/login` or `/auth/register`.

**Envelope.** Success responses look like `{ "success": true, "data": ... }`.
Errors look like `{ "success": false, "error": "message", "details"?: [{ "field", "message" }] }`.
Paginated lists add `"pagination": { "page", "limit", "total", "pages" }`
and accept `?page=` and `?limit=` (default 20, max 100, or 200 for products).

**Money.** Store amounts are integer **cents** (`priceCents`, `totalCents`).
Stellar amounts are 7-decimal **strings** (`"12.5000000"`).

**Roles.** `admin` > `manager` > `cashier`. The table lists the minimum role
for each route; "public" means no token is needed.

| Status | Meaning |
|---|---|
| 400 | Validation failed (see `details`) |
| 401 | Missing, invalid or expired token; wrong credentials |
| 402 | A Stellar payment could not be verified on-chain |
| 403 | Your role cannot do this |
| 404 | Not found |
| 409 | Conflict: duplicate SKU or email, insufficient stock, wrong sale status, reused transaction hash |
| 429 | Rate limited |
| 503 | Stellar checkout not configured |

## Auth and staff

| Method | Path | Role | Body / notes |
|---|---|---|---|
| POST | `/auth/register` | public | `{ name, email, password (8+) }`. The first user becomes `admin`; later users are `cashier`. Returns `{ user, token }`. |
| POST | `/auth/login` | public | `{ email, password }`. Returns `{ user, token }`. Rate limited to 20 per 15 minutes per IP. |
| GET | `/auth/me` | any | Current user |
| PATCH | `/auth/me` | any | `{ name?, currentPassword?, newPassword? }`. A new password requires the current one. |
| GET | `/auth/2fa` | any | `{ enabled, recoveryCodesLeft }` |
| POST | `/auth/2fa/setup` | any | Starts enrolment: `{ secret, otpauthUrl }` to show as a QR. 2FA is not on yet. |
| POST | `/auth/2fa/enable` | any | `{ code }` from the authenticator app. Turns 2FA on and returns 8 one-time `recoveryCodes` (shown once). |
| POST | `/auth/2fa/disable` | any | `{ password, code }` (code may be a recovery code) |
| POST | `/auth/2fa/verify` | public | Second sign-in step: `{ challenge, code }` returns `{ user, token }`. When 2FA is on, `/auth/login` returns `{ twoFactorRequired: true, challenge }` (valid 5 minutes) instead of a token. |
| GET | `/users` | admin | All staff |
| POST | `/users` | admin | `{ name, email, password, role }` |
| PATCH | `/users/:id/role` | admin | `{ role }`. Admins cannot change their own role. |

## Store

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/store` | public | `{ name, currency, taxRateBps, stellar: { network, enabled, merchantPublicKey, asset, assetRate, paymentTtlMinutes, contracts } }` |
| GET | `/store/wallet` | manager | Live balances of the merchant account from Horizon |

## Products

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/products` | public | Filters: `search` (name or SKU), `category`, `lowStock=true`, `includeInactive=true` |
| GET | `/products/catalog` | public | Every active product with only `id, name, sku, category, priceCents, stock, lowStock`, for phones and tablets. Supports `If-None-Match` (304 when unchanged). |
| GET | `/products/categories` | public | Distinct active categories |
| GET | `/products/:id` | public | |
| POST | `/products` | manager | `{ name, sku, priceCents, stock?, category?, description?, lowStockThreshold?, active? }`. SKUs are uppercased and unique. |
| PUT | `/products/:id` | manager | Any subset of the fields above |
| POST | `/products/:id/stock` | manager | `{ delta, reason? }`. Delta is positive to receive stock, negative to write off. Never below zero (409). |
| DELETE | `/products/:id` | manager | Returns `{ outcome: "deleted" }`, or `"archived"` if the product appears on past sales |

Each product includes a computed `lowStock: boolean` (`stock <= lowStockThreshold`).

## Customers

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/customers` | cashier | `search` matches name, email or phone |
| GET | `/customers/:id` | cashier | Includes `stats: { visits, lifetimeCents, lastVisit }` |
| POST | `/customers` | cashier | `{ name, email?, phone?, stellarAddress?, notes? }`. `stellarAddress` must be a valid `G...` key. |
| PUT | `/customers/:id` | cashier | Any subset |
| DELETE | `/customers/:id` | cashier | Past sales are kept and detached from the customer |

## Sales

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/transactions` | cashier | `{ items: [{ productId, quantity }], customerId?, discountCents?, note? }`. Reserves stock atomically and returns the `pending` sale with `items`. |
| GET | `/transactions` | cashier | Filters: `status`, `customerId`, `from`, `to` (`YYYY-MM-DD`), `search` (reference) |
| GET | `/transactions/:id` | cashier | Includes `items` and `payments` |
| POST | `/transactions/:id/receipt/email` | cashier | `{ email? }`. Emails the receipt for a paid or refunded sale to `email`, or the attached customer's address. Returns `202 { queued, to }`; sending happens in the background with retries. |
| POST | `/transactions/:id/void` | cashier | Pending sales only. Releases stock. |
| POST | `/transactions/:id/refund` | manager | Completed sales only. `{ restock = true, reason? }` |

A sale carries `subtotalCents`, `discountCents`, `taxCents` (`TAX_RATE_BPS`,
applied after discount and rounded half up), `totalCents`, `paidCents`, and
`balanceCents`. It becomes `completed` as soon as completed payments cover
the total.

**Example**

```http
POST /api/v1/transactions
{ "items": [{ "productId": "4f6c...", "quantity": 2 }], "discountCents": 100 }
```
```json
{ "success": true, "data": {
  "id": "b1e2...", "reference": "S-000124", "status": "pending",
  "subtotalCents": 840, "discountCents": 100, "taxCents": 0, "totalCents": 740,
  "paidCents": 0, "balanceCents": 740,
  "items": [{ "name": "Flat White", "sku": "COF-FLW", "unitPriceCents": 420, "quantity": 2, "lineTotalCents": 840 }]
} }
```

## Payments

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/payments` | cashier | See below |
| GET | `/payments/transaction/:transactionId` | cashier | All attempts, including `failed` |

```jsonc
// Cash: amount defaults to the balance; change is computed.
{ "transactionId": "...", "method": "cash", "tenderedCents": 2000 }
// Card, optionally partial (split tender).
{ "transactionId": "...", "method": "card", "amountCents": 500 }
// Stellar by hash: verified on Horizon before it counts (402 if not).
{ "transactionId": "...", "method": "stellar", "stellarTxHash": "<64 hex>" }
```

Returns `{ payment, transaction }`. Amounts above the balance are rejected.
For cash, tender more and receive `changeCents`.

## QR checkout (SEP-0007)

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/payments/requests` | cashier | `{ transactionId }`. Returns the open request for the sale, or creates one. |
| GET | `/payments/requests/:id` | cashier | Poll fallback if sockets are unavailable |
| POST | `/payments/requests/:id/verify` | cashier | `{ txHash }`. Manual check: memo, asset and amount must all match. |
| POST | `/payments/requests/:id/cancel` | cashier | Leaves the sale pending for another payment method |

A request returns
`{ id, transactionId, destination, assetCode, assetIssuer, amount, memo, uri, status, txHash, payer, expiresAt, paidAt }`.
Status runs `pending`, then `paid`, `expired` or `cancelled`. See
[stellar-payments.md](stellar-payments.md).

## Search

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/search?q=&types=&limit=` | cashier | Full-text search across `product`, `customer` and `sale` (reference, note, or any item on the sale). Words match as prefixes in any order, accent-insensitive, ranked by relevance (BM25, titles weighted 10x). Returns `[{ kind, id, title, snippet }]` with matches wrapped in `[[ ]]`. `types` filters kinds (comma-separated); `limit` max 50. |

## Analytics

| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/summary?days=1` | Today by default: sales, revenue, tax, discounts, average ticket, units, `byMethod`, refunds, voids, low-stock count, customer count |
| GET | `/analytics/revenue-by-day?days=7` | One point per day (max 90), zero-filled |
| GET | `/analytics/hourly` | 24 buckets over the last 30 days |
| GET | `/analytics/top-products?limit=5&days=30` | By units sold |

All analytics routes need a token. Only `completed` sales are counted.

## Real-time (Socket.IO)

Connect to the API origin with `io(url, { auth: { token } })`. All terminals
share one room.

| Event | Payload |
|---|---|
| `payment:confirmed` | `{ request, transaction }` |
| `payment:expired` | the expired request |
| `transaction:completed` | the completed sale |
| `inventory:low` | `[{ id, name, sku, stock, threshold }]` |
| `analytics:updated` | today's summary (same shape as `GET /analytics/summary`), sent when a sale completes |
