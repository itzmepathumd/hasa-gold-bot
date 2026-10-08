/*
|--------------------------------------------------------------------------
| WALLET JSON STORE
|--------------------------------------------------------------------------
| Local fallback when Firestore is not configured.
|
| Files used:
|
|   wallets.json           one record per Telegram user
|   wallet_transactions.json  the ledger: every credit and debit
|   recharge_requests.json    pending recharges awaiting approval
|
| Writes go through a write-chain so a crash cannot truncate the JSON
| files and leave the shop with an empty wallet book.
*/

const fs = require("fs");
const path = require("path");

const WALLETS_FILE = "./wallets.json";
const WALLETS_TMP = "./wallets.json.tmp";
const WALLETS_PREV = "./wallets.prev.json";

const TRANSACTIONS_FILE = "./wallet_transactions.json";
const TRANSACTIONS_TMP = "./wallet_transactions.json.tmp";
const TRANSACTIONS_PREV = "./wallet_transactions.prev.json";

const RECHARGES_FILE = "./recharge_requests.json";
const RECHARGES_TMP = "./recharge_requests.json.tmp";
const RECHARGES_PREV = "./recharge_requests.prev.json";

let failureHandler = async () => {};

function setFailureHandler(handler) {
  failureHandler = handler;
}

function readFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return { data: [], error: null };
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(content);

    return { data, error: null };
  } catch (error) {
    return { data: [], error: `${label}: ${error.message}` };
  }
}

function writeFile(filePath, tmpPath, prevPath, data, label) {
  const json = JSON.stringify(data, null, 2);
  const tmp = tmpPath;
  const prev = prevPath;

  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, prev);
    }

    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, filePath);

    return true;
  } catch (error) {
    failureHandler(`${label}: ${error.message}`).catch(() => {});

    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }

    return false;
  }
}

function readWallets() {
  return readFile(WALLETS_FILE, "wallets.json");
}

function readTransactions() {
  return readFile(TRANSACTIONS_FILE, "wallet_transactions.json");
}

function readRecharges() {
  return readFile(RECHARGES_FILE, "recharge_requests.json");
}

function init() {
  const wallets = readWallets();
  const transactions = readTransactions();
  const recharges = readRecharges();

  if (wallets.error || transactions.error || recharges.error) {
    return wallets.error || transactions.error || recharges.error;
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| WALLETS
|--------------------------------------------------------------------------
*/

function getWalletRecord(userId) {
  const { data } = readWallets();
  const id = String(userId);

  return data.find((w) => String(w.userId) === id) || null;
}

function setWallet(wallet) {
  const { data } = readWallets();
  const id = String(wallet.userId);
  const index = data.findIndex((w) => String(w.userId) === id);

  const record = { ...wallet, updatedAt: new Date().toISOString() };

  if (index === -1) {
    data.push(record);
  } else {
    data[index] = record;
  }

  return writeFile(WALLETS_FILE, WALLETS_TMP, WALLETS_PREV, data, "wallets.json");
}

function createWallet(userId, initialBalance = 0) {
  const { data } = readWallets();
  const id = String(userId);

  if (data.some((w) => String(w.userId) === id)) {
    return { ok: false, error: `Wallet ${userId} already exists`, duplicate: true };
  }

  const wallet = {
    telegramUserId: Number(userId),
    userId: id,
    balance: initialBalance,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  data.push(wallet);

  const written = writeFile(WALLETS_FILE, WALLETS_TMP, WALLETS_PREV, data, "wallets.json");

  return written ? { ok: true, error: null } : { ok: false, error: "Failed to write wallets.json" };
}

/*
|--------------------------------------------------------------------------
| TRANSACTIONS
|--------------------------------------------------------------------------
*/

function addTransaction(tx) {
  const { data } = readTransactions();
  const id = tx.id || `${String(tx.userId)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const record = {
    id,
    userId: String(tx.userId),
    type: tx.type,
    amount: Number(tx.amount),
    balanceBefore: Number(tx.balanceBefore),
    balanceAfter: Number(tx.balanceAfter),
    refId: tx.refId || null,
    refType: tx.refType || null,
    note: tx.note || null,
    createdAt: new Date().toISOString(),
  };

  data.push(record);

  const written = writeFile(TRANSACTIONS_FILE, TRANSACTIONS_TMP, TRANSACTIONS_PREV, data, "wallet_transactions.json");

  return written ? { ok: true, id } : { ok: false, id: null, error: "Failed to write wallet_transactions.json" };
}

function getUserTransactions(userId, limit = 50) {
  const { data } = readTransactions();
  const id = String(userId);

  return data
    .filter((t) => String(t.userId) === id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

/*
|--------------------------------------------------------------------------
| RECHARGE REQUESTS
|--------------------------------------------------------------------------
*/

function getRechargeRequests() {
  const { data } = readRecharges();

  return data;
}

function getRechargeRequest(requestId) {
  const { data } = readRecharges();

  return data.find((r) => r.id === requestId) || null;
}

function getUserRechargeRequests(userId) {
  const { data } = readRecharges();
  const id = String(userId);

  return data
    .filter((r) => String(r.userId) === id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getPendingRechargeRequests(limit = 50) {
  const { data } = readRecharges();

  return data
    .filter((r) => r.status === "pending")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, limit);
}

function addRechargeRequest(request) {
  const { data } = readRecharges();
  const id = request.id || `RCH_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const record = {
    id,
    userId: String(request.userId),
    amount: Number(request.amount),
    method: request.method,
    status: request.status || "pending",
    paymentProof: request.paymentProof || null,
    note: request.note || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (data.some((r) => r.id === id)) {
    return { ok: false, id: null, error: `Recharge request ${id} already exists`, duplicate: true };
  }

  data.push(record);

  const written = writeFile(RECHARGES_FILE, RECHARGES_TMP, RECHARGES_PREV, data, "recharge_requests.json");

  return written ? { ok: true, id } : { ok: false, id: null, error: "Failed to write recharge_requests.json" };
}

function updateRechargeRequest(requestId, updates) {
  const { data } = readRecharges();
  const index = data.findIndex((r) => r.id === requestId);

  if (index === -1) {
    return { ok: false, error: `Recharge request ${requestId} not found` };
  }

  data[index] = { ...data[index], ...updates, updatedAt: new Date().toISOString() };

  const written = writeFile(RECHARGES_FILE, RECHARGES_TMP, RECHARGES_PREV, data, "recharge_requests.json");

  return written ? { ok: true } : { ok: false, error: "Failed to write recharge_requests.json" };
}

module.exports = {
  WALLETS_FILE,
  TRANSACTIONS_FILE,
  RECHARGES_FILE,
  setFailureHandler,
  init,
  getWalletRecord,
  setWallet,
  createWallet,
  addTransaction,
  getUserTransactions,
  getRechargeRequests,
  getRechargeRequest,
  getUserRechargeRequests,
  getPendingRechargeRequests,
  addRechargeRequest,
  updateRechargeRequest,
};
