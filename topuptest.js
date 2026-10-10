// The pool below is built from the connection string at load time, so the
// environment has to be read before it, not after.
require("dotenv").config();

const fs = require("fs");
const path = require("path");

// index.js refuses to load without a token. These tests stub every Telegram
// call, so a fake one is enough.
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456:FAKE_TOKEN_FOR_TESTS";
process.env.ADMIN_ID = process.env.ADMIN_ID || "1";

/*
|--------------------------------------------------------------------------
| TOP-UP TEST
|--------------------------------------------------------------------------
| Fulfilment moves real money, and the provider charges the wallet the moment
| an order is created, so these checks are all about the ways a customer
| could be harmed:
|
|   - a double-tapped Approve must not place two orders,
|   - the idempotency key must be stored BEFORE the provider is called, so a
|     crash mid-call leaves something that can be read back,
|   - a retry must reuse that key, so it cannot buy a second top-up,
|   - a request whose outcome is unknown must never be resent under a new
|     key, because the first one may already have been paid for,
|   - a package with no provider product must never be ordered,
|   - concurrent writes must not lose orders,
|   - a corrupt orders.json must block writes rather than silently
|     overwrite every order with nothing.
|
| Every Telegram call is stubbed, so nothing leaves the machine.
*/

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log(
      "  FAIL  " + label + (detail ? "  -> " + detail : "")
    );
  }
}

/*
| Orders are seeded through the store, not through a file: the orders live in
| PostgreSQL now, and a test that wrote a JSON file would be testing the
| backup rather than the database.
|
| Every seeded id carries TEST in it, so a crash cannot leave rows behind
| that the next run would then delete as somebody else's data.
*/
const TEST_ORDER_MARKER = process.env.TEST_ORDER_MARKER || "HG-TEST";

// The customer the seeded orders belong to.
const TEST_USER_ID = 100;

const pool = new (require("pg").Pool)({
  connectionString:
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

function testOrderIds() {
  return pool.query(
    `SELECT order_number FROM orders WHERE order_number LIKE $1`,
    [`${TEST_ORDER_MARKER}%`]
  );
}

function isTestOrderId(id) {
  return String(id || "").startsWith(TEST_ORDER_MARKER);
}

/**
 * Replace the order book with exactly these orders.
 */
async function saveOrdersFile(orders) {
  const seeded = orders.filter((order) => isTestOrderId(order.id));

  const existing = await testOrderIds();

  await pool.query(
    `DELETE FROM orders WHERE order_number = ANY($1::text[])`,
    [existing.rows.map((row) => row.order_number)]
  );

  for (const order of seeded) {
    const created = await botModule.appendOrder(order);

    if (!created) {
      throw new Error(`Could not seed the order ${order.id}`);
    }
  }
}

function restoreOrders() {
  // Nothing to restore: the database is the record, and every seeded row is
  // removed by the next call to saveOrdersFile() or by the cleanup below.
}

function baseOrder(overrides = {}) {
  const order = {
    id: "HG-TEST-0001",
    userId: TEST_USER_ID,
    username: "tester",
    firstName: "Tester",
    playerId: "8595647532",
    playerName: "Pro",
    playerRegion: "Asia",
    gameId: "free_fire",
    gameName: "Free Fire",
    idLabel: "Player ID",
    productKey: "weekly",
    productName: "📅 Weekly",
    subCategoryId: 110,
    price: 590,
    status: "pending_approval",
    paymentProof: "FILEID",
    createdAt: new Date().toISOString(),
    paymentSubmittedAt: new Date().toISOString(),
    approvedAt: null,
    rejectedAt: null,
    topupStatus: null,
    topupAttempts: 0,
    providerOrderId: null,
    providerTransactionId: null,
    providerStatus: null,
    providerRaw: null,
    topupRetryArmed: false,
    topupStartedAt: null,
    topupCompletedAt: null,
    topupError: null,
    ...overrides,
  };

  // The schema refuses an approved order without an approved_at, so the seed
  // keeps the pair consistent instead of relying on each caller to remember.
  if (order.status === "approved" && !order.approvedAt) {
    order.approvedAt = new Date().toISOString();
  }

  return order;
}

// Stub the Telegram surface before index.js is required, so requiring it
// cannot reach the network and handlers can be driven directly.
const telegramPath = path.dirname(
  require.resolve("telegraf")
);
const telegramModule = require(path.join(telegramPath, "telegram.js"));
const Telegram =
  telegramModule.Telegram || telegramModule.default;

async function stub(...args) {
  return { message_id: 1 };
}

for (const method of [
  "sendMessage",
  "editMessageText",
  "sendPhoto",
  "sendChatAction",
  "answerCallbackQuery",
  "setMyCommands",
  "deleteMessage",
]) {
  Telegram.prototype[method] = stub;
}

const Telegraf = require("telegraf").Telegraf;

/*
| This test drives the real order database, so it needs one. A local
| PostgreSQL with the schema loaded is enough; a Supabase project works too.
| Without a database the test cannot run, and it says so rather than passing
| on an empty store.
*/
const connection = require("./src/database/connection");

if (!connection.shouldUseDatabase()) {
  console.log(
    "\n== TOP-UP TEST SKIPPED ==\n" +
      "   Needs SUPABASE_DB_URL. Run the schema first (npm run db:schema),\n" +
      "   then set the connection string in .env and re-run.\n"
  );
  process.exit(0);
}


Telegraf.prototype.launch = async function () {};
Telegraf.prototype.stop = async function () {};

const botModule = require("./index.js");
const app = botModule.bot;

console.log("\n== loading the bot ==");

check(
  "index.js exports what the tests need",
  typeof botModule.processAutoTopup === "function" &&
    typeof botModule.runStartupRecovery === "function" &&
    typeof botModule.resolveTopupOrder === "function" &&
    typeof botModule.reviewingOrders === "function" &&
    typeof botModule.topupProvider === "object"
);

/*
| The provider is replaced so no order can leave the machine. What the stub
| records is what matters here: the key that was sent, and what the order
| record held at the moment the provider was called.
*/
const placed = [];
let minted = 0;

function stubProvider(reply, lookup) {
  const provider = botModule.topupProvider;

  provider.isInitialized = true;
  provider.testMode = false;

  // Deterministic keys, so a test can prove one key was minted once.
  provider.newOrderId = () => `01910000-0000-4000-8000-${String(
    ++minted
  ).padStart(12, "0")}`;

  provider.canFulfill = (order) =>
    Boolean(order.subCategoryId) &&
    Boolean(String(order.playerId || "").trim());

  provider.sendTopup = async (order) => {
    const stored = botModule
      .getOrders()
      .find((o) => o.id === order.id);

    placed.push({
      orderId: order.providerOrderId,
      storedId: stored?.providerOrderId,
      subCategoryId: order.subCategoryId,
      playerId: order.playerId,
    });

    // A function computes the answer per order; an object is returned as is;
    // no argument means a straightforward delivery.
    if (typeof reply === "function") {
      return reply(order);
    }

    if (reply && typeof reply === "object") {
      return reply;
    }

    return {
      success: true,
      status: "success",
      statusDetail: "provider_completed",
      orderId: order.providerOrderId,
      transactionId: "TXN-1",
      providerStatus: "completed",
      raw: '{"order":{"status":"completed"}}',
    };
  };

  provider.checkTopupStatus = async (order) =>
    typeof lookup === "function"
      ? lookup(order)
      : lookup || {
          status: "unknown",
          statusDetail: "provider_unreachable",
        };
}

(async () => {
  // The order book is PostgreSQL now, so there is no file to back up; the
  // seeded rows carry TEST in their ids and are deleted by the cleanup below.
  // The mirror every synchronous screen reads has to be filled first, or a
  // read refuses with "the order mirror is not loaded yet".
  const ordersStore = require("./src/database/orders");
  await ordersStore.hydrate();

  try {
    console.log("\n== a successful top-up completes ==");

    await saveOrdersFile([baseOrder()]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await botModule.processAutoTopup("HG-TEST-0001");

    let order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "order is completed",
      order.topupStatus === "topup_completed",
      order.topupStatus
    );
    check(
      "customer-visible status matches",
      order.status === "topup_completed",
      order.status
    );
    check(
      "exactly one provider order was placed",
      placed.length === 1,
      JSON.stringify(placed)
    );
    check(
      "the key was stored before the provider was called",
      placed[0].storedId === placed[0].orderId &&
        Boolean(placed[0].storedId),
      JSON.stringify(placed[0])
    );
    check(
      "the stored key is the order's own",
      order.providerOrderId === placed[0].orderId,
      String(order.providerOrderId)
    );

    check(
      "the order's own product id was sent",
      placed[0].subCategoryId === 110,
      String(placed[0].subCategoryId)
    );
    check(
      "the player's id was sent",
      placed[0].playerId === "8595647532",
      placed[0].playerId
    );
    check(
      "the provider reference was recorded",
      order.providerTransactionId === "TXN-1",
      String(order.providerTransactionId)
    );
    check("one attempt was used", order.topupAttempts === 1);
    check("the raw answer was kept", !!order.providerRaw);
    check(
      "the provider status was kept",
      order.providerStatus === "completed",
      String(order.providerStatus)
    );
    check(
      "a delivered order is not in the review queue",
      order.providerFailed === false &&
        !botModule
          .reviewingOrders()
          .some((o) => o.id === "HG-TEST-0001"),
      String(order.providerFailed)
    );

    console.log("\n== approving twice places one order ==");

    await saveOrdersFile([
      baseOrder({ status: "approved", topupStatus: "ready_for_topup" }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await Promise.all([
      botModule.processAutoTopup("HG-TEST-0001"),
      botModule.processAutoTopup("HG-TEST-0001"),
      botModule.processAutoTopup("HG-TEST-0001"),
    ]);

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "three concurrent calls still place one order",
      placed.length === 1,
      String(placed.length)
    );
    check("only one key was minted", minted === 1, String(minted));
    check("only one attempt was recorded", order.topupAttempts === 1);
    check(
      "the order completed",
      order.topupStatus === "topup_completed",
      order.topupStatus
    );

    console.log("\n== a completed order is never re-ordered ==");

    placed.length = 0;

    await botModule.processAutoTopup("HG-TEST-0001");

    check(
      "nothing was placed again",
      placed.length === 0,
      String(placed.length)
    );

    console.log("\n== a retry reuses the stored key ==");

    // What an admin retry produces: parked order, existing provider id.
    await saveOrdersFile([
      baseOrder({
        status: "needs_review",
        topupStatus: "needs_review",
        topupAttempts: 1,
        providerOrderId: "0191aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        topupRetryArmed: true,
      }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "the retry was placed",
      placed.length === 1,
      JSON.stringify(placed)
    );
    check(
      "it reused the stored key, so nothing is charged twice",
      placed[0].orderId === "0191aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      JSON.stringify(placed[0])
    );
    check("no second key was minted", minted === 0, String(minted));

    console.log("\n== a parked order is never re-armed by itself ==");

    await saveOrdersFile([
      baseOrder({
        status: "needs_review",
        topupStatus: "needs_review",
        topupAttempts: 1,
        providerOrderId: "0191aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await botModule.processAutoTopup("HG-TEST-0001");

    check(
      "nothing was placed",
      placed.length === 0,
      String(placed.length)
    );

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "it stays parked for a human",
      order.topupStatus === "needs_review",
      order.topupStatus
    );

    console.log("\n== an unknown outcome is not resent ==");

    // The process died after the order was placed.
    await saveOrdersFile([
      baseOrder({
        status: "topup_processing",
        topupStatus: "topup_processing",
        topupAttempts: 1,
        providerOrderId: "0191ffff-ffff-4fff-8fff-ffffffffffff",
      }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider({}, { status: "processing", statusDetail: "provider_pending" });

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "no second order was placed",
      placed.length === 0,
      String(placed.length)
    );
    check(
      "attempts were left alone",
      order.topupAttempts === 1,
      String(order.topupAttempts)
    );
    check(
      "it is parked for a human",
      order.topupStatus === "needs_review",
      order.topupStatus
    );
    check(
      "a still-running order keeps its retry button",
      /review_retry_/.test(
        JSON.stringify(
          botModule.reviewOrderMenu(order, { canRetry: true })
        )
      ),
      JSON.stringify(
        botModule.reviewOrderMenu(order, { canRetry: true })
      ).slice(0, 200)
    );
    check(
      "it is not treated as a provider failure",
      !order.providerFailed,
      String(order.providerFailed)
    );

    console.log("\n== a still-running order settles when it finishes ==");

    await saveOrdersFile([
      baseOrder({
        status: "needs_review",
        topupStatus: "needs_review",
        topupAttempts: 1,
        providerOrderId: "0191bbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ]);
    placed.length = 0;
    stubProvider(
      { success: false, status: "processing", statusDetail: "provider_pending" },
      { status: "success", statusDetail: "provider_completed" }
    );

    await botModule.resolveTopupOrder("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "the completed lookup completes the order",
      order.topupStatus === "topup_completed",
      order.topupStatus
    );
    check(
      "no new order was placed while resolving",
      placed.length === 0,
      String(placed.length)
    );

    console.log("\n== a provider failure reported by a lookup is terminal ==");

    await saveOrdersFile([
      baseOrder({
        status: "needs_review",
        topupStatus: "needs_review",
        topupAttempts: 1,
        providerOrderId: "0191cccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    ]);
    stubProvider(
      undefined,
      { status: "failed", statusDetail: "provider_failed" }
    );

    await botModule.resolveTopupOrder("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "marked failed, not delivered",
      order.topupStatus === "topup_failed",
      order.topupStatus
    );

    console.log("\n== a pending answer is not a delivery ==");

    await saveOrdersFile([
      baseOrder({ status: "approved", topupStatus: "ready_for_topup" }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider({
      success: false,
      status: "processing",
      statusDetail: "provider_pending",
      orderId: "0191dddd-dddd-4ddd-8ddd-dddddddddddd",
      transactionId: null,
      providerStatus: "pending",
      raw: '{"order":{"status":"pending"}}',
    });

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "not marked delivered",
      order.topupStatus === "needs_review",
      order.topupStatus
    );
    check(
      "the wallet was charged, so it is read back later",
      order.providerOrderId === "0191dddd-dddd-4ddd-8ddd-dddddddddddd",
      String(order.providerOrderId)
    );

    console.log("\n== an unreachable provider is not a failure ==");

    await saveOrdersFile([
      baseOrder({ status: "approved", topupStatus: "ready_for_topup" }),
    ]);
    placed.length = 0;
    stubProvider({
      success: false,
      status: "unknown",
      statusDetail: "provider_unreachable",
      orderId: null,
      transactionId: null,
      raw: null,
    });

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "not marked delivered",
      order.topupStatus === "needs_review",
      order.topupStatus
    );
    check(
      "not marked failed either",
      order.topupStatus !== "topup_failed"
    );

    console.log("\n== a provider refusal is terminal ==");

    await saveOrdersFile([
      baseOrder({ status: "approved", topupStatus: "ready_for_topup" }),
    ]);
    stubProvider({
      success: false,
      status: "failed",
      statusDetail: "insufficient_balance",
      orderId: "0191eeee-eeee-4eee-8eee-eeeeeeeeeeee",
      transactionId: null,
      providerStatus: "failed",
      raw: '{"error":{"code":"INSUFFICIENT_BALANCE"}}',
    });

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "marked failed, not delivered",
      order.topupStatus === "topup_failed",
      order.topupStatus
    );
    check(
      "the reason is kept",
      order.topupError === "insufficient_balance",
      order.topupError
    );
    check(
      "it is marked as a provider failure",
      order.providerFailed === true,
      String(order.providerFailed)
    );
    check(
      "it lands in the review queue",
      botModule
        .reviewingOrders()
        .some((o) => o.id === "HG-TEST-0001"),
      JSON.stringify(
        botModule.reviewingOrders().map((o) => o.id)
      )
    );
    check(
      "the review screen offers no retry, since the provider would refuse it again",
      !/review_retry_/.test(
        JSON.stringify(botModule.reviewOrderMenu(order, { canRetry: true }))
      ),
      JSON.stringify(
        botModule.reviewOrderMenu(order, { canRetry: true })
      ).slice(0, 200)
    );

    console.log("\n== an unmapped package is never ordered ==");

    await saveOrdersFile([
      baseOrder({
        gameId: "blood_strike",
        gameName: "Blood Strike",
        productKey: "gold500",
        productName: "💎 500 Gold",
        subCategoryId: null,
        status: "approved",
        topupStatus: "ready_for_topup",
      }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "nothing was ordered",
      placed.length === 0,
      JSON.stringify(placed)
    );
    check(
      "no key was minted for it",
      minted === 0,
      String(minted)
    );
    check(
      "it is parked for a human",
      order.topupStatus === "needs_review",
      order.topupStatus
    );

    console.log("\n== exhausted attempts fail closed ==");

    await saveOrdersFile([
      baseOrder({
        status: "approved",
        topupStatus: "ready_for_topup",
        topupAttempts: 3,
      }),
    ]);
    placed.length = 0;
    stubProvider();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "nothing more was placed",
      placed.length === 0,
      String(placed.length)
    );
    check(
      "failed rather than silently retried",
      order.topupStatus === "topup_failed",
      order.topupStatus
    );

    console.log("\n== concurrent orders do not overwrite each other ==");

    const many = Array.from({ length: 12 }, (_, i) =>
      baseOrder({
        id: TEST_ORDER_MARKER + "-CONC-" + i,
        status: "approved",
        topupStatus: "ready_for_topup",
      })
    );

    await saveOrdersFile(many);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await Promise.all(
      many.map((o) => botModule.processAutoTopup(o.id))
    );

    const seededIds = new Set(many.map((o) => o.id));
    const stored = botModule
      .getOrders()
      .filter((o) => seededIds.has(o.id));

    check(
      "every order survived",
      stored.length === many.length,
      String(stored.length)
    );
    check(
      "every order reached a terminal state",
      stored.every(
        (o) =>
          o.topupStatus === "topup_completed" ||
          o.topupStatus === "topup_failed"
      ),
      stored
        .filter((o) => !o.topupStatus)
        .map((o) => o.id)
        .join(",")
    );
    check(
      "each got exactly one attempt",
      stored.every((o) => o.topupAttempts === 1),
      stored
        .filter((o) => o.topupAttempts !== 1)
        .map((o) => o.id + "=" + o.topupAttempts)
        .join(",")
    );
    check(
      "each placed exactly one order",
      placed.length === 12,
      String(placed.length)
    );
    check(
      "each order got its own key",
      new Set(placed.map((p) => p.orderId)).size === 12,
      String(new Set(placed.map((p) => p.orderId)).size)
    );
    check(
      "every key was stored before it was used",
      placed.every((p) => p.orderId && p.orderId === p.storedId)
    );

    /*
    | The store must refuse a write it cannot make rather than invent a
    | result. An order number that was never created is the case that used
    | to be covered by a corrupt file: the mutator runs, finds nothing, and
    | nothing is reported as saved.
    */
    console.log("\n== an absent order is never invented ==");

    const absent = await botModule.mutateOrder(
      TEST_ORDER_MARKER + "-ABSENT",
      (current) => {
        current.status = "approved";

        return current;
      }
    );

    check(
      "a write to an absent order returns nothing",
      absent === null,
      "mutateOrder returned an order"
    );

    check(
      "it did not join the order book",
      !botModule.getOrders().some(
        (o) => o.id === TEST_ORDER_MARKER + "-ABSENT"
      ),
      "the order appears in the book"
    );

    console.log("\n== startup recovery parks interrupted work ==");

    const recoveryIds = [
      "HG-TEST-INFLIGHT",
      "HG-TEST-READY",
      "HG-TEST-DONE",
    ];

    await saveOrdersFile([
      baseOrder({
        id: "HG-TEST-INFLIGHT",
        status: "topup_processing",
        topupStatus: "topup_processing",
        topupAttempts: 1,
        providerOrderId: "01911111-1111-4111-8111-111111111111",
      }),
      baseOrder({
        id: "HG-TEST-READY",
        status: "approved",
        topupStatus: "ready_for_topup",
      }),
      baseOrder({
        id: "HG-TEST-DONE",
        status: "topup_completed",
        topupStatus: "topup_completed",
        topupAttempts: 1,
        providerOrderId: "01912222-2222-4222-8222-222222222222",
      }),
    ]);
    placed.length = 0;
    minted = 0;
    stubProvider();

    await botModule.runStartupRecovery();

    const recovered = botModule
      .getOrders()
      .filter((o) => recoveryIds.includes(o.id));
    const byId = Object.fromEntries(
      recovered.map((o) => [o.id, o])
    );

    check(
      "nothing was re-ordered on boot",
      placed.length === 0,
      JSON.stringify(placed)
    );
    check(
      "the in-flight order was parked",
      byId["HG-TEST-INFLIGHT"].topupStatus === "needs_review",
      byId["HG-TEST-INFLIGHT"].topupStatus
    );
    check(
      "its key was kept so it can still be read",
      byId["HG-TEST-INFLIGHT"].providerOrderId ===
        "01911111-1111-4111-8111-111111111111"
    );
    check(
      "the ready order was parked",
      byId["HG-TEST-READY"].topupStatus === "needs_review",
      byId["HG-TEST-READY"].topupStatus
    );
    check(
      "the finished order was left alone",
      byId["HG-TEST-DONE"].topupStatus === "topup_completed",
      byId["HG-TEST-DONE"].topupStatus
    );
    check(
      "no orders were lost",
      recoveryIds.every((id) => byId[id]),
      String(Object.keys(byId).length)
    );

    console.log(
      "\n" +
        (fail === 0
          ? "ALL TOP-UP CHECKS PASSED"
          : fail + " CHECK(S) FAILED") +
        "  (" +
        pass +
        " passed, " +
        fail +
        " failed)"
    );

    process.exitCode = fail ? 1 : 0;
  } finally {
    // Remove everything this run seeded, so a crash mid-run cannot leave
    // test rows behind for the next one to trip over.
    const existing = await testOrderIds().catch(() => ({ rows: [] }));
    await pool
      .query(`DELETE FROM orders WHERE order_number = ANY($1::text[])`, [
        existing.rows.map((row) => row.order_number),
      ])
      .catch(() => {});

    // The orders go first, then the customer they referenced. Leaving the
    // user row behind is how a "tester" wallet with a balance nobody funded
    // ends up living in the shop.
    // One statement per call: node-postgres speaks the extended protocol,
    // which cannot take several statements in a single query. The user table
    // is keyed on telegram_id rather than user_id, and it comes last because
    // the ledger rows reference it.
    const userCleanup = [
      "DELETE FROM wallet_transactions WHERE user_id = $1",
      "DELETE FROM payments WHERE user_id = $1",
      "DELETE FROM users WHERE telegram_id = $1",
    ];

    for (const statement of userCleanup) {
      await pool.query(statement, [TEST_USER_ID]).catch(() => {});
    }

    restoreOrders();
    await pool.end();
  }
})().catch(async (err) => {
  restoreOrders();
  console.error("TEST CRASH:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});