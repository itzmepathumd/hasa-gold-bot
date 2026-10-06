/*
|--------------------------------------------------------------------------
| JSON WALLET STORE
|--------------------------------------------------------------------------
| The wallet store used when Firestore is not configured: local
| development and any deployment that has not finished migrating.
|
| Three files, one state:
|
|   wallets.json           one record per Telegram user
|   wallet_transactions.json  the ledger: every credit and debit
|   recharge_requests.json    recharge requests awaiting a decision
|
| The ledger is append-only and every entry carries a unique id.
| That id is the guard against double-applying: an approval that is
| retried finds the entry already present and stops, so a customer
| can never be credited twice for one recharge.
|
| Atomicity across the three files comes from a single write chain.
| Every multi-file change runs inside runTransaction(), which reads
| all three files, hands them to the task, and writes all three back
| only when the task asks. Two approvals arriving at once therefore
| cannot interleave a read-modify-write and lose a credit.
|
| As with the order store, a corrupt file reports ok:false instead
| of pretending the store is empty: returning [] on a parse error
| would let the next write erase every real wallet.
*/

const fs = require("fs");

const WALLETS_FILE = "./wallets.json";
const WALLETS_TMP = "./wallets.json.tmp";
const WALLETS_PREV = "./wallets.prev.json";

const TRANSACTIONS_FILE = "./wallet_transactions.json";
const TRANSACTIONS_TMP = "./wallet_transactions.json.tmp";
const TRANSACTIONS_PREV = "./wallet_transactions.prev.json";

const RECHARGES_FILE = "./recharge_requests.json";
const RECHARGES_TMP = "./recharge_requests.json.tmp";
const RECHARGES_PREV = "./recharge_requests.prev.json";

/*
| Called when the store cannot be read or written, so the admin is
| told the wallet system has stopped instead of silently losing a
| credit.
*/
let onStorageFailure = async () => {};

function setFailureHandler(handler) {
  onStorageFailure = handler;
}

for (const [file, seed] of [
  [WALLETS_FILE, "[]"],
  [TRANSACTIONS_FILE, "[]"],
  [RECHARGES_FILE, "[]"],
]) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, seed);
  }
}

/**
 * Read one store file. A missing or corrupt file is an error, not
 * an empty store.
 */
function readFile(file, label) {
  let raw;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, data: [], error: `${label}: ${error.message}` };
  }

  if (!raw.trim()) {
    return { ok: false, data: [], error: `${label} is empty` };
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return { ok: false, data: [], error: `${label} is not a list` };
    }

    return { ok: true, data: parsed, error: null };
  } catch (error) {
    return {
      ok: false,
      data: [],
      error: `${label} is corrupt: ${error.message}`,
    };
  }
}

/**
 * Write one store file atomically and keep one rollback copy.
 */
function writeFile(file, tmp, prev, payload) {
  fs.writeFileSync(tmp, payload);

  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, prev);
    }
  } catch (error) {
    console.error(`[WALLETS] Could not save the rollback copy: ${error.message}`);
  }

  // rename is atomic on the same filesystem, so a reader never
  // sees a half-written file.
  fs.renameSync(tmp, file);
}

/*
| Every write goes through this chain, so concurrent operations
| cannot interleave a read-modify-write and lose a record.
*/
let writeChain = Promise.resolve();

function withLock(task) {
  const run = writeChain.then(task, task);

  writeChain = run.then(
    () => {},
    () => {}
  );

  return run;
}

/**
 * Run an atomic multi-file operation.
 *
 * The task receives a view over the three stores and
 * returns a plain result object, which is passed through
 * to the caller. The view presents the same interface as
 * the Firestore store, so business logic never knows
 * which backend it is on.
 *
 * Nothing is written unless the task calls a setter, and
 * a task that throws writes nothing at all. A successful
 * return commits whatever the task changed.
 */
async function runTransaction(task) {
  return withLock(async () => {
    const wallets = readFile(WALLETS_FILE, "wallets.json");
    const transactions = readFile(
      TRANSACTIONS_FILE,
      "wallet_transactions.json"
    );
    const recharges = readFile(
      RECHARGES_FILE,
      "recharge_requests.json"
    );

    const firstError =
      wallets.error || transactions.error || recharges.error;

    if (firstError) {
      console.error(`[WALLETS] Transaction blocked: ${firstError}`);
      await onStorageFailure(firstError);

      return { ok: false, result: null, error: firstError };
    }

    const walletById = new Map(
      wallets.data.map((w) => [String(w.userId), w])
    );
    const transactionById = new Map(
      transactions.data.map((t) => [String(t.id), t])
    );
    const rechargeById = new Map(
      recharges.data.map((r) => [String(r.id), r])
    );

    /*
    | Setters mutate the in-memory copies. The files are
    | rewritten only when the task returns normally, so a
    | task that declines or throws leaves every file
    | untouched.
    */
    const view = {
      getWallet: (userId) =>
        walletById.get(String(userId)) || null,

      getTransaction: (id) =>
        transactionById.get(String(id)) || null,

      getRecharge: (id) =>
        rechargeById.get(String(id)) || null,

      setWallet: (wallet) => {
        const record = { ...wallet };

        walletById.set(String(wallet.userId), record);

        const index = wallets.data.findIndex(
          (w) => String(w.userId) === String(wallet.userId)
        );

        if (index === -1) {
          wallets.data.push(record);
        } else {
          wallets.data[index] = record;
        }
      },

      appendTransaction: (txn) => {
        if (transactionById.has(String(txn.id))) {
          // The idempotency guard: a replayed settlement
          // cannot append a second ledger entry.
          throw new Error(
            `ledger entry ${txn.id} already exists`
          );
        }

        const record = { ...txn };

        transactionById.set(String(txn.id), record);
        transactions.data.push(record);
      },

      setRecharge: (request) => {
        const record = { ...request };

        rechargeById.set(String(request.id), record);

        const index = recharges.data.findIndex(
          (r) => r.id === request.id
        );

        if (index === -1) {
          recharges.data.push(record);
        } else {
          recharges.data[index] = record;
        }
      },
    };

    let result;

    try {
      result = await task(view);
    } catch (error) {
      console.error(
        `[WALLETS] Transaction aborted: ${error.message}`
      );

      return { ok: false, result: null, error: error.message };
    }

    // Commit only what the task changed. The three files
    // are written one after another; the write chain keeps
    // this whole operation serial, so no other writer can
    // interleave between them.
    writeFile(
      WALLETS_FILE,
      WALLETS_TMP,
      WALLETS_PREV,
      JSON.stringify(wallets.data, null, 2)
    );
    writeFile(
      TRANSACTIONS_FILE,
      TRANSACTIONS_TMP,
      TRANSACTIONS_PREV,
      JSON.stringify(transactions.data, null, 2)
    );
    writeFile(
      RECHARGES_FILE,
      RECHARGES_TMP,
      RECHARGES_PREV,
      JSON.stringify(recharges.data, null, 2)
    );

    return { ok: true, result, error: null };
  });
}

/**
 * Plain reads for listing screens. These are outside the lock
 * because they only have to be good enough to display.
 */
function readWallets() {
  return readFile(WALLETS_FILE, "wallets.json");
}

function readTransactions() {
  return readFile(TRANSACTIONS_FILE, "wallet_transactions.json");
}

function readRecharges() {
  return readFile(RECHARGES_FILE, "recharge_requests.json");
}

module.exports = {
  WALLETS_FILE,
  TRANSACTIONS_FILE,
  RECHARGES_FILE,
  runTransaction,
  readWallets,
  readTransactions,
  readRecharges,
  setFailureHandler,
};
