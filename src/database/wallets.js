/*
|--------------------------------------------------------------------------
| WALLET DATABASE
|--------------------------------------------------------------------------
| The single place the rest of the bot reads or writes wallets,
| the ledger and recharge requests.
|
| Two backends sit behind one interface, exactly like the order
| store:
|
|   Firestore  - the production store. Every settlement is a
|                transaction across three collections, so a
|                wallet cannot be credited or debited twice.
|
|   JSON files - used when Firestore is not configured, which
|                keeps local development working as before.
|
| Wallets and the recent ledger are kept in an in-memory mirror
| so balance screens stay synchronous and cheap. The mirror is
| filled once at startup and updated by every committed write;
| Firestore remains the source of truth.
|
| Because writes go to Firestore and then to the mirror, a
| Firestore failure leaves the mirror untouched and reports
| ok:false. A credit is never reported as applied when it was
| not.
*/

const jsonStore = require("./jsonWallets");
const firestoreStore = require("./walletsFirestore");
const {
  shouldUseFirestore,
  getDb,
  describeStatus,
  healthCheck,
  closeDb,
  withTimeout,
  LOAD_TIMEOUT_MS,
} = require("./firestore");

let mode = "json";

/*
| userId -> wallet record. The mirror of the wallets collection.
*/
let walletMirror = new Map();

/*
| The most recent ledger entries, newest first. Bounded, so the
| mirror stays small no matter how long the shop runs.
*/
const MIRROR_TRANSACTIONS = 1000;
let transactionMirror = [];

let mirrorReady = false;

/*
| Told when the store cannot be read or written, so the admin
| learns the wallet system has stopped instead of losing a
| credit silently.
*/
let onStorageFailure = async () => {};

function setWalletStoreFailureHandler(handler) {
  onStorageFailure = handler;
  jsonStore.setFailureHandler(handler);
}

function usingFirestore() {
  return mode === "firestore";
}

/**
 * Which store is in use, and why. Safe to print: no credential
 * values.
 */
function describe() {
  return {
    ...describeStatus(),
    mirrorReady,
    mirroredWallets: walletMirror.size,
    mirroredTransactions: transactionMirror.length,
  };
}

/**
 * Load the read mirror.
 *
 * On the JSON backend this is a no-op, because the files are
 * the store. On Firestore the wallets and the recent ledger are
 * read once here and never re-downloaded during normal running.
 */
async function hydrate() {
  if (!shouldUseFirestore()) {
    mode = "json";
    mirrorReady = false;

    const wallets = jsonStore.readWallets();

    return {
      mode,
      wallets: wallets.ok ? wallets.data.length : 0,
    };
  }

  const db = await getDb();

  if (!db) {
    // Configured but unreachable. Falling back keeps the shop
    // trading instead of refusing every order until the config
    // is fixed.
    console.warn(
      "[DB] Firestore is configured but unreachable; using the JSON wallet store"
    );

    mode = "json";
    mirrorReady = false;

    const wallets = jsonStore.readWallets();

    return {
      mode,
      wallets: wallets.ok ? wallets.data.length : 0,
    };
  }

  try {
    const wallets = await withTimeout(
      firestoreStore.fetchAllWallets(),
      LOAD_TIMEOUT_MS,
      "Loading wallets from Firestore"
    );

    walletMirror = new Map(
      wallets.map((w) => [String(w.userId), w])
    );

    transactionMirror = await withTimeout(
      firestoreStore.fetchRecentTransactions(MIRROR_TRANSACTIONS),
      LOAD_TIMEOUT_MS,
      "Loading the wallet ledger from Firestore"
    );

    mode = "firestore";
    mirrorReady = true;

    console.log(
      `[DB] Using Firestore for wallets, ${walletMirror.size} wallet(s) loaded`
    );

    return { mode, wallets: walletMirror.size };
  } catch (error) {
    console.error(
      "[DB] Could not load wallets from Firestore, falling back to JSON:",
      error.message
    );

    mode = "json";
    mirrorReady = false;

    const wallets = jsonStore.readWallets();

    return {
      mode,
      wallets: wallets.ok ? wallets.data.length : 0,
    };
  }
}

/*
|--------------------------------------------------------------------------
| READS
|--------------------------------------------------------------------------
*/

/**
 * The wallet record for a user, or null. Synchronous on both
 * backends: the mirror on Firestore, the file on JSON.
 */
function getWalletRecord(userId) {
  if (usingFirestore()) {
    if (!mirrorReady) {
      return null;
    }

    return walletMirror.get(String(userId)) || null;
  }

  const result = jsonStore.readWallets();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return null;
  }

  return (
    result.data.find((w) => String(w.userId) === String(userId)) ||
    null
  );
}

/**
 * The current balance in LKR. Zero for a user with no wallet,
 * which is the same thing as an empty wallet to a customer.
 */
function getBalance(userId) {
  const wallet = getWalletRecord(userId);

  return wallet ? Number(wallet.balance) || 0 : 0;
}

/**
 * Ledger entries for one user, newest first.
 */
function getUserTransactions(userId, limit = 20) {
  if (usingFirestore()) {
    if (!mirrorReady) {
      return [];
    }

    return transactionMirror
      .filter((t) => String(t.userId) === String(userId))
      .slice(0, limit);
  }

  const result = jsonStore.readTransactions();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return [];
  }

  return result.data
    .filter((t) => String(t.userId) === String(userId))
    .slice(-limit)
    .reverse();
}

/**
 * The whole recent ledger, for the admin audit screen.
 */
function getRecentTransactions(limit = 50) {
  if (usingFirestore()) {
    if (!mirrorReady) {
      return [];
    }

    return transactionMirror.slice(0, limit);
  }

  const result = jsonStore.readTransactions();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return [];
  }

  return result.data.slice(-limit).reverse();
}

/**
 * Recharge requests still awaiting a decision, oldest first.
 * Goes straight to the store on both backends: requests are
 * few, and a stale list would show a request that was just
 * decided.
 */
async function getPendingRecharges() {
  if (usingFirestore()) {
    return firestoreStore.fetchPendingRecharges(
      new Date().toISOString()
    );
  }

  const result = jsonStore.readRecharges();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return [];
  }

  const now = new Date().toISOString();

  return result.data
    .filter(
      (r) =>
        r.status === "pending" &&
        (!r.expiresAt || String(r.expiresAt) > String(now))
    )
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function getRecharge(requestId) {
  if (usingFirestore()) {
    return firestoreStore.fetchRecharge(requestId);
  }

  const result = jsonStore.readRecharges();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return null;
  }

  return result.data.find((r) => r.id === requestId) || null;
}

async function getUserRecharges(userId, limit = 20) {
  if (usingFirestore()) {
    return firestoreStore.fetchUserRecharges(userId, limit);
  }

  const result = jsonStore.readRecharges();

  if (!result.ok) {
    console.error(`[WALLETS] Refusing to read: ${result.error}`);
    return [];
  }

  return result.data
    .filter((r) => String(r.userId) === String(userId))
    .slice(-limit)
    .reverse();
}

/**
 * Count a user's open requests. A fast pre-filter for the
 * one-open-request rule; the settlement transaction re-checks,
 * so this is never the only guard.
 */
async function countPendingForUser(userId) {
  if (usingFirestore()) {
    return firestoreStore.countPendingForUser(userId);
  }

  const pending = await getPendingRecharges();

  return pending.filter(
    (r) => String(r.userId) === String(userId)
  ).length;
}

/*
|--------------------------------------------------------------------------
| WRITES
|--------------------------------------------------------------------------
*/

/**
 * The one write path. Every settlement - a recharge approval, a
 * rejection, an order payment - runs its whole read-modify-write
 * inside the backend's transaction, so a wallet can never be
 * moved without its ledger entry, or the other way round.
 */
async function runTransaction(task) {
  if (!usingFirestore()) {
    return jsonStore.runTransaction(task);
  }

  const result = await firestoreStore.runTransaction(task);

  if (!result.ok) {
    console.error(`[WALLETS] Firestore transaction failed: ${result.error}`);
    await onStorageFailure(result.error);

    return result;
  }

  // Only mirror a change that was actually committed. The task's
  // result carries the records it wrote, when it wrote any.
  const written = result.result || {};

  if (written.wallet) {
    walletMirror.set(String(written.wallet.userId), written.wallet);
  }

  if (written.transaction) {
    transactionMirror = [
      written.transaction,
      ...transactionMirror.filter((t) => t.id !== written.transaction.id),
    ].slice(0, MIRROR_TRANSACTIONS);
  }

  return result;
}

/**
 * Register a recharge request. On both backends this runs
 * inside the store's transaction, which refuses a
 * duplicate id, so a retried submission cannot register
 * the same request twice.
 */
async function createRecharge(request) {
  const result = await runTransaction(async (view) => {
    const existing = await view.getRecharge(request.id);

    if (existing) {
      return {
        ok: false,
        error: `Recharge request ${request.id} already exists`,
        duplicate: true,
      };
    }

    view.setRecharge(request);

    return { ok: true, error: null };
  });

  if (!result.ok && !result.result?.duplicate) {
    console.error(
      `[WALLETS] Create recharge failed: ${result.error}`
    );
  }

  // The task's result is the decision; unwrap it.
  return result.result || { ok: false, error: result.error };
}

module.exports = {
  // Reads.
  getWalletRecord,
  getBalance,
  getUserTransactions,
  getRecentTransactions,
  getPendingRecharges,
  getRecharge,
  getUserRecharges,
  countPendingForUser,
  // Writes.
  runTransaction,
  createRecharge,
  // Lifecycle.
  hydrate,
  usingFirestore,
  describe,
  setWalletStoreFailureHandler,
  healthCheck,
  closeDb,
};
