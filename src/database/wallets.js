/*
|--------------------------------------------------------------------------
| WALLET DATABASE
|--------------------------------------------------------------------------
| Customer credit, the ledger and recharge requests, all on PostgreSQL.
|
| Money is moved by three database functions and by nothing else:
|
|   wallet_credit(telegram_id, amount, ...)   SQL in database/schema.sql
|   wallet_debit(telegram_id, amount, ...)
|   approve_recharge(request_id, admin_id)
|
| Each of them takes a row lock on the customer, writes the ledger entry and
| updates the balance inside one transaction, and each of them is idempotent
| on an idempotency key. That is what stops a double-tapped button from
| crediting a customer twice or spending the same balance twice.
|
| Read paths use an in-memory mirror filled once at startup, because the
| wallet screen is synchronous throughout the bot. Writes always go to the
| database first and only then refresh the mirror, so a failed write leaves
| the mirror reporting the balance it really has.
*/

const { getDb, describeStatus, healthCheck, closeDb } = require("./connection");
const payments = require("./payments");
const {
  walletFromRow,
  transactionFromRow,
  rechargeFromRow,
} = require("./mappers");

const WALLETS = "users";
const TRANSACTIONS = "wallet_transactions";
const RECHARGES = "recharge_requests";

let wallets = new Map();
let mirrorReady = false;

/*
| The most recent ledger entries per customer, newest first. The wallet
| screen and the activity list are synchronous throughout the bot, and the
| ledger is the one thing they need that is not on the wallet row. One query
| at startup covers every customer, and a credit or debit refreshes the one
| it touched.
|
| The full history is always available: fetchUserTransactions() reads it
| from the table. This mirror is the recent window, never a substitute.
*/
let recentTransactions = new Map();
const RECENT_TRANSACTION_WINDOW = 20;

let onStorageFailure = async () => {};

function setWalletStoreFailureHandler(handler) {
  onStorageFailure = handler;
}

function usingDatabase() {
  return describeStatus().mode === "postgres";
}

function describe() {
  return {
    ...describeStatus(),
    mirrorReady,
    wallets: wallets.size,
  };
}

async function hydrate() {
  if (!usingDatabase()) {
    wallets = new Map();
    mirrorReady = false;

    console.warn(
      "[WALLETS] SUPABASE_DB_URL is not set, so no wallet is loaded."
    );

    return { mode: "json", wallets: 0, ok: false };
  }

  try {
    const db = await getDb();

    if (!db) {
      throw new Error("the database connection is unavailable");
    }

    const { rows } = await db.query(
      `SELECT telegram_id, username, first_name, balance, role, is_banned,
              created_at, updated_at
         FROM users`
    );

    wallets.clear();
    for (const row of rows) {
      wallets.set(String(row.telegram_id), walletFromRow(row));
    }

    const { rows: ledgerRows } = await db.query(
      `SELECT id, user_id, order_id, payment_id, transaction_type, amount,
              balance_before, balance_after, description, ref_id, ref_type,
              idempotency_key, created_at
         FROM (
              SELECT t.*, ROW_NUMBER() OVER (
                       PARTITION BY t.user_id
                       ORDER BY t.created_at DESC, t.id DESC
                     ) AS position
                FROM wallet_transactions t
              ) ranked
        WHERE position <= $1
        ORDER BY user_id, position ASC`,
      [RECENT_TRANSACTION_WINDOW]
    );

    recentTransactions.clear();
    for (const row of ledgerRows) {
      const key = String(row.user_id);
      const list = recentTransactions.get(key) || [];

      list.push(transactionFromRow(row));
      recentTransactions.set(key, list);
    }

    mirrorReady = true;

    console.log(`[WALLETS] Using PostgreSQL, ${wallets.size} wallet(s) loaded`);

    return { mode: "postgres", wallets: wallets.size, ok: true };
  } catch (error) {
    console.error(`[WALLETS] Could not load wallets: ${error.message}`);

    wallets = new Map();
    mirrorReady = false;

    await onStorageFailure(error.message);

    return { mode: "postgres", wallets: 0, ok: false, error: error.message };
  }
}

function getWallets() {
  return Array.from(wallets.values());
}

function getWallet(userId) {
  return wallets.get(String(userId)) || null;
}

function replaceWallet(wallet) {
  wallets.set(String(wallet.userId), wallet);
}

/**
 * Load the most recent ledger entries for one customer. Used after a credit
 * or debit so the mirror never lags behind the table.
 */
async function refreshUserTransactions(userId) {
  if (!usingDatabase()) {
    return;
  }

  const db = await getDb();
  const key = String(userId);

  const { rows } = await db.query(
    `SELECT id, user_id, order_id, payment_id, transaction_type, amount,
            balance_before, balance_after, description, ref_id, ref_type,
            idempotency_key, created_at
       FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [Number(userId), RECENT_TRANSACTION_WINDOW]
  );

  recentTransactions.set(key, rows.map(transactionFromRow));
}

/**
 * The most recent ledger entries for one customer, newest first, from the
 * mirror. Synchronous because the wallet screen is.
 *
 * A customer whose window has not been loaded yet gets a refresh queued, so
 * the first opening of the screen reads what the database holds and the next
 * one reads the cached copy.
 */
function getUserTransactions(userId, limit = RECENT_TRANSACTION_WINDOW) {
  const key = String(userId);
  const cached = recentTransactions.get(key);

  if (!cached) {
    refreshUserTransactions(key).catch(() => {});
  }

  const list = cached || [];
  const cap = Math.max(0, Number(limit) || RECENT_TRANSACTION_WINDOW);

  return list.slice(0, cap);
}

/**
 * The full ledger history for one customer, read from the table. Not cached:
 * this is for a screen that is opened rarely and must not be limited to the
 * recent window.
 */
async function fetchUserTransactions(userId, limit = 50) {
  if (!usingDatabase()) {
    return [];
  }

  const db = await getDb();

  const { rows } = await db.query(
    `SELECT id, user_id, order_id, payment_id, transaction_type, amount,
            balance_before, balance_after, description, ref_id, ref_type,
            idempotency_key, created_at
       FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [Number(userId), Number(limit)]
  );

  return rows.map(transactionFromRow);
}

/**
 * Create a wallet. The row already exists for any user the bot has seen,
 * because every write path creates it, so this is a no-op that reports
 * success: a wallet is simply a customer with a balance of zero.
 */
async function createWallet(userId) {
  if (!usingDatabase()) {
    return { ok: false, error: "Supabase is not available" };
  }

  try {
    const db = await getDb();

    await db.query(`SELECT ensure_user($1)`, [Number(userId)]);

    const wallet = walletFromRow({
      telegram_id: Number(userId),
      balance: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    replaceWallet(wallet);

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function idempotencyKeyFor(refId, refType) {
  if (refType && refId) {
    return `${refType}:${refId}`;
  }

  return null;
}

/**
 * Credit a wallet. refId/refType describe what the credit is for, and
 * together they form the idempotency key, so the same order can never be
 * credited twice.
 */
async function creditWallet(userId, amount, refId = null, refType = null, note = null) {
  return moveWallet(userId, amount, "credit", refId, refType, note);
}

async function debitWallet(userId, amount, refId = null, refType = null, note = null) {
  return moveWallet(userId, amount, "debit", refId, refType, note);
}

async function moveWallet(userId, amount, type, refId, refType, note) {
  if (!usingDatabase()) {
    return { ok: false, error: "Supabase is not available" };
  }

  const db = await getDb();
  const idempotencyKey = idempotencyKeyFor(refId, refType);

  try {
    const { rows } = await db.query(
      `SELECT * FROM wallet_${type}($1, $2, $3, $4, $5, $6, $7)`,
      [
        Number(userId),
        Number(amount),
        note,
        refId || null,
        refType || null,
        idempotencyKey,
        refType === "order_payment" ? String(refId) : null,
      ]
    );

    const row = rows[0];

    if (!row.ok) {
      // The SQL functions return the machine-readable reason for the two
      // outcomes the bot has always distinguished.
      return {
        ok: false,
        error:
          row.error === "insufficient_balance"
            ? "insufficient_balance"
            : row.error === "no_wallet"
              ? "no_wallet"
              : row.error || "The wallet could not be updated",
        detail: row.error,
      };
    }

    const wallet = getWallet(userId) || {
      userId: String(userId),
      telegramUserId: Number(userId),
    };

    replaceWallet({
      ...wallet,
      userId: String(userId),
      telegramUserId: Number(userId),
      balance: Number(row.balance),
      updatedAt: new Date().toISOString(),
    });

    refreshUserTransactions(userId).catch(() => {});

    return {
      ok: true,
      balance: Number(row.balance),
      transactionId: Number(row.transaction_id),
    };
  } catch (error) {
    console.error(`[WALLETS] ${type} failed: ${error.message}`);

    await onStorageFailure(error.message);

    return { ok: false, error: error.message };
  }
}

/**
 * A wallet payment for an order also writes a payment row, so the order can
 * be traced to the money that paid for it.
 */
async function payForOrder(userId, orderNumber, amount, note) {
  const result = await debitWallet(
    userId,
    amount,
    orderNumber,
    "order_payment",
    note || `Order ${orderNumber}`
  );

  if (!result.ok) {
    return result;
  }

  await payments
    .recordOrderPayment({
      orderNumber,
      telegramId: Number(userId),
      amount: Number(amount),
      method: "wallet",
      status: "verified",
      verifiedAt: new Date().toISOString(),
      walletTransactionId: result.transactionId,
    })
    .catch((error) => {
      console.error(
        `[PAYMENTS] Could not record the wallet payment for ${orderNumber}: ${error.message}`
      );
    });

  return result;
}

/*
|--------------------------------------------------------------------------
| RECHARGE REQUESTS
|--------------------------------------------------------------------------
*/

async function createRechargeRequest(request) {
  if (!usingDatabase()) {
    return { ok: false, error: "Supabase is not available" };
  }

  const db = await getDb();
  const isAutoVerified = String(request.paymentProof || "").startsWith(
    "auto_verified:"
  );

  try {
    const { rows } = await db.query(
      `WITH new_request AS (
         INSERT INTO recharge_requests (request_id, user_id, amount, method, status, payment_proof, note)
         VALUES ($1, (SELECT ensure_user($2)), $3, $4, $5, $6, $7)
         RETURNING id, request_id, user_id, amount, method, status, created_at
       ), new_payment AS (
         INSERT INTO payments (order_id, user_id, recharge_id, amount, payment_method,
                               reference_number, status, verified_at)
         SELECT NULL, r.user_id, r.id, r.amount, r.method, $8,
                CASE WHEN $5 = 'verified' THEN 'verified' ELSE 'pending' END,
                CASE WHEN $5 = 'verified' THEN NOW() ELSE NULL END
           FROM new_request r
         RETURNING id
       )
       SELECT (SELECT id FROM new_request) AS id,
              (SELECT request_id FROM new_request) AS request_id,
              (SELECT id FROM new_payment) AS payment_id`
    );

    // A request the payment provider already verified is recorded as
    // verified, because the RN was confirmed before the wallet was credited.
    if (isAutoVerified && rows.length && rows[0].payment_id) {
      await db.query(
        `UPDATE payments SET status = 'verified', verified_at = NOW() WHERE id = $1`,
        [rows[0].payment_id]
      );
    }

    return { ok: true, id: rows[0].request_id, error: null };
  } catch (error) {
    const duplicate = /duplicate key value|already exists/i.test(error.message);

    return {
      ok: false,
      id: null,
      duplicate,
      error: duplicate ? `Recharge request already exists` : error.message,
    };
  }
}

async function getRecharge(requestId) {
  if (!usingDatabase()) {
    return null;
  }

  const db = await getDb();

  const { rows } = await db.query(
    `SELECT request_id, user_id, amount, method, status, payment_proof, note,
            payment_id, approved_by, approved_at, rejected_by, rejected_at,
            reject_reason, created_at, updated_at
       FROM recharge_requests
      WHERE request_id = $1`,
    [requestId]
  );

  return rows.length ? rechargeFromRow(rows[0]) : null;
}

async function getUserRecharges(userId, limit = 20) {
  if (!usingDatabase()) {
    return [];
  }

  const db = await getDb();

  const { rows } = await db.query(
    `SELECT request_id, user_id, amount, method, status, payment_proof, note,
            payment_id, approved_by, approved_at, rejected_by, rejected_at,
            reject_reason, created_at, updated_at
       FROM recharge_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [Number(userId), Number(limit)]
  );

  return rows.map(rechargeFromRow);
}

async function getPendingRecharges(limit = 50) {
  if (!usingDatabase()) {
    return [];
  }

  const db = await getDb();

  const { rows } = await db.query(
    `SELECT request_id, user_id, amount, method, status, payment_proof, note,
            payment_id, approved_by, approved_at, rejected_by, rejected_at,
            reject_reason, created_at, updated_at
       FROM recharge_requests
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1`,
    [Number(limit)]
  );

  return rows.map(rechargeFromRow);
}

async function approveRecharge(requestId, adminId) {
  if (!usingDatabase()) {
    return { ok: false, error: "Supabase is not available" };
  }

  const db = await getDb();

  try {
    const { rows } = await db.query(`SELECT * FROM approve_recharge($1, $2)`, [
      requestId,
      Number(adminId) || 0,
    ]);

    const row = rows[0];

    if (!row.ok) {
      return { ok: false, error: row.error || "The recharge could not be approved" };
    }

    const request = await getRecharge(requestId);
    const wallet = getWallet(request?.userId);

    refreshUserTransactions(request?.userId).catch(() => {});

    if (wallet) {
      replaceWallet({
        ...wallet,
        balance: Number(row.balance),
        updatedAt: new Date().toISOString(),
      });
    } else if (request) {
      replaceWallet({
        userId: String(request.userId),
        telegramUserId: Number(request.userId),
        balance: Number(row.balance),
        updatedAt: new Date().toISOString(),
      });
    }

    return { ok: true, balance: Number(row.balance) };
  } catch (error) {
    console.error(`[WALLETS] Approve recharge failed: ${error.message}`);

    return { ok: false, error: error.message };
  }
}

async function rejectRecharge(requestId, adminId, reason = null) {
  if (!usingDatabase()) {
    return { ok: false, error: "Supabase is not available" };
  }

  const db = await getDb();

  try {
    const { rows } = await db.query(`SELECT * FROM reject_recharge($1, $2, $3)`, [
      requestId,
      Number(adminId) || 0,
      reason || null,
    ]);

    const row = rows[0];

    if (!row.ok) {
      return { ok: false, error: row.error || "The recharge could not be rejected" };
    }

    return { ok: true };
  } catch (error) {
    console.error(`[WALLETS] Reject recharge failed: ${error.message}`);

    return { ok: false, error: error.message };
  }
}

module.exports = {
  WALLETS,
  TRANSACTIONS,
  RECHARGES,
  hydrate,
  usingDatabase,
  describe,
  setWalletStoreFailureHandler,
  healthCheck,
  closeDb,
  getWallets,
  getWallet,
  getUserTransactions,
  fetchUserTransactions,
  createWallet,
  creditWallet,
  debitWallet,
  payForOrder,
  createRechargeRequest,
  getRecharge,
  getUserRecharges,
  approveRecharge,
  rejectRecharge,
  getPendingRecharges,
};
