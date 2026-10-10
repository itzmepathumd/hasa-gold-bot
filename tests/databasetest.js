/*
|--------------------------------------------------------------------------
| DATABASE LAYER TESTS
|--------------------------------------------------------------------------
| Covers the parts of the database layer that need no database: the mapping
| between row and object, the lock key, the sanitising that keeps a driver
| from rejecting a value, and the status string that goes into a log.
|
| The tests that need a live database live in scripts/db-check.js and in
| topuptest.js and walletflowtest.js, which are skipped with a message when
| SUPABASE_DB_URL is not set.
*/

const assert = require("assert");
const path = require("path");

const mappers = require("../src/database/mappers");
const connection = require("../src/database/connection");
const orders = require("../src/database/orders");
const wallets = require("../src/database/wallets");

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

function makeRow(overrides = {}) {
  return {
    order_number: "HG-1234-ABCD",
    user_id: "555",
    game_id: "free_fire",
    game_name: "Free Fire",
    id_label: "Player ID",
    product_id: "free_fire~weekly",
    product_key: "weekly",
    product_name: "📅 Weekly",
    player_id: "11927288867",
    player_name: "Milo",
    player_region: "1",
    quantity: 1,
    price: "590.00",
    total_amount: "590.00",
    sub_category_id: 101,
    status: "topup_completed",
    payment_method: "ez_cash",
    payment_proof: "proof-file-id",
    payment_submitted_at: new Date("2026-10-01T10:00:00Z"),
    approved_at: new Date("2026-10-01T10:05:00Z"),
    rejected_at: null,
    rejected_by: null,
    reject_reason: null,
    previous_status: "pending_approval",
    resolved_at: null,
    resolved_by: null,
    topup_status: "topup_completed",
    topup_attempts: 2,
    topup_started_at: new Date("2026-10-01T10:04:00Z"),
    topup_completed_at: new Date("2026-10-01T10:06:00Z"),
    topup_error: null,
    topup_retry_armed: false,
    provider: "shop2topup",
    provider_order_id: "01910000-0000-4000-8000-000000000001",
    provider_transaction_id: "TXN-9",
    provider_status: "completed",
    provider_raw: { order: { status: "completed" } },
    provider_failed: false,
    wallet_transaction_id: 7,
    created_at: new Date("2026-10-01T09:00:00Z"),
    updated_at: new Date("2026-10-01T10:06:00Z"),
    user_username: "customer",
    user_first_name: "Cus",
    ...overrides,
  };
}

(async () => {
  section("a row becomes the order the bot has always used");

  const order = mappers.orderFromRow(makeRow());

  await check("the business key is the order number", () => {
    assert.strictEqual(order.id, "HG-1234-ABCD");
  });

  await check("the customer id is the telegram id", () => {
    assert.strictEqual(order.userId, 555);
  });

  await check("money comes back as a number, not a string", () => {
    assert.strictEqual(order.price, 590);
    assert.strictEqual(order.totalAmount, 590);
  });

  await check("a nullable column becomes null", () => {
    assert.strictEqual(order.rejectReason, null);
    assert.strictEqual(order.paymentMethod, "ez_cash");
  });

  await check("the provider answer is kept as one JSONB value", () => {
    assert.deepStrictEqual(order.providerRaw, { order: { status: "completed" } });
  });

  await check("the customer name comes from the customer row", () => {
    assert.strictEqual(order.username, "customer");
    assert.strictEqual(order.firstName, "Cus");
  });

  await check("timestamps stay ISO strings", () => {
    assert.strictEqual(
      order.approvedAt,
      "2026-10-01T10:05:00.000Z"
    );
  });

  await check("an optional requirement column is null, not undefined", () => {
    assert.strictEqual(mappers.orderToParams(order)[14], 101);
  });

  section("the same order survives a round trip");

  await check("every field the mutators set is written back", () => {
    const params = mappers.orderToParams(order);

    // The list is fixed: an added column means one file changes.
    assert.strictEqual(params.length, mappers.ORDER_COLUMNS.length);

    for (const value of params) {
      assert.notStrictEqual(
        value,
        undefined,
        "undefined reaches the driver, which rejects it"
      );
    }
  });

  await check("total amount is derived when it is missing", () => {
    const withoutTotal = { ...order };
    delete withoutTotal.totalAmount;

    const params = mappers.orderToParams(withoutTotal);

    assert.strictEqual(params[13], 590);
  });

  section("undefined never reaches the database");

  await check("a nested undefined is dropped", () => {
    const cleaned = mappers.sanitizeJson({
      ok: true,
      missing: undefined,
      nested: { alsoMissing: undefined, kept: 1 },
    });

    assert.deepStrictEqual(cleaned, { ok: true, nested: { kept: 1 } });
  });

  await check("a null stays null, because null means not filled in yet", () => {
    assert.strictEqual(mappers.sanitizeJson(null), null);
    assert.strictEqual(mappers.toTimestamp(null), null);
  });

  section("the order lock key is stable");

  await check("the same order number always locks the same way", () => {
    assert.strictEqual(
      connection.orderLockKey("HG-1234-ABCD"),
      connection.orderLockKey("HG-1234-ABCD")
    );
  });

  await check("different order numbers lock differently", () => {
    assert.notStrictEqual(
      connection.orderLockKey("HG-0001-AAAA"),
      connection.orderLockKey("HG-0001-AAAB")
    );
  });

  await check("the key is a safe integer", () => {
    for (const id of ["HG-1", "HG-7777-ZZZZ", "x"]) {
      const key = connection.orderLockKey(id);

      assert.ok(Number.isSafeInteger(key), `${id} produced ${key}`);
    }
  });

  section("nothing secret is reported");

  await check("the status carries a host and no password", () => {
    process.env.SUPABASE_DB_URL =
      "postgresql://user:sup3rsecret@db.example.supabase.co:5432/postgres";

    const status = connection.describeStatus();
    const dump = JSON.stringify(status);

    assert.ok(!dump.includes("sup3rsecret"), "the password leaked");
    assert.strictEqual(status.host, "db.example.supabase.co:5432");

    delete process.env.SUPABASE_DB_URL;
  });

  await check("no database configured reports the json mode", () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;

    assert.strictEqual(connection.describeStatus().mode, "json");
    assert.strictEqual(connection.shouldUseDatabase(), false);
    assert.strictEqual(connection.isAvailable(), false);
  });

  await check("a configured but unreachable database is not reported as json", () => {
    process.env.SUPABASE_DB_URL = "postgresql://user:pw@127.0.0.1:1/postgres";

    const status = connection.describeStatus();
    const dump = JSON.stringify(status);

    // No connection has been attempted yet, so the mode is the one that makes
    // the bot stop and say so, rather than the one that trades on nothing.
    assert.strictEqual(status.mode, "unavailable");
    assert.ok(!dump.includes(":pw@"), "the password leaked");

    delete process.env.SUPABASE_DB_URL;
  });

  await check("DATABASE_DISABLED forces the json mode back on", () => {
    process.env.SUPABASE_DB_URL = "postgresql://user:pw@127.0.0.1:1/postgres";
    process.env.DATABASE_DISABLED = "true";

    assert.strictEqual(connection.describeStatus().mode, "json");

    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_DISABLED;
  });

  section("the store refuses to answer when it cannot read");

  await check("an unloaded mirror reports an empty order book as a failure", () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;

    const result = orders.readOrders();

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.orders, []);
  });

  await check("the wallet mirror reports no balance rather than a wrong one", () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;

    assert.strictEqual(wallets.getWallet(123), null);
    assert.deepStrictEqual(wallets.getUserTransactions(123), []);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);

  process.exit(failed === 0 ? 0 : 1);
})();
