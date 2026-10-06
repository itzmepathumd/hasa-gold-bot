/*
|--------------------------------------------------------------------------
| WALLET BUSINESS LOGIC
|--------------------------------------------------------------------------
| Everything the bot does with customer credit goes through
| this file. The rules here are the security model:
|
|   1. Only an admin can credit a wallet. A customer can
|      only *request* credit, and the request is worthless
|      until an admin approves it.
|
|   2. Every credit and debit writes a ledger entry with a
|      unique id, derived from the thing that caused it:
|      one id per recharge request, one id per order. The
|      store refuses a second entry with the same id, so
|      no retry, double-tap or replay can move a balance
|      twice.
|
|   3. Balances are never taken from the client. Every
|      settlement re-reads the wallet inside the store
|      transaction, so the balance that was just checked
|      is the balance that is spent.
|
|   4. A debit is refused if it would take the balance
|      below zero. There is no overdraft.
|
|   5. A recharge request expires after 24 hours, and a
|      customer may hold only one open request at a time,
|      so the review queue cannot be flooded.
|
| All amounts are whole LKR. The shop sells integer-priced
| packages, so fractional credit would only create
| rounding bugs.
|
| Nothing in this file knows which backend is in use. The
| store layer presents the same transaction interface on
| Firestore and on the JSON files.
*/

const crypto = require("crypto");

const store = require("./database/wallets");

/*
| The currency every wallet amount is counted in.
*/
const CURRENCY = "LKR";

/*
| Recharge limits. A minimum stops dust requests from
| flooding the review queue; a maximum keeps a single
| unverified credit from being large enough to matter.
*/
const MIN_RECHARGE = 10;
const MAX_SINGLE_RECHARGE = 500000;

/*
| How long an unapproved recharge request stays valid.
| After this an admin can no longer approve it, because
| the customer may have abandoned the payment.
*/
const RECHARGE_TTL_MS = 24 * 60 * 60 * 1000;

/*
| Open recharge requests per customer.
*/
const MAX_PENDING_PER_USER = 1;

/*
| Ledger entry ids are derived from their cause, never
| random, so the same event always maps to the same
| entry and a replay is detected instead of applied.
*/
function rechargeTransactionId(requestId) {
  return `rc_${requestId}`;
}

function orderTransactionId(orderId) {
  return `order_${orderId}`;
}

function newRequestId() {
  return `wr_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Whole-LKR amount formatting used on every screen.
 */
function formatLKR(amount) {
  return `LKR ${Number(amount).toLocaleString("en-LK")}`;
}

/**
 * Parse and validate an amount a customer typed.
 * Returns { ok, amount } or { ok: false, error }.
 */
function parseAmount(raw) {
  const value = Number(String(raw).trim().replace(/,/g, ""));

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: "not a whole number" };
  }

  if (value <= 0) {
    return { ok: false, error: "not greater than zero" };
  }

  return { ok: true, amount: value };
}

/*
|--------------------------------------------------------------------------
| READS
|--------------------------------------------------------------------------
*/

/**
 * The customer's balance. Zero when there is no wallet
 * yet, which is the same thing to a customer as an
 * empty wallet.
 */
function getBalance(userId) {
  return store.getBalance(userId);
}

/**
 * The wallet record, or null.
 */
function getWallet(userId) {
  return store.getWalletRecord(userId);
}

/**
 * Ledger entries for one customer, newest first.
 */
function getHistory(userId, limit = 20) {
  return store.getUserTransactions(userId, limit);
}

/**
 * The full recent ledger, for the admin audit screen.
 */
function getAudit(limit = 50) {
  return store.getRecentTransactions(limit);
}

/**
 * Recharge requests waiting for an admin decision.
 */
function getPendingRecharges() {
  return store.getPendingRecharges();
}

async function getRecharge(requestId) {
  return store.getRecharge(requestId);
}

async function getUserRecharges(userId, limit = 20) {
  return store.getUserRecharges(userId, limit);
}

/*
|--------------------------------------------------------------------------
| RECHARGE REQUESTS
|--------------------------------------------------------------------------
*/

/**
 * Ask to add credit.
 *
 * This only records the request and the payment proof.
 * It never moves a balance: a customer cannot credit
 * themselves, no matter what they send.
 */
async function requestRecharge(userId, amount, proofFileId) {
  const parsed =
    typeof amount === "number"
      ? { ok: Number.isInteger(amount) && amount > 0, amount }
      : parseAmount(amount);

  if (!parsed.ok) {
    return { ok: false, error: "invalid_amount", detail: parsed.error };
  }

  if (parsed.amount < MIN_RECHARGE) {
    return {
      ok: false,
      error: "amount_too_small",
      detail: `Minimum recharge is ${formatLKR(MIN_RECHARGE)}`,
    };
  }

  if (parsed.amount > MAX_SINGLE_RECHARGE) {
    return {
      ok: false,
      error: "amount_too_large",
      detail: `Maximum single recharge is ${formatLKR(MAX_SINGLE_RECHARGE)}`,
    };
  }

  // Fast pre-filter for the one-open-request rule. The
  // request itself is only ever created once, because its
  // id is unique and the store refuses duplicates.
  const open = await store.countPendingForUser(userId);

  if (open >= MAX_PENDING_PER_USER) {
    return {
      ok: false,
      error: "request_pending",
      detail: "A recharge request is already waiting for review",
    };
  }

  const now = nowIso();

  const request = {
    id: newRequestId(),

    userId: String(userId),

    amount: parsed.amount,

    currency: CURRENCY,

    status: "pending",

    // The Telegram file id of the payment screenshot. It
    // is a reference, not money: only an admin decision
    // turns it into credit.
    proof: proofFileId || null,

    createdAt: now,

    expiresAt: new Date(
      Date.now() + RECHARGE_TTL_MS
    ).toISOString(),

    decidedAt: null,
    decidedBy: null,
    rejectReason: null,
  };

  const result = await store.createRecharge(request);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, request };
}

/*
|--------------------------------------------------------------------------
| SETTLEMENTS
|--------------------------------------------------------------------------
| Both settlements run their whole read-modify-write inside
| one store transaction, so a wallet, its ledger entry and
| the request that caused them move together or not at all.
*/

/**
 * Approve a recharge request and credit the wallet.
 *
 * This is the ONLY code path in the bot that increases a
 * balance. It is called by the admin recharge approval
 * handler and nowhere else.
 *
 * Idempotent: the ledger entry id is derived from the
 * request id, so approving the same request twice applies
 * the credit once.
 */
async function approveRecharge(adminId, requestId) {
  const result = await store.runTransaction(async (view) => {
    const request = await view.getRecharge(requestId);

    if (!request) {
      return { ok: false, error: "not_found" };
    }

    if (request.status !== "pending") {
      return {
        ok: true,
        declined: "already_decided",
        request,
        wallet: await view.getWallet(request.userId),
      };
    }

    if (request.expiresAt && request.expiresAt <= nowIso()) {
      return {
        ok: true,
        declined: "expired",
        request,
        wallet: await view.getWallet(request.userId),
      };
    }

    const transactionId = rechargeTransactionId(request.id);

    // Belt and braces: even if a request record were
    // somehow reset to pending, the ledger entry would
    // stop a second credit.
    const existingEntry = await view.getTransaction(
      transactionId
    );

    if (existingEntry) {
      return {
        ok: true,
        declined: "already_credited",
        request,
        wallet: await view.getWallet(request.userId),
      };
    }

    const now = nowIso();

    const wallet = (await view.getWallet(request.userId)) || {
      userId: String(request.userId),
      balance: 0,
      currency: CURRENCY,
      createdAt: now,
      updatedAt: now,
    };

    const balance =
      Number(wallet.balance) + Number(request.amount);

    const nextWallet = {
      ...wallet,
      balance,
      currency: CURRENCY,
      updatedAt: now,
    };

    const transaction = {
      id: transactionId,
      userId: String(request.userId),
      type: "credit",
      amount: Number(request.amount),
      balanceAfter: balance,
      currency: CURRENCY,
      refType: "recharge",
      refId: request.id,
      approvedBy: String(adminId),
      createdAt: now,
    };

    view.setWallet(nextWallet);
    view.appendTransaction(transaction);
    view.setRecharge({
      ...request,
      status: "approved",
      decidedAt: now,
      decidedBy: String(adminId),
      rejectReason: null,
    });

    return {
      ok: true,
      approved: true,
      request: {
        ...request,
        status: "approved",
        decidedAt: now,
        decidedBy: String(adminId),
        rejectReason: null,
      },
      wallet: nextWallet,
      transaction,
    };
  });

  if (!result.ok) {
    console.error(
      `[WALLET] Recharge approval failed: ${result.error}`
    );

    return { ok: false, error: result.error };
  }

  return result.result;
}

/**
 * Reject a recharge request. No balance moves, ever.
 */
async function rejectRecharge(adminId, requestId, reason) {
  const result = await store.runTransaction(async (view) => {
    const request = await view.getRecharge(requestId);

    if (!request) {
      return { ok: false, error: "not_found" };
    }

    if (request.status !== "pending") {
      return {
        ok: true,
        declined: "already_decided",
        request,
      };
    }

    const now = nowIso();
    const nextRequest = {
      ...request,
      status: "rejected",
      decidedAt: now,
      decidedBy: String(adminId),
      rejectReason: reason || null,
    };

    view.setRecharge(nextRequest);

    return { ok: true, rejected: true, request: nextRequest };
  });

  if (!result.ok) {
    console.error(
      `[WALLET] Recharge rejection failed: ${result.error}`
    );

    return { ok: false, error: result.error };
  }

  return result.result;
}

/**
 * Debit a wallet to pay for one order.
 *
 * This is the ONLY code path in the bot that decreases a
 * balance. The ledger entry id is derived from the order
 * id, so paying for the same order twice debits once: a
 * retried payment returns the original result instead of
 * charging again.
 *
 * The balance is re-read inside the transaction, so the
 * amount checked is the amount spent. A debit that would
 * go below zero is refused.
 */
async function spendForOrder(userId, orderId, amount) {
  const value = Number(amount);

  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: "invalid_amount" };
  }

  const result = await store.runTransaction(async (view) => {
    const transactionId = orderTransactionId(orderId);

    // A replay of this order's payment: the debit already
    // happened, so report it instead of charging again.
    const existing = await view.getTransaction(
      transactionId
    );

    if (existing) {
      return {
        ok: true,
        alreadySpent: true,
        wallet: await view.getWallet(userId),
        transaction: existing,
      };
    }

    const wallet = await view.getWallet(userId);

    if (!wallet) {
      return {
        ok: false,
        error: "no_wallet",
        balance: 0,
      };
    }

    const balance = Number(wallet.balance) || 0;

    if (balance < value) {
      return {
        ok: false,
        error: "insufficient_balance",
        balance,
      };
    }

    const now = nowIso();

    const nextWallet = {
      ...wallet,
      balance: balance - value,
      currency: CURRENCY,
      updatedAt: now,
    };

    const transaction = {
      id: transactionId,
      userId: String(userId),
      type: "debit",
      amount: value,
      balanceAfter: balance - value,
      currency: CURRENCY,
      refType: "order",
      refId: String(orderId),
      createdAt: now,
    };

    view.setWallet(nextWallet);
    view.appendTransaction(transaction);

    return {
      ok: true,
      alreadySpent: false,
      wallet: nextWallet,
      transaction,
    };
  });

  if (!result.ok) {
    console.error(
      `[WALLET] Order payment failed: ${result.error}`
    );

    return { ok: false, error: result.error };
  }

  return result.result;
}

module.exports = {
  // Configuration, exposed for screens and tests.
  CURRENCY,
  MIN_RECHARGE,
  MAX_SINGLE_RECHARGE,
  RECHARGE_TTL_MS,
  MAX_PENDING_PER_USER,
  // Reads.
  getBalance,
  getWallet,
  getHistory,
  getAudit,
  getPendingRecharges,
  getRecharge,
  getUserRecharges,
  // Recharge requests.
  requestRecharge,
  // Settlements.
  approveRecharge,
  rejectRecharge,
  spendForOrder,
  // Helpers.
  formatLKR,
  parseAmount,
};
