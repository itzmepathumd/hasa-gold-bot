/*
|--------------------------------------------------------------------------
| WALLET DATABASE
|--------------------------------------------------------------------------
| The single place the rest of the bot reads or writes wallet data.
|
| Two backends sit behind one interface:
|
|   Firestore  - the production store. Writes that touch multiple documents
|                run inside transactions.
|
|   JSON files - used only when Firestore is not configured, which keeps
|                local development working.
|
| Reads come from an in-memory mirror rather than a query per screen. The
| mirror is filled once at startup from Firestore and updated by every
| write, so the collection is never re-downloaded to render a screen.
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
let wallets = new Map();
let transactions = [];
let mirrorReady = false;

let onStorageFailure = async () => {};

function setWalletStoreFailureHandler(handler) {
  onStorageFailure = handler;
  jsonStore.setFailureHandler(handler);
}

function usingFirestore() {
  return mode === "firestore";
}

function describe() {
  return { ...describeStatus(), mirrorReady, wallets: wallets.size };
}

async function hydrate() {
  if (!shouldUseFirestore()) {
    mode = "json";
    mirrorReady = false;

    const walletsResult = jsonStore.readWallets();
    const walletsData = walletsResult.error ? [] : walletsResult.data;

    for (const w of walletsData) {
      wallets.set(String(w.userId), w);
    }

    const txResult = jsonStore.readTransactions();
    transactions = txResult.error ? [] : txResult.data;

    console.log(`[WALLETS] Using JSON, ${wallets.size} wallet(s) loaded`);

    return { mode, wallets: wallets.size };
  }

  const db = await getDb();

  if (!db) {
    console.warn("[WALLETS] Firestore configured but unreachable; using JSON");
    mode = "json";
    mirrorReady = false;

    return { mode, wallets: 0 };
  }

  try {
    const allWallets = await withTimeout(
      firestoreStore.fetchAllWallets(),
      LOAD_TIMEOUT_MS,
      "Loading wallets from Firestore"
    );

    wallets.clear();
    for (const w of allWallets) {
      wallets.set(String(w.userId || w.id), w);
    }

    mode = "firestore";
    mirrorReady = true;

    console.log(`[WALLETS] Using Firestore, ${wallets.size} wallet(s) loaded`);

    return { mode, wallets: wallets.size };
  } catch (error) {
    console.error("[WALLETS] Could not load from Firestore, falling back to JSON:", error.message);
    mode = "json";
    mirrorReady = false;

    return { mode, wallets: 0 };
  }
}

function getWallets() {
  if (usingFirestore()) {
    if (!mirrorReady) {
      return [];
    }

    return Array.from(wallets.values());
  }

  return jsonStore.getRechargeRequests().map((r) => ({ id: r.id, ...r }));
}

function getWallet(userId) {
  if (usingFirestore()) {
    return wallets.get(String(userId)) || null;
  }

  return jsonStore.getWalletRecord(userId);
}

function replaceWallet(wallet) {
  const id = String(wallet.userId || wallet.id);

  if (usingFirestore()) {
    wallets.set(id, wallet);
  }
}

function getTransactions() {
  if (usingFirestore()) {
    return transactions;
  }

  return jsonStore.getUserTransactions(userId, 1000);
}

function getUserTransactions(userId, limit = 50) {
  if (usingFirestore()) {
    // In production, fetch directly from Firestore
    return [];
  }

  return jsonStore.getUserTransactions(userId, limit);
}

async function createWallet(userId, initialBalance = 0) {
  if (!usingFirestore()) {
    return jsonStore.createWallet(userId, initialBalance);
  }

  const result = await firestoreStore.createWallet(userId, initialBalance);

  if (result.ok) {
    replaceWallet({
      telegramUserId: Number(userId),
      userId: String(userId),
      balance: initialBalance,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return result;
}

async function creditWallet(userId, amount, refId = null, refType = null, note = null) {
  if (!usingFirestore()) {
    const wallet = jsonStore.getWalletRecord(userId) || { userId, balance: 0 };
    const balanceBefore = Number(wallet.balance) || 0;
    const balanceAfter = balanceBefore + Number(amount);

    jsonStore.setWallet({ ...wallet, userId, balance: balanceAfter });

    const txResult = jsonStore.addTransaction({
      userId,
      type: "credit",
      amount: Number(amount),
      balanceBefore,
      balanceAfter,
      refId,
      refType,
      note,
    });

    return txResult.ok
      ? { ok: true, balance: balanceAfter, transactionId: txResult.id }
      : { ok: false, error: txResult.error };
  }

  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    let result = { ok: false, error: "not set" };

    await db.runTransaction(async (tx) => {
      const ref = db.collection(firestoreStore.WALLETS).doc(String(userId));
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? { id: snapshot.id, ...snapshot.data() }
        : {
            id: String(userId),
            telegramUserId: Number(userId),
            balance: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

      const balanceBefore = Number(current.balance) || 0;
      const balanceAfter = balanceBefore + Number(amount);

      current.balance = balanceAfter;
      current.updatedAt = new Date().toISOString();

      tx.set(ref, current, { merge: true });

      const txId = `${String(userId)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const txRef = db.collection(firestoreStore.TRANSACTIONS).doc(txId);

      tx.set(txRef, {
        id: txId,
        userId: String(userId),
        type: "credit",
        amount: Number(amount),
        balanceBefore,
        balanceAfter,
        refId: refId || null,
        refType: refType || null,
        note: note || null,
        createdAt: new Date().toISOString(),
      });

      result = { ok: true, balance: balanceAfter, transactionId: txId };
    });

    if (result.ok) {
      replaceWallet({
        ...(getWallet(userId) || { userId: String(userId), telegramUserId: Number(userId) }),
        balance: result.balance,
        updatedAt: new Date().toISOString(),
      });
    }

    return result;
  } catch (error) {
    console.error(`[WALLETS] Credit failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function debitWallet(userId, amount, refId = null, refType = null, note = null) {
  if (!usingFirestore()) {
    const wallet = jsonStore.getWalletRecord(userId);

    if (!wallet) {
      return { ok: false, error: "no_wallet" };
    }

    const balanceBefore = Number(wallet.balance) || 0;
    const amountNum = Number(amount);

    if (balanceBefore < amountNum) {
      return { ok: false, error: "insufficient_balance" };
    }

    const balanceAfter = balanceBefore - amountNum;

    jsonStore.setWallet({ ...wallet, balance: balanceAfter });

    const txResult = jsonStore.addTransaction({
      userId,
      type: "debit",
      amount: amountNum,
      balanceBefore,
      balanceAfter,
      refId,
      refType,
      note,
    });

    return txResult.ok
      ? { ok: true, balance: balanceAfter, transactionId: txResult.id }
      : { ok: false, error: txResult.error };
  }

  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    let result = { ok: false, error: "not set" };

    await db.runTransaction(async (tx) => {
      const ref = db.collection(firestoreStore.WALLETS).doc(String(userId));
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        result = { ok: false, error: "no_wallet" };
        return;
      }

      const current = { id: snapshot.id, ...snapshot.data() };
      const balanceBefore = Number(current.balance) || 0;
      const amountNum = Number(amount);

      if (balanceBefore < amountNum) {
        result = { ok: false, error: "insufficient_balance" };
        return;
      }

      const balanceAfter = balanceBefore - amountNum;
      current.balance = balanceAfter;
      current.updatedAt = new Date().toISOString();

      tx.set(ref, current, { merge: true });

      const txId = `${String(userId)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const txRef = db.collection(firestoreStore.TRANSACTIONS).doc(txId);

      tx.set(txRef, {
        id: txId,
        userId: String(userId),
        type: "debit",
        amount: amountNum,
        balanceBefore,
        balanceAfter,
        refId: refId || null,
        refType: refType || null,
        note: note || null,
        createdAt: new Date().toISOString(),
      });

      result = { ok: true, balance: balanceAfter, transactionId: txId };
    });

    if (result.ok) {
      replaceWallet({
        ...(getWallet(userId) || { userId: String(userId), telegramUserId: Number(userId) }),
        balance: result.balance,
        updatedAt: new Date().toISOString(),
      });
    }

    return result;
  } catch (error) {
    console.error(`[WALLETS] Debit failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function createRechargeRequest(request) {
  if (!usingFirestore()) {
    return jsonStore.addRechargeRequest(request);
  }

  return firestoreStore.createRechargeRequest(request);
}

async function getRecharge(requestId) {
  if (!usingFirestore()) {
    return jsonStore.getRechargeRequest(requestId);
  }

  return firestoreStore.fetchRecharge(requestId);
}

async function approveRecharge(requestId, adminId) {
  if (!usingFirestore()) {
    const request = jsonStore.getRechargeRequest(requestId);

    if (!request) {
      return { ok: false, error: "Recharge request not found" };
    }

    if (request.status !== "pending") {
      return { ok: false, error: `Recharge is already ${request.status}` };
    }

    jsonStore.updateRechargeRequest(requestId, {
      status: "approved",
      approvedBy: adminId,
      approvedAt: new Date().toISOString(),
    });

    const wallet = jsonStore.getWalletRecord(request.userId) || { userId: request.userId, balance: 0 };
    const balanceBefore = Number(wallet.balance) || 0;
    const balanceAfter = balanceBefore + Number(request.amount);

    jsonStore.setWallet({ ...wallet, userId: request.userId, balance: balanceAfter });

    jsonStore.addTransaction({
      userId: request.userId,
      type: "credit",
      amount: Number(request.amount),
      balanceBefore,
      balanceAfter,
      refId: requestId,
      refType: "recharge",
      note: `Recharge approved via ${request.method}`,
    });

    return { ok: true, balance: balanceAfter };
  }

  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    const requestRef = db.collection(firestoreStore.RECHARGES).doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      return { ok: false, error: "Recharge request not found" };
    }

    const request = requestSnap.data();

    if (request.status !== "pending") {
      return { ok: false, error: `Recharge is already ${request.status}` };
    }

    await db.runTransaction(async (tx) => {
      const walletRef = db.collection(firestoreStore.WALLETS).doc(String(request.userId));
      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.exists
        ? { id: walletSnap.id, ...walletSnap.data() }
        : {
            id: String(request.userId),
            telegramUserId: Number(request.userId),
            balance: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

      const balanceBefore = Number(wallet.balance) || 0;
      const balanceAfter = balanceBefore + Number(request.amount);

      wallet.balance = balanceAfter;
      wallet.updatedAt = new Date().toISOString();

      tx.set(walletRef, wallet, { merge: true });

      const txId = `${String(request.userId)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const txRef = db.collection(firestoreStore.TRANSACTIONS).doc(txId);

      tx.set(txRef, {
        id: txId,
        userId: String(request.userId),
        type: "credit",
        amount: Number(request.amount),
        balanceBefore,
        balanceAfter,
        refId: requestId,
        refType: "recharge",
        note: `Recharge approved via ${request.method}`,
        createdAt: new Date().toISOString(),
      });

      tx.set(requestRef, {
        status: "approved",
        approvedBy: String(adminId),
        approvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    });

    const updatedWallet = await firestoreStore.fetchWallet(request.userId);
    if (updatedWallet) {
      replaceWallet(updatedWallet);
    }

    return { ok: true, balance: Number(updatedWallet?.balance) || 0 };
  } catch (error) {
    console.error(`[WALLETS] Approve recharge failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function rejectRecharge(requestId, adminId, reason = null) {
  if (!usingFirestore()) {
    const request = jsonStore.getRechargeRequest(requestId);

    if (!request) {
      return { ok: false, error: "Recharge request not found" };
    }

    if (request.status !== "pending") {
      return { ok: false, error: `Recharge is already ${request.status}` };
    }

    jsonStore.updateRechargeRequest(requestId, {
      status: "rejected",
      rejectedBy: adminId,
      rejectedAt: new Date().toISOString(),
      rejectReason: reason,
    });

    return { ok: true };
  }

  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    const requestRef = db.collection(firestoreStore.RECHARGES).doc(requestId);
    const requestSnap = await requestRef.get();

    if (!requestSnap.exists) {
      return { ok: false, error: "Recharge request not found" };
    }

    const request = requestSnap.data();

    if (request.status !== "pending") {
      return { ok: false, error: `Recharge is already ${request.status}` };
    }

    await requestRef.set({
      status: "rejected",
      rejectedBy: String(adminId),
      rejectedAt: new Date().toISOString(),
      rejectReason: reason || null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true };
  } catch (error) {
    console.error(`[WALLETS] Reject recharge failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

async function getPendingRecharges(limit = 50) {
  if (!usingFirestore()) {
    return jsonStore.getPendingRechargeRequests(limit);
  }

  return firestoreStore.fetchPendingRecharges(limit);
}

module.exports = {
  hydrate,
  usingFirestore,
  describe,
  setWalletStoreFailureHandler,
  healthCheck,
  closeDb,
  getWallets,
  getWallet,
  getTransactions,
  getUserTransactions,
  createWallet,
  creditWallet,
  debitWallet,
  createRechargeRequest,
  getRecharge,
  approveRecharge,
  rejectRecharge,
  getPendingRecharges,
};
