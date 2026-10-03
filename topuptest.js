const fs = require("fs");
const path = require("path");

/*
|--------------------------------------------------------------------------
| TOP-UP TEST
|--------------------------------------------------------------------------
| Fulfilment moves real money, so these checks are all about the ways a
| customer could be harmed:
|
|   - a double-tapped Approve must not send two supplier commands,
|   - a request whose outcome is unknown must never be resent,
|   - an unmapped package must never be sent at all,
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

const ORDERS_FILE = path.join(__dirname, "orders.json");

let backup = null;

function saveOrdersFile(orders) {
  fs.writeFileSync(
    ORDERS_FILE,
    JSON.stringify(orders, null, 2)
  );
}

function restoreOrders() {
  if (backup === null) {
    fs.writeFileSync(ORDERS_FILE, "[]");
    return;
  }

  fs.writeFileSync(ORDERS_FILE, backup);
}

function sentMessages() {
  return [];
}

function baseOrder(overrides = {}) {
  return {
    id: "HG-TEST-0001",
    userId: 100,
    username: "tester",
    firstName: "Tester",
    playerId: "11927288867",
    playerName: "Pro",
    playerRegion: "Asia",
    gameId: "free_fire",
    gameName: "Free Fire",
    idLabel: "Player ID",
    productKey: "weekly",
    productName: "📅 Weekly",
    price: 590,
    status: "pending_approval",
    paymentProof: "FILEID",
    createdAt: new Date().toISOString(),
    paymentSubmittedAt: new Date().toISOString(),
    approvedAt: null,
    rejectedAt: null,
    topupStatus: null,
    topupAttempts: 0,
    supplierTransactionId: null,
    supplierMessageId: null,
    topupStartedAt: null,
    topupCompletedAt: null,
    topupError: null,
    supplierRawReply: null,
    ...overrides,
  };
}

// Stub the Telegram surface before index.js is required, so requiring it
// cannot reach the network and handlers can be driven directly.
const telegramPath = path.dirname(
  require.resolve("telegraf")
);
const telegramModule = require(path.join(telegramPath, "telegram.js"));
const Telegram =
  telegramModule.Telegram || telegramModule.default;

const sent = [];
const calls = [];

async function stub(...args) {
  calls.push(args);
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

Telegraf.prototype.launch = async function () {};
Telegraf.prototype.stop = async function () {};

const botModule = require("./index.js");
const app = botModule.bot;

console.log("\n== loading the bot ==");

check(
  "index.js exports what the tests need",
  typeof botModule.processAutoTopup === "function" &&
    typeof botModule.runStartupRecovery === "function" &&
    typeof botModule.supplierAdapter === "object"
);

// The supplier adapter is replaced so no command can leave the machine.
const commands = [];

function stubSupplier(reply) {
  botModule.supplierAdapter.isInitialized = true;
  botModule.supplierAdapter.testMode = false;
  botModule.supplierAdapter.sendTopup = async (order) => {
    commands.push(
      botModule.supplierAdapter.buildCommand(order).command
    );

    // A function computes the reply per order; an object is returned as
    // is; no argument means a straightforward success.
    if (typeof reply === "function") {
      return reply(order);
    }

    if (reply && typeof reply === "object") {
      return reply;
    }

    return {
      success: true,
      status: "success",
      statusDetail: "completed",
      transactionId: "TXN-1",
      messageId: 1,
      rawResponse: "✅ Top-up successful. Transaction ID: TXN-1",
    };
  };
}

(async () => {
  backup = fs.existsSync(ORDERS_FILE)
    ? fs.readFileSync(ORDERS_FILE, "utf8")
    : null;

  try {
    console.log("\n== a successful top-up completes ==");

    saveOrdersFile([baseOrder()]);
    commands.length = 0;
    stubSupplier();

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
      "exactly one supplier command was sent",
      commands.length === 1,
      JSON.stringify(commands)
    );
    check(
      "the confirmed command shape was used",
      commands[0] === "/id 11927288867 WEEKLY",
      commands[0]
    );
    check(
      "the transaction id was recorded",
      order.supplierTransactionId === "TXN-1",
      String(order.supplierTransactionId)
    );
    check("one attempt was used", order.topupAttempts === 1);
    check("the raw reply was kept", !!order.supplierRawReply);

    console.log("\n== approving twice sends one command ==");

    saveOrdersFile([baseOrder({ status: "approved", topupStatus: "ready_for_topup" })]);
    commands.length = 0;
    stubSupplier();

    await Promise.all([
      botModule.processAutoTopup("HG-TEST-0001"),
      botModule.processAutoTopup("HG-TEST-0001"),
      botModule.processAutoTopup("HG-TEST-0001"),
    ]);

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "three concurrent calls still send one command",
      commands.length === 1,
      String(commands.length)
    );
    check("only one attempt was recorded", order.topupAttempts === 1);
    check(
      "the order completed",
      order.topupStatus === "topup_completed",
      order.topupStatus
    );

    console.log("\n== a completed order is never re-sent ==");

    commands.length = 0;

    await botModule.processAutoTopup("HG-TEST-0001");

    check(
      "nothing was sent again",
      commands.length === 0,
      String(commands.length)
    );

    console.log("\n== an unknown outcome is not resent ==");

    // The order was interrupted after the request went out.
    saveOrdersFile([
      baseOrder({
        status: "topup_processing",
        topupStatus: "topup_processing",
        topupAttempts: 1,
        supplierMessageId: 555,
      }),
    ]);
    commands.length = 0;
    stubSupplier();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "no second command was sent",
      commands.length === 0,
      String(commands.length)
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

    console.log("\n== an unrecognised reply is not success ==");

    saveOrdersFile([baseOrder({ status: "approved", topupStatus: "ready_for_topup" })]);
    stubSupplier({
      success: false,
      status: "unknown",
      statusDetail: "unrecognised_reply",
      transactionId: null,
      messageId: 1,
      rawResponse: "hmm",
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

    console.log("\n== a timeout is not success ==");

    saveOrdersFile([baseOrder({ status: "approved", topupStatus: "ready_for_topup" })]);
    stubSupplier({
      success: false,
      status: "unknown",
      statusDetail: "no_reply_from_supplier",
      transactionId: null,
      messageId: null,
      rawResponse: null,
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

    console.log("\n== a supplier failure is terminal ==");

    saveOrdersFile([baseOrder({ status: "approved", topupStatus: "ready_for_topup" })]);
    stubSupplier({
      success: false,
      status: "failed",
      statusDetail: "insufficient_balance",
      transactionId: null,
      messageId: 1,
      rawResponse: "Insufficient balance",
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

    console.log("\n== an unmapped package is never sent ==");

    saveOrdersFile([
      baseOrder({
        gameId: "blood_strike",
        gameName: "Blood Strike",
        productKey: "gold500",
        productName: "💎 500 Gold",
        status: "approved",
        topupStatus: "ready_for_topup",
      }),
    ]);
    commands.length = 0;
    stubSupplier();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "nothing was sent to the supplier",
      commands.length === 0,
      JSON.stringify(commands)
    );
    check(
      "it is parked for a human",
      order.topupStatus === "needs_review",
      order.topupStatus
    );

    console.log("\n== exhausted attempts fail closed ==");

    saveOrdersFile([
      baseOrder({
        status: "approved",
        topupStatus: "ready_for_topup",
        topupAttempts: 3,
      }),
    ]);
    commands.length = 0;
    stubSupplier();

    await botModule.processAutoTopup("HG-TEST-0001");

    order = botModule
      .getOrders()
      .find((o) => o.id === "HG-TEST-0001");

    check(
      "nothing more was sent",
      commands.length === 0,
      String(commands.length)
    );
    check(
      "failed rather than silently retried",
      order.topupStatus === "topup_failed",
      order.topupStatus
    );

    console.log("\n== concurrent orders do not overwrite each other ==");

    const many = Array.from({ length: 12 }, (_, i) =>
      baseOrder({
        id: "HG-CONC-" + i,
        status: "approved",
        topupStatus: "ready_for_topup",
      })
    );

    saveOrdersFile(many);
    commands.length = 0;
    stubSupplier();

    await Promise.all(
      many.map((o) => botModule.processAutoTopup(o.id))
    );

    const stored = botModule.getOrders();

    check(
      "every order survived",
      stored.length === 12,
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
      "each sent exactly one command",
      commands.length === 12,
      String(commands.length)
    );

    console.log("\n== a corrupt store blocks writes ==");

    fs.writeFileSync(ORDERS_FILE, "{ not json at all");

    const corruptRead = botModule.readOrders();

    check(
      "the read reports failure",
      corruptRead.ok === false,
      String(corruptRead.ok)
    );
    check(
      "it does not pretend there are no orders",
      Array.isArray(corruptRead.orders) &&
        corruptRead.orders.length === 0 &&
        corruptRead.ok === false
    );

    const written = await botModule.mutateOrder(
      "HG-ANY",
      (current) => current
    );

    check(
      "a write is refused",
      written === null,
      "mutateOrder returned an order"
    );

    check(
      "the corrupt file was left untouched",
      fs.readFileSync(ORDERS_FILE, "utf8") === "{ not json at all",
      "the file was overwritten"
    );

    console.log("\n== startup recovery parks interrupted work ==");

    saveOrdersFile([
      baseOrder({
        id: "HG-INFLIGHT",
        status: "topup_processing",
        topupStatus: "topup_processing",
        topupAttempts: 1,
        supplierMessageId: 777,
      }),
      baseOrder({
        id: "HG-READY",
        status: "approved",
        topupStatus: "ready_for_topup",
      }),
      baseOrder({
        id: "HG-DONE",
        status: "topup_completed",
        topupStatus: "topup_completed",
        topupAttempts: 1,
      }),
    ]);
    commands.length = 0;
    stubSupplier();

    await botModule.runStartupRecovery();

    const recovered = botModule.getOrders();
    const byId = Object.fromEntries(
      recovered.map((o) => [o.id, o])
    );

    check(
      "nothing was resent on boot",
      commands.length === 0,
      JSON.stringify(commands)
    );
    check(
      "the in-flight order was parked",
      byId["HG-INFLIGHT"].topupStatus === "needs_review",
      byId["HG-INFLIGHT"].topupStatus
    );
    check(
      "the ready order was parked",
      byId["HG-READY"].topupStatus === "needs_review",
      byId["HG-READY"].topupStatus
    );
    check(
      "the finished order was left alone",
      byId["HG-DONE"].topupStatus === "topup_completed",
      byId["HG-DONE"].topupStatus
    );
    check(
      "no orders were lost",
      recovered.length === 3,
      String(recovered.length)
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
    restoreOrders();
  }
})().catch((err) => {
  restoreOrders();
  console.error("TEST CRASH:", err);
  process.exit(1);
});