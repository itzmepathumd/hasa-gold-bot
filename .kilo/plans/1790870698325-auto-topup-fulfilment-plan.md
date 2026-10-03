# Auto Top-Up Fulfilment for HASA GOLD Store

## Goal

Make approving an order actually deliver a top-up through
`@tikka_auto_top_up_bot`, without ever telling a customer something is
delivered when it is not — and without losing or duplicating orders while
doing it.

## Context

The bot currently tells a customer `🚀 Your top-up will now be processed`
when an order is approved (`index.js:1978`), and then does nothing. There
is no fulfilment code at all; it was lost when the workspace was reset
repeatedly. What survives today is `815c56a` on `kilo/ferny-ray-8kj` and
`main`.

Relevant to the design:

- **Orders are plain JSON.** `getOrders`/`saveOrders` (`index.js:110-123`)
  read and rewrite the whole array. No locking, no atomic rename.
- **`getOrders` swallows corruption.** Its `catch` returns `[]`. If
  `orders.json` is ever truncated (crash mid-write, full disk), the bot
  believes there are zero orders and the next `saveOrders` overwrites the
  file, destroying all order history. This is the most dangerous defect
  found and it must be fixed before any concurrent writes exist.
- **Order schema** (`index.js:1620-1665`): `id, playerId, playerName,
  playerRegion, gameId, gameName, idLabel, productKey, productName, price,
  status, paymentProof, createdAt, paymentSubmittedAt, approvedAt,
  rejectedAt`. `productKey` is what the supplier mapping keys off.
- **Known mutation sites** for orders: creation (`index.js:1667-1671`),
  proof upload, reject handler (`index.js:1989`), approve handler
  (`index.js:1907`).
- **Free Fire weekly is the only confirmed supplier product.** `weekly` is
  a Free Fire package (`sub_category_id: 110`), and `WEEKLY` is confirmed.
  The 8 Blood Strike packages have unknown supplier names.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Auto top-up + atomic writes first |
| Automated products | Free Fire `weekly` → `WEEKLY` only |
| Blood Strike | Not automated; approved orders park in review |
| Review queue | Built in this plan |
| Success detection | Strict allowlist; unknown replies → review + log |
| `.env` in git | Left as-is, accepted risk (user decision) |
| Production default | `SUPPLIER_PRODUCTION_MODE=false` |

## Phase 0 — Order storage (no supplier involved)

Do this first. Concurrent writes are what make duplicate supplier commands
possible, so the storage layer has to be correct before fulfilment exists.

1. Replace `getOrders`/`saveOrders` with:
   - `readOrders()` returning `{ ok, orders, error }`. File missing → create
     empty and return ok. JSON parse failure → return `ok: false` and
     **never** an empty array.
   - `writeOrders(orders)` writing to `orders.json.tmp` then
     `fs.renameSync`, serialised through a module-level promise chain so
     two writers cannot interleave.
   - `mutateOrder(orderId, mutator)` — queued read-modify-write. The
     mutator returns the order to store and communicates its decision via a
     side-channel object, so the stored record is never a wrapper. Resolves
     `null` when the order is absent.
   - `appendOrder(order)`.
   - Before each write, copy the current file to `orders.prev.json` as a
     single rollback point.
2. When `readOrders()` returns `ok: false`, every write path must abort and
   notify the admin. Never fall through to a write.
3. Convert the four known mutation sites to `appendOrder`/`mutateOrder`.
   Leave read-only call sites (analytics, listings) on `readOrders()`.
4. `statusBadge` gains the new statuses below.

## Phase 1 — Supplier bridge

Create `src/supplier/`:

- **`supplierParser.js`** — `parse(text)` → `{ status, statusDetail,
  transactionId, confidence }`. `status` ∈ `success | failed | processing
  | unknown`. Specific reasons (`invalid_player`,
  `insufficient_balance`, `temporary_error`) are matched before generic
  ones. **Only an explicit success phrase counts as `success`.** Anything
  unrecognised stays `unknown`.
- **`supplierClient.js`** — GramJS `TelegramClient` + `StringSession`,
  session persisted to `supplier_session.json`. Registers the pending-reply
  waiter *before* sending so an immediate reply is not dropped. Enforces a
  minimum reply delay so a stale reply from a previous command cannot be
  read as this one's answer.
- **`supplierAdapter.js`** — builds `/id <playerId> <PRODUCT>`. Resolves
  the product token from `productMapping`; **an unmapped package throws
  before anything is sent** (guessing a name could deliver the wrong
  product). Serialises all requests — one supplier conversation, so
  concurrent orders would otherwise read each other's replies. In test mode
  returns `processing` and never success.
- **`index.js`** barrel.

Config in `index.js`:

```js
const supplierAdapter = new SupplierAdapter({
  commandTemplate: "/id {playerId} {product}",
  productMapping: { weekly: "WEEKLY" },   // Free Fire only, for now
  responseTimeout: 60000,
  productionMode:
    process.env.SUPPLIER_PRODUCTION_MODE === "true",
});
```

Blood Strike packages are deliberately absent from the mapping.

## Phase 2 — Fulfilment state machine

New statuses in `STATUS_META`: `ready_for_topup`, `topup_processing`,
`topup_completed`, `topup_failed`, `needs_review`. Add fields to the order
record: `topupStatus`, `topupAttempts`, `supplierTransactionId`,
`supplierMessageId`, `topupStartedAt`, `topupCompletedAt`, `topupError`,
`supplierRawReply`.

Functions to add:

- `processAutoTopup(orderId)` — claims the order through `mutateOrder`
  exactly once. Terminal / already in-flight / attempts exhausted /
  claimed. On claim, run the supplier request and the customer notice in
  parallel.
- `recoverTopupStatus(orderId)` — resolves a request already at the
  supplier. **Never sends a new request.**
- `settleForReview(orderId, reason)`.
- `notifyTopupResult(order, "completed" | "failed" | "pending")`.
- `runStartupRecovery()` — parks interrupted orders as `needs_review`.
- `notifyAdminOfReview()`.

`TOPUP_MAX_ATTEMPTS = 3`.

**A request whose outcome is unknown is never resent.** Unknown, timeout,
unrecognised reply and `invalid_player` all land in `needs_review`, because
retrying a request that may already have been delivered charges the
customer twice.

Rewritten approve handler (`index.js:1907`):
- Claim via `mutateOrder`, set `status: "approved"` and
  `topupStatus: "ready_for_topup"`, reset tracking fields, then
  `setImmediate(() => processAutoTopup(order.id))`.
- **Message correctness:** only promise automated processing when
  `productKey` is in the mapping. For Blood Strike, tell the customer the
  order is with the team, not that a top-up is being processed.
- Use `order.gameName`, not a hardcoded Blood Strike fallback.

Invoke `runStartupRecovery()` before `bot.launch()`.

Append every supplier reply to `supplier_replies.log` so the parser can be
widened from real traffic.

## Phase 3 — Admin review queue

Follows the existing `admin_pending` pattern (`index.js:3118`).

- `/review` command, plus a button on the admin panel.
- Lists orders with `status === "needs_review"`, showing id, product,
  player ID, reason, and attempts.
- Per-order screen with: view proof, **mark delivered**, **mark failed**,
  **retry top-up**.
- `mark delivered` / `mark failed` set the terminal status via
  `mutateOrder` and notify the customer.
- Retry guard: only permitted when `topupAttempts < TOPUP_MAX_ATTEMPTS`.
  Retry re-enters `processAutoTopup`, which will refuse if the order is
  already in flight. The admin must confirm the previous attempt never
  reached the supplier.

## Phase 4 — Tests and scripts

- `suppliertest.js` — command shape, refusal of unmapped packages, test
  mode never claims success, strict parser, one-request-at-a-time
  serialisation, no status lookup, cancel refused.
- `topuptest.js` — happy path completes once; duplicate approval refused;
  interrupted request not resent and attempts unchanged; concurrent
  approvals lose no orders; corrupt `orders.json` blocks writes.
- Extend `flowtest.js` with the missing `ctx.session` regression: the
  store-management handlers must survive `ctx.session === undefined`
  (`ensureSession` guard — this fix is absent today).
- Replace the placeholder `test` script in `package.json` with all suites.
- Add `supplier_session.json` and `supplier_replies.log` to `.gitignore`.

## Failure modes and edge cases

- Double-tap Approve → atomic claim; second call sees terminal or in-flight.
- Crash mid-flight → startup recovery parks as `needs_review`, never resends.
- Corrupt `orders.json` → writes blocked, admin alerted; `orders.prev.json`
  is the rollback point.
- Unmapped product (any Blood Strike package) → refused before sending.
- Test mode → never reports delivered.
- Supplier silence → `unknown` → review, never a retry.

## Rollout

1. Ship Phase 0 alone first. It is a pure safety improvement and changes no
   behaviour, so it can be verified on its own.
2. Ship Phases 1-3 with `SUPPLIER_PRODUCTION_MODE=false`. Approving a
   Free Fire weekly order must land in `needs_review`, never in delivered.
3. Perform **one real** Free Fire weekly order end to end. Capture the
   supplier reply, tune the parser patterns, confirm the transaction id is
   extracted.
4. Only then set `SUPPLIER_PRODUCTION_MODE=true`.
5. Blood Strike stays manual until the supplier confirms its product names;
   adding them is a one-line change per package in `productMapping`.

## Validation

Automated: `selftest`, `flowtest`, `analytest`, `animtest`, `abouttest`,
`deadscan` (all currently green at 24/29/31/16/23 and 51/51 handlers), plus
the new `suppliertest` and `topuptest`.

Manual, before flipping to production:
- `/about`, `/games`, `/orders` still behave.
- Full customer flow through validation, payment, approval.
- With production off: approval lands in review, customer is told the order
  is with the team, `/review` lists it, mark-delivered notifies the customer.
- With production on: one real order, verify the logged reply matches what
  the supplier actually sent.

## Blocked on the user

The GramJS client needs a Telegram **user** account session — the supplier
bot only answers real users, so a bot token is not sufficient. Required:
`TG_API_ID`, `TG_API_HASH`, `TG_PHONE_NUMBER` from my.telegram.org, then a
one-time `SUPPLIER_LOGIN_CODE` delivered to that app, and `TG_2FA_PASSWORD`
only if 2FA is enabled. The session persists to `supplier_session.json`,
so this is needed once.

The user also must supply real supplier replies to confirm the parser, and
may obtain the Blood Strike product names later.

## Out of scope for this plan

Recorded as known gaps, not addressed here:

- Bot token and SHOP2TOPUP key remain in git history (accepted risk).
- No rate limit on player-ID validation, which spends SHOP2TOPUP quota.
- No expiry for abandoned `pending_payment` orders.
- Bot stays silent on unexpected text outside a flow (`index.js:1299`).
- Single admin, no roles, no audit trail of who approved what.
- No admin broadcast, coupons, referrals, or package deep links.
- No `orders.json` rotation beyond the single `orders.prev.json`.