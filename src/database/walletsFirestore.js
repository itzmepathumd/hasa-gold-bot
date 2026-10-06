/*
|--------------------------------------------------------------------------
| FIRESTORE WALLET STORE
|--------------------------------------------------------------------------
| Wallets live in three collections:
|
|   wallets             one document per Telegram user id
|   wallet_transactions the ledger: every credit and debit
|   recharge_requests   recharge requests awaiting a decision
|
| Concurrency: crediting a wallet moves three documents at once
| (the request, the wallet and the ledger entry), so every
| settlement runs inside db.runTransaction. Firestore retries
| the callback when another writer touches the same documents,
| which means a double-tapped approve button cannot credit a
| customer twice: the second attempt reads the request as
| already decided and stops.
|
| The ledger entry is written with create(), which refuses to
| overwrite. Combined with the transaction-id convention
| (one id per recharge, one id per order) this makes every
| settlement idempotent: replaying the same approval or the
| same order spend finds the entry already there and returns
| the same answer without writing.
|
| Timestamps are ISO strings, matching the order store, so the
| admin screens and exports keep reading them directly.
*/

const { getDb } = require("./firestore");

const WALLETS = "wallets";
const TRANSACTIONS = "wallet_transactions";
const RECHARGES = "recharge_requests";

/**
 * Firestore rejects undefined. Null is valid and is used
 * throughout the wallet shape for "not filled in yet".
 */
function toDocument(record) {
  const clean = {};

  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }

  return clean;
}

function fromSnapshot(snapshot) {
  if (!snapshot.exists) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * Every wallet document. Only used at startup to fill the
 * read mirror, never to render a screen.
 */
async function fetchAllWallets() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db.collection(WALLETS).get();

  return snapshot.docs.map(fromSnapshot);
}

/**
 * The most recent ledger entries, newest first. Bounded, so a
 * shop with a long history does not pull the whole ledger.
 */
async function fetchRecentTransactions(limit = 500) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db
    .collection(TRANSACTIONS)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map(fromSnapshot);
}

/**
 * Ledger entries for one user, newest first.
 */
async function fetchUserTransactions(userId, limit = 20) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  // Wallet records key the user as a string, so the
  // query must match on the string form: Firestore
  // compares types strictly and "222" is not 222.
  const snapshot = await db
    .collection(TRANSACTIONS)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map(fromSnapshot);
}

/**
 * Recharge requests still awaiting a decision. Expired requests
 * are filtered here too, so an admin never sees a request that
 * can no longer be approved.
 */
async function fetchPendingRecharges(nowIso) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db
    .collection(RECHARGES)
    .where("status", "==", "pending")
    .get();

  return snapshot.docs
    .map(fromSnapshot)
    .filter((r) => !r.expiresAt || String(r.expiresAt) > String(nowIso))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function fetchRecharge(requestId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const snapshot = await db.collection(RECHARGES).doc(requestId).get();

  return fromSnapshot(snapshot);
}

async function fetchUserRecharges(userId, limit = 20) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db
    .collection(RECHARGES)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map(fromSnapshot);
}

/**
 * Create a recharge request. create() refuses to overwrite, so a
 * retried submission cannot register the same request twice.
 */
async function createRecharge(request) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db
      .collection(RECHARGES)
      .doc(request.id)
      .create(toDocument(request));

    return { ok: true, error: null };
  } catch (error) {
    const alreadyExists =
      error.code === 6 || /already exists/i.test(error.message);

    return {
      ok: false,
      error: alreadyExists
        ? `Recharge request ${request.id} already exists`
        : error.message,
      duplicate: alreadyExists,
    };
  }
}

/**
 * Count pending requests for one user. Used to enforce the
 * one-open-request rule outside a transaction; the transaction
 * itself re-checks, so this is only a fast pre-filter.
 */
async function countPendingForUser(userId) {
  const db = await getDb();

  if (!db) {
    return 0;
  }

  const snapshot = await db
    .collection(RECHARGES)
    .where("userId", "==", String(userId))
    .where("status", "==", "pending")
    .get();

  return snapshot.size;
}

/**
 * Run an atomic operation across the three collections.
 *
 * The task receives a view with plain getters and setters and
 * returns a plain result. Nothing is written unless the task
 * sets a document, and a task that throws writes nothing.
 *
 * Setters:
 *   setWallet(wallet)         write (insert or replace) a wallet
 *   appendTransaction(txn)    create a ledger entry; throws if the
 *                             id exists, which is the idempotency
 *                             guard
 *   setRecharge(request)      write a recharge request
 *
 * Getters:
 *   getWallet(userId)
 *   getTransaction(id)
 *   getRecharge(id)
 */
async function runTransaction(task) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  let result = null;

  try {
    await db.runTransaction(async (tx) => {
      const view = {
        getWallet: async (userId) => {
          const snapshot = await tx.get(
            db.collection(WALLETS).doc(String(userId))
          );

          return fromSnapshot(snapshot);
        },

        getTransaction: async (id) => {
          const snapshot = await tx.get(
            db.collection(TRANSACTIONS).doc(String(id))
          );

          return fromSnapshot(snapshot);
        },

        getRecharge: async (id) => {
          const snapshot = await tx.get(
            db.collection(RECHARGES).doc(String(id))
          );

          return fromSnapshot(snapshot);
        },

        setWallet: (wallet) => {
          tx.set(
            db.collection(WALLETS).doc(String(wallet.userId)),
            toDocument(wallet)
          );
        },

        appendTransaction: (txn) => {
          // create() fails when the document exists, so a replayed
          // settlement cannot append a second ledger entry.
          tx.create(
            db.collection(TRANSACTIONS).doc(String(txn.id)),
            toDocument(txn)
          );
        },

        setRecharge: (request) => {
          tx.set(
            db.collection(RECHARGES).doc(String(request.id)),
            toDocument(request)
          );
        },
      };

      result = await task(view);
    });

    return { ok: true, result, error: null };
  } catch (error) {
    return { ok: false, result: null, error: error.message };
  }
}

module.exports = {
  WALLETS,
  TRANSACTIONS,
  RECHARGES,
  fetchAllWallets,
  fetchRecentTransactions,
  fetchUserTransactions,
  fetchPendingRecharges,
  fetchRecharge,
  fetchUserRecharges,
  createRecharge,
  countPendingForUser,
  runTransaction,
};
