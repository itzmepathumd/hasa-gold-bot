/*
|--------------------------------------------------------------------------
| WALLET TESTS
|--------------------------------------------------------------------------
| Exercises the wallet system end to end against both backends:
| the JSON files (run from a scratch directory) and the Firestore
| path (through the in-memory double).
|
| These tests are the reason the security model can be trusted
| before it meets a real customer: they drive the actual
| wallet.js and the actual store layers, not a re-implementation.
|
| Each run works inside its own scratch directory, so the JSON
| backend can never pick up state from an earlier run.
*/

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

/*
| The JSON backend keeps its files in the working
| directory, so each run gets its own empty scratch
| directory and can never see state from an earlier
| run. The modules are required only after the
| switch, because the store creates its files as it
| loads.
*/
const REPO = __dirname;

const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "wallettest-")
);

process.chdir(scratch);

const { FakeFirestore } = require(
  path.join(REPO, "tests", "fakeFirestore")
);
const firestoreConnection = require(
  path.join(REPO, "src", "database", "firestore")
);
const walletStore = require(
  path.join(REPO, "src", "database", "wallets")
);
const wallet = require(path.join(REPO, "src", "wallet"));

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();

    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

const ADMIN = 111;
const CUSTOMER = 222;

/**
 * Reset the store to the JSON backend, which is what the
 * process uses when no Firebase credentials are present.
 */
async function useJsonBackend() {
  delete process.env.FIRESTORE_ENABLED;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;

  firestoreConnection.__setDbForTests(null);

  return walletStore.hydrate();
}

/**
 * Put the store on the Firestore path with a fresh double.
 */
async function useFakeFirestore() {
  const fake = new FakeFirestore();

  process.env.FIRESTORE_ENABLED = "true";
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_CLIENT_EMAIL =
    "test@example.iam.gserviceaccount.com";
  process.env.FIREBASE_PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n";

  firestoreConnection.__setDbForTests(fake);

  await walletStore.hydrate();

  return fake;
}

async function resetStore() {
  // The JSON backend keeps its files in the working
  // directory, which the runner empties before this
  // script starts. The Firestore double is replaced
  // wholesale by useFakeFirestore().
  await useJsonBackend();
}(async () => {
  console.log("WALLET TESTS");
  console.log("============");

  await resetStore();

  /*
  |--------------------------------------------------------------------------
  | RECHARGE REQUEST VALIDATION
  |--------------------------------------------------------------------------
  */

  section("recharge requests");

  await check("rejects an amount below the minimum", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      5,
      "file_1"
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "amount_too_small");
  });

  await check("rejects an amount above the maximum", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      500001,
      "file_1"
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "amount_too_large");
  });

  await check("rejects a non-integer amount", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      "12.5",
      "file_1"
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_amount");
  });

  await check("rejects a non-numeric amount", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      "free money",
      "file_1"
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "invalid_amount");
  });

  let request;

  await check("accepts a valid request without crediting", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      1000,
      "file_1"
    );

    assert.strictEqual(result.ok, true);

    request = result.request;

    assert.strictEqual(request.amount, 1000);
    assert.strictEqual(request.status, "pending");
    assert.strictEqual(request.proof, "file_1");
    assert.ok(request.expiresAt);

    // A request is not money. The balance must not move.
    assert.strictEqual(wallet.getBalance(CUSTOMER), 0);
  });

  await check("refuses a second open request", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      500,
      "file_2"
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "request_pending");
  });

  /*
  |--------------------------------------------------------------------------
  | APPROVAL: THE ONLY CREDIT PATH
  |--------------------------------------------------------------------------
  */

  section("approval credits the wallet");

  await check("approving credits exactly the requested amount", async () => {
    const result = await wallet.approveRecharge(ADMIN, request.id);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.wallet.balance, 1000);

    assert.strictEqual(wallet.getBalance(CUSTOMER), 1000);

    const history = wallet.getHistory(CUSTOMER);

    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].type, "credit");
    assert.strictEqual(history[0].amount, 1000);
    assert.strictEqual(history[0].balanceAfter, 1000);
    assert.strictEqual(history[0].refId, request.id);
  });

  await check("approving the same request twice credits once", async () => {
    const result = await wallet.approveRecharge(ADMIN, request.id);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.declined, "already_decided");

    assert.strictEqual(wallet.getBalance(CUSTOMER), 1000);

    const history = wallet.getHistory(CUSTOMER);

    assert.strictEqual(history.length, 1);
  });

  await check("a request cannot be approved after rejection", async () => {
    const second = await wallet.requestRecharge(
      CUSTOMER,
      250,
      "file_3"
    );

    assert.strictEqual(second.ok, true);

    const rejected = await wallet.rejectRecharge(
      ADMIN,
      second.request.id,
      "proof unclear"
    );

    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(rejected.rejected, true);

    const later = await wallet.approveRecharge(
      ADMIN,
      second.request.id
    );

    assert.strictEqual(later.ok, true);
    assert.strictEqual(later.declined, "already_decided");

    // Nothing was ever credited.
    assert.strictEqual(wallet.getBalance(CUSTOMER), 1000);
  });

  await check("an expired request cannot be approved", async () => {
    const third = await wallet.requestRecharge(
      CUSTOMER,
      250,
      "file_4"
    );

    assert.strictEqual(third.ok, true);

    // Age the request past its 24 hour life inside the
    // store, then try to approve it.
    await walletStore.runTransaction(async (view) => {
      const stale = await view.getRecharge(
        third.request.id
      );

      view.setRecharge({
        ...stale,
        expiresAt: "2000-01-01T00:00:00.000Z",
      });

      return { ok: true };
    });

    const result = await wallet.approveRecharge(
      ADMIN,
      third.request.id
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.declined, "expired");

    assert.strictEqual(wallet.getBalance(CUSTOMER), 1000);
  });

  /*
  |--------------------------------------------------------------------------
  | SPENDING: THE ONLY DEBIT PATH
  |--------------------------------------------------------------------------
  */

  section("order payments debit the wallet");

  await check("paying an order debits the balance once", async () => {
    const result = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000001-AAAAAA",
      590
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.alreadySpent, false);
    assert.strictEqual(result.wallet.balance, 410);

    assert.strictEqual(wallet.getBalance(CUSTOMER), 410);

    const history = wallet.getHistory(CUSTOMER);

    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].type, "debit");
    assert.strictEqual(history[0].amount, 590);
    assert.strictEqual(history[0].refId, "HG-000001-AAAAAA");
  });

  await check("paying the same order again does not debit again", async () => {
    const result = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000001-AAAAAA",
      590
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.alreadySpent, true);

    assert.strictEqual(wallet.getBalance(CUSTOMER), 410);

    const history = wallet.getHistory(CUSTOMER);

    assert.strictEqual(history.length, 2);
  });

  await check("a debit larger than the balance is refused", async () => {
    const before = wallet.getBalance(CUSTOMER);

    const result = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000002-BBBBBB",
      before + 1
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "insufficient_balance");

    assert.strictEqual(wallet.getBalance(CUSTOMER), before);
  });

  await check("a customer with no wallet cannot spend", async () => {
    const result = await wallet.spendForOrder(
      999,
      "HG-000003-CCCCCC",
      10
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, "no_wallet");
  });

  await check("a different order debits again", async () => {
    const result = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000004-DDDDDD",
      410
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.wallet.balance, 0);

    assert.strictEqual(wallet.getBalance(CUSTOMER), 0);
  });

  /*
  |--------------------------------------------------------------------------
  | LEDGER INTEGRITY
  |--------------------------------------------------------------------------
  */

  section("ledger integrity");

  await check("the ledger explains the balance exactly", async () => {
    const history = wallet.getHistory(CUSTOMER, 100);

    const credits = history
      .filter((t) => t.type === "credit")
      .reduce((sum, t) => sum + t.amount, 0);

    const debits = history
      .filter((t) => t.type === "debit")
      .reduce((sum, t) => sum + t.amount, 0);

    assert.strictEqual(credits - debits, wallet.getBalance(CUSTOMER));

    // Every entry carries the running balance, so the
    // chain can be replayed by hand.
    let running = 0;

    for (const entry of history.slice().reverse()) {
      if (entry.type === "credit") {
        running += entry.amount;
      } else {
        running -= entry.amount;
      }

      assert.strictEqual(entry.balanceAfter, running);
    }
  });

  /*
  |--------------------------------------------------------------------------
  | FIRESTORE PATH
  |--------------------------------------------------------------------------
  */

  section("the Firestore path");

  await useFakeFirestore();

  let fsRequest;

  await check("a request and approval work on Firestore", async () => {
    const result = await wallet.requestRecharge(
      CUSTOMER,
      2000,
      "file_fs"
    );

    assert.strictEqual(result.ok, true);

    fsRequest = result.request;

    const approved = await wallet.approveRecharge(
      ADMIN,
      fsRequest.id
    );

    assert.strictEqual(approved.ok, true);
    assert.strictEqual(approved.wallet.balance, 2000);

    // The mirror must reflect the commit.
    assert.strictEqual(wallet.getBalance(CUSTOMER), 2000);
  });

  await check("a replayed approval is declined on Firestore", async () => {
    const result = await wallet.approveRecharge(ADMIN, fsRequest.id);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.declined, "already_decided");

    assert.strictEqual(wallet.getBalance(CUSTOMER), 2000);

    assert.strictEqual(
      wallet.getHistory(CUSTOMER).length,
      1
    );
  });

  await check("spending works on Firestore and is idempotent", async () => {
    const first = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000010-FFFFFFFF",
      750
    );

    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.wallet.balance, 1250);

    const replay = await wallet.spendForOrder(
      CUSTOMER,
      "HG-000010-FFFFFFFF",
      750
    );

    assert.strictEqual(replay.ok, true);
    assert.strictEqual(replay.alreadySpent, true);

    assert.strictEqual(wallet.getBalance(CUSTOMER), 1250);
    assert.strictEqual(
      wallet.getHistory(CUSTOMER).length,
      2
    );
  });

  await check("concurrent approvals cannot double-credit", async () => {
    // Two requests, approved at the same instant. Each must
    // land exactly once, because the transactions are
    // serialised and each re-reads the request state.
    const a = await wallet.requestRecharge(CUSTOMER, 100, "fa");
    const b = await wallet.requestRecharge(CUSTOMER, 100, "fb");

    // The one-open-request rule means the second fails, so
    // this scenario is built by approving the same request
    // twice concurrently instead.
    assert.strictEqual(a.ok, true);
    assert.strictEqual(b.error, "request_pending");

    const balanceBefore = wallet.getBalance(CUSTOMER);

    const [one, two] = await Promise.all([
      wallet.approveRecharge(ADMIN, a.request.id),
      wallet.approveRecharge(ADMIN, a.request.id),
    ]);

    const credited = [one, two].filter(
      (r) => r.ok && r.approved
    ).length;

    assert.strictEqual(credited, 1);

    assert.strictEqual(
      wallet.getBalance(CUSTOMER),
      balanceBefore + 100
    );
  });

  await check("the admin audit lists every movement", async () => {
    const audit = wallet.getAudit(100);

    assert.ok(audit.length >= 3);

    for (const entry of audit) {
      assert.ok(entry.id, "ledger entry has an id");
      assert.ok(["credit", "debit"].includes(entry.type));
      assert.strictEqual(
        typeof entry.amount,
        "number",
        "amount is a number"
      );
    }
  });

  console.log(
    `\n${passed} passed, ${failed} failed`
  );

  process.exit(failed === 0 ? 0 : 1);
})();
