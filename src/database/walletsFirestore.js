/*
|--------------------------------------------------------------------------
| WALLET FIRESTORE STORE
|--------------------------------------------------------------------------
| Firestore implementation for the wallet system.
|
| Three collections are used:
|
|   wallets             one document per Telegram user id
|   wallet_transactions the ledger: every credit and debit
|   recharge_requests   pending recharge requests awaiting admin approval
|
| Writes are performed inside transactions when multiple documents must
| move together (approve/reject a recharge, debit at checkout). Reads use
| direct queries against the canonical collections.
*/

const { getDb } = require("./firestore");

const WALLETS = "wallets";
const TRANSACTIONS = "wallet_transactions";
const RECHARGES = "recharge_requests";

function nowIso() {
  return new Date().toISOString();
}

function esc(str) {
  return String(str || "").trim();
}

/*
|--------------------------------------------------------------------------
| WALLETS
|--------------------------------------------------------------------------
*/

async function fetchAllWallets() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db.collection(WALLETS).get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`[WALLETS] Fetch all failed: ${error.message}`);

    return [];
  }
}

async function fetchWallet(userId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  try {
    const snapshot = await db
      .collection(WALLETS)
      .doc(String(userId))
      .get();

    if (!snapshot.exists) {
      return null;
    }

    return { id: snapshot.id, ...snapshot.data() };
  } catch (error) {
    console.error(`[WALLETS] Fetch failed: ${error.message}`);

    return null;
  }
}

async function updateWallet(userId, mutator) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db.runTransaction(async (tx) => {
      const ref = db.collection(WALLETS).doc(String(userId));
      const snapshot = await tx.get(ref);
      const current = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : {
        id: String(userId),
        telegramUserId: Number(userId),
        balance: 0,
        transactions: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      const updated = mutator(current);

      if (updated === false) {
        return;
      }

      tx.set(ref, updated, { merge: true });
    });

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function createWallet(userId, initialBalance = 0) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db.collection(WALLETS).doc(String(userId)).create({
      telegramUserId: Number(userId),
      balance: initialBalance,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    return { ok: true, error: null };
  } catch (error) {
    const alreadyExists = error.code === 6 || /already exists/i.test(error.message);

    return {
      ok: false,
      error: alreadyExists ? `Wallet ${userId} already exists` : error.message,
      duplicate: alreadyExists,
    };
  }
}

/*
|--------------------------------------------------------------------------
| TRANSACTIONS
|--------------------------------------------------------------------------
*/

async function createTransaction(tx) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    const id = tx.id || `${String(tx.userId)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await db.collection(TRANSACTIONS).doc(id).set({
      id,
      userId: String(tx.userId),
      type: tx.type,
      amount: Number(tx.amount),
      balanceBefore: Number(tx.balanceBefore),
      balanceAfter: Number(tx.balanceAfter),
      refId: tx.refId || null,
      refType: tx.refType || null,
      note: tx.note || null,
      createdAt: nowIso(),
    });

    return { ok: true, id, error: null };
  } catch (error) {
    return { ok: false, id: null, error: error.message };
  }
}

async function fetchUserTransactions(userId, limit = 50) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db
      .collection(TRANSACTIONS)
      .where("userId", "==", String(userId))
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`[WALLETS] Fetch transactions failed: ${error.message}`);

    return [];
  }
}

/*
|--------------------------------------------------------------------------
| RECHARGE REQUESTS
|--------------------------------------------------------------------------
*/

async function createRechargeRequest(request) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    const id = request.id || `RCH_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const data = {
      id,
      userId: String(request.userId),
      amount: Number(request.amount),
      method: request.method,
      status: request.status || "pending",
      paymentProof: request.paymentProof || null,
      note: request.note || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await db.collection(RECHARGES).doc(id).create(data);

    return { ok: true, id, error: null };
  } catch (error) {
    const alreadyExists = error.code === 6 || /already exists/i.test(error.message);

    return {
      ok: false,
      id: null,
      error: alreadyExists ? `Recharge request already exists` : error.message,
      duplicate: alreadyExists,
    };
  }
}

async function fetchRecharge(requestId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  try {
    const snapshot = await db
      .collection(RECHARGES)
      .doc(requestId)
      .get();

    if (!snapshot.exists) {
      return null;
    }

    return { id: snapshot.id, ...snapshot.data() };
  } catch (error) {
    console.error(`[WALLETS] Fetch recharge failed: ${error.message}`);

    return null;
  }
}

async function updateRecharge(requestId, mutator) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db.runTransaction(async (tx) => {
      const ref = db.collection(RECHARGES).doc(requestId);
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        return;
      }

      const current = { id: snapshot.id, ...snapshot.data() };
      const updated = mutator(current);

      if (updated === false) {
        return;
      }

      updated.updatedAt = nowIso();
      tx.set(ref, updated, { merge: true });
    });

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function fetchPendingRecharges(limit = 50) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db
      .collection(RECHARGES)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`[WALLETS] Fetch pending recharges failed: ${error.message}`);

    return [];
  }
}

async function fetchUserRecharges(userId, limit = 20) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db
      .collection(RECHARGES)
      .where("userId", "==", String(userId))
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`[WALLETS] Fetch user recharges failed: ${error.message}`);

    return [];
  }
}

module.exports = {
  WALLETS,
  TRANSACTIONS,
  RECHARGES,
  fetchAllWallets,
  fetchWallet,
  updateWallet,
  createWallet,
  createTransaction,
  fetchUserTransactions,
  createRechargeRequest,
  fetchRecharge,
  updateRecharge,
  fetchPendingRecharges,
  fetchUserRecharges,
};
