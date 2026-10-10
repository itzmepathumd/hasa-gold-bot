/*
|--------------------------------------------------------------------------
| WALLET FLOW TEST
|--------------------------------------------------------------------------
| Drives the real bot handlers the way Telegram would, to verify
| the wallet wiring: the recharge flow, the admin approval, the
| wallet checkout and the reject flow.
|
| The harness is the one flowtest.js uses, extended with the
| photo handler and stubbed Telegram sends, so nothing here
| reaches the network.
|
| Runs inside its own scratch directory, so the JSON stores
| it touches are throwaway.
*/

const telegraf = require("telegraf");
const path = require("path");
const fs = require("fs");
const os = require("os");

require("dotenv").config();

/*
| The bot refuses to start without a token, so the tests supply a fake one.
| Every Telegram call in these tests is stubbed, so nothing reaches the
| network with it.
*/
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456:FAKE_TOKEN_FOR_TESTS";
process.env.ADMIN_ID = process.env.ADMIN_ID || "1";

telegraf.Telegraf.prototype.launch = function () {};

/*
| This test drives the real order database, so it needs one. A local
| PostgreSQL with the schema loaded is enough; a Supabase project works too.
| Without a database the test cannot run, and it says so rather than passing
| on an empty store.
*/
const connection = require("./src/database/connection");

if (!connection.shouldUseDatabase()) {
  console.log(
    "\n== WALLET FLOW TEST SKIPPED ==\n" +
      "   Needs SUPABASE_DB_URL. Run the schema first (npm run db:schema),\n" +
      "   then set the connection string in .env and re-run.\n"
  );
  process.exit(0);
}


const REPO = __dirname;

const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "walletflow-")
);

process.chdir(scratch);

const ADMIN_ID = Number(process.env.ADMIN_ID || 1);
const CUSTOMER_ID = 4242;

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}` + (detail ? `  -> ${detail}` : ""));
  }
}

/*
| Capture every handler index.js registers.
*/
const registered = { action: [], text: [], photo: [] };

const realAction = telegraf.Telegraf.prototype.action;
const realOn = telegraf.Telegraf.prototype.on;
const realHears = telegraf.Telegraf.prototype.hears;

telegraf.Telegraf.prototype.action = function (match, ...rest) {
  registered.action.push({ match, fn: rest[0] });
  return this;
};

telegraf.Telegraf.prototype.on = function (event, ...rest) {
  if (event === "text") registered.text.push(rest[0]);
  if (event === "photo") registered.photo.push(rest[0]);
  return this;
};

telegraf.Telegraf.prototype.hears = function () {
  return this;
};

require(path.join(REPO, "index.js"));

telegraf.Telegraf.prototype.action = realAction;
telegraf.Telegraf.prototype.on = realOn;
telegraf.Telegraf.prototype.hears = realHears;

const { bot } = require(path.join(REPO, "index.js"));
const wallet = require(path.join(REPO, "src", "wallet"));
const walletStore = require(
  path.join(REPO, "src", "database", "wallets")
);
const orders = require(
  path.join(REPO, "src", "database", "orders")
);

/*
| Every Telegram send is captured instead of sent.
*/
const notifications = [];

bot.telegram.sendMessage = async (chatId, text, extra) => {
  notifications.push({ method: "sendMessage", chatId, text, extra });
  return true;
};

bot.telegram.sendPhoto = async (chatId, fileId, extra) => {
  notifications.push({ method: "sendPhoto", chatId, fileId, extra });
  return true;
};

bot.telegram.sendChatAction = async () => true;
bot.telegram.editMessageText = async () => true;
bot.telegram.setMyCommands = async () => true;
bot.telegram.deleteMyCommands = async () => true;

/*
| A context stub that carries everything the wallet
| handlers read.
*/
function makeCtx({
  userId = CUSTOMER_ID,
  text,
  callbackData,
  isCallback = false,
  photo,
} = {}) {
  const sent = [];
  const edited = [];

  const ctx = {
    from: {
      id: userId,
      username: userId === ADMIN_ID ? "admin" : "customer",
      first_name: userId === ADMIN_ID ? "Admin" : "Customer",
    },
    chat: { id: userId },
    message: isCallback
      ? undefined
      : photo
        ? { photo }
        : { text },
    callbackQuery: isCallback
      ? { data: callbackData, message: { text: "seed" } }
      : undefined,
    match: isCallback ? [callbackData] : undefined,
    session: undefined,
    sent,
    edited,
    telegram: bot.telegram,
    async reply(text, extra) {
      sent.push({ text, extra });
      return sent[sent.length - 1];
    },
    async editMessageText(text, extra) {
      edited.push({ text, extra });
      return edited[edited.length - 1];
    },
    async answerCbQuery(arg) {
      return true;
    },
  };

  let ref = {};

  Object.defineProperty(ctx, "session", {
    get() {
      return ref;
    },
    set(v) {
      ref = v;
    },
  });

  return ctx;
}

async function tap(ctx, data) {
  const entry = registered.action.find((a) =>
    typeof a.match === "string"
      ? a.match === data
      : a.match.test(data)
  );

  if (!entry) {
    throw new Error("no handler for " + data);
  }

  if (entry.match instanceof RegExp) {
    ctx.match = data.match(entry.match);
  } else {
    if (!ctx.callbackQuery) {
      ctx.callbackQuery = { data, message: { text: "seed" } };
    } else {
      ctx.callbackQuery.data = data;
    }
    ctx.match = [data];
  }

  return entry.fn(ctx);
}

/*
| The text handlers, in registration order: the admin
| one, the player-id one, then the customer one. Each
| passes on what it does not own, exactly as Telegraf
| middleware does.
*/
function dispatchText(ctx) {
  let index = 0;

  const next = async () => {
    const handler = registered.text[index++];

    if (handler) {
      await handler(ctx, next);
    }
  };

  return next();
}

/*
| The reject reason is read by the second text handler (the one registered
| for rejectFlow), not the first (adminFlow). Run them in registration order
| with a real next(), so whichever handler owns the flow answers, exactly as
| Telegraf would dispatch it.
*/
async function dispatchTextHandlers(ctx) {
  for (const handler of registered.text) {
    let delegated = false;

    await handler(ctx, async () => {
      delegated = true;
    });

    // A handler that delegates had nothing to do with this message; one that
    // did not delegate answered it, so stop there.
    if (!delegated) {
      return;
    }
  }
}

const adminTextHandler = registered.text[0];
const photoHandler = registered.photo[0];

function findNotification(method, chatId, needle) {
  return notifications.find(
    (n) =>
      n.method === method &&
      n.chatId === chatId &&
      String(n.text).includes(needle)
  );
}

/*
| This test drives the real database, so it has to leave it as it found it.
| A customer number that appears nowhere else and order numbers carrying
| FLOWTEST are the whole footprint, and both are removed on the way out, so a
| crash cannot leave rows for the next run to trip over. The cleanup runs
| first too, so a run that crashed the last time still starts clean.
*/
async function cleanUp() {
  if (!connection.shouldUseDatabase()) {
    return;
  }

  const db = await connection.getDb().catch(() => null);

  if (!db) {
    return;
  }

  // One statement per call: node-postgres speaks the extended protocol,
  // which cannot take several statements in one query, and a silently
  // rejected multi-statement string would leave the rows behind.
  const statements = [
    "DELETE FROM wallet_transactions WHERE user_id = $1",
    "DELETE FROM payments WHERE user_id = $1",
    "DELETE FROM recharge_requests WHERE user_id = $1",
    "DELETE FROM orders WHERE user_id = $1 OR order_number LIKE 'HG-FLOWTEST-%'",
    // Last, because everything above references it. Without it the ledger is
    // emptied but the cached balance row survives, and the next run starts
    // with money the customer never had.
    "DELETE FROM users WHERE telegram_id = $1",
  ];

  for (const statement of statements) {
    await db.query(statement, [CUSTOMER_ID]).catch((error) => {
      console.error("[WALLET FLOW TEST] cleanup failed:", error.message);
    });
  }
}

(async () => {
  console.log("WALLET FLOW TEST");
  console.log("================");

  await cleanUp();

  await walletStore.hydrate();

  /*
  | The order mirror the wallet-payment screens read. The bot fills both
  | mirrors at startup, so the test fills both too; without it every read
  | refuses with "the order mirror is not loaded yet" and the payment
  | screens cannot be checked.
  */
  await orders.hydrate();

  /*
  |--------------------------------------------------------------------------
  | RECHARGE FLOW
  |--------------------------------------------------------------------------
  */

  console.log("\n== recharge flow ==");

  // The customer opens a recharge.
  let ctx = makeCtx({ text: "/recharge" });
  ctx.session = {};
  await dispatchText(ctx);

  check(
    "recharge starts the amount step",
    ctx.session?.walletFlow?.step === "amount",
    JSON.stringify(ctx.session)
  );
  check(
    "amount prompt sent",
    ctx.sent.length === 1 &&
      String(ctx.sent[0].text).includes("RECHARGE"),
    ctx.sent[0]?.text
  );

  // The customer types an amount.
  ctx = makeCtx({ text: "1000" });
  ctx.session = {
    walletFlow: { step: "amount" },
  };
  await dispatchText(ctx);

  check(
    "valid amount moves to method choice",
    ctx.session?.walletFlow?.step === "method" &&
      ctx.session?.walletFlow?.amount === 1000,
    JSON.stringify(ctx.session)
  );
  check(
    "confirm screen sent",
    ctx.sent.length === 1 &&
      String(ctx.sent[0].text).includes("CONFIRM RECHARGE"),
    ctx.sent[0]?.text
  );

  // A nonsense amount is refused and the flow is kept.
  ctx = makeCtx({ text: "abc" });
  ctx.session = {
    walletFlow: { step: "amount" },
  };
  await dispatchText(ctx);

  check(
    "non-numeric amount refused",
    ctx.session?.walletFlow?.step === "amount" &&
      String(ctx.sent[0].text).includes("Invalid amount"),
    ctx.sent[0]?.text
  );

  // The customer picks a payment method.
  ctx = makeCtx({ callbackData: "recharge_ez_cash", isCallback: true });
  ctx.session = {
    walletFlow: { step: "method", amount: 1000 },
  };
  await tap(ctx, "recharge_ez_cash");

  check(
    "proof step opened",
    ctx.session?.walletFlow?.step === "proof" &&
      ctx.session?.walletFlow?.method === "ez_cash",
    JSON.stringify(ctx.session)
  );
  check(
    "proof prompt sent",
    ctx.edited.length === 1 &&
      String(ctx.edited[0].text).includes("RECHARGE VIA"),
    ctx.edited[0]?.text
  );

  // The customer sends the screenshot.
  const before = await wallet.getPendingRecharges();

  ctx = makeCtx({
    photo: [
      { file_id: "small", file_path: "small.jpg" },
      { file_id: "proof_large", file_path: "proof_large.jpg" },
    ],
  });
  ctx.session = {
    walletFlow: { step: "proof", method: "ez_cash", amount: 1000 },
  };
  await photoHandler(ctx);

  const pending = await wallet.getPendingRecharges();

  check(
    "request recorded",
    pending.length === before.length + 1,
    `${pending.length} pending`
  );

  const request = pending[0];

  check(
    "request carries the amount and proof",
    request.amount === 1000 &&
      request.paymentProof.endsWith("/proof_large.jpg") &&
      request.status === "pending",
    JSON.stringify(request)
  );
  check(
    "flow cleared after the screenshot",
    ctx.session?.walletFlow === null,
    JSON.stringify(ctx.session)
  );
  check(
    "admin notified with the proof",
    notifications.some(
      (n) =>
        n.method === "sendPhoto" &&
        n.chatId === ADMIN_ID &&
        n.fileId === "proof_large" &&
        String(n.extra?.caption).includes("RECHARGE REQUEST")
    ),
    "no sendPhoto to the admin"
  );
  check(
    "customer told the request is waiting",
    ctx.sent.some((s) =>
      String(s.text).includes("RECHARGE REQUESTED")
    ),
    "no confirmation sent"
  );

  /*
  |--------------------------------------------------------------------------
  | ADMIN APPROVAL
  |--------------------------------------------------------------------------
  */

  console.log("\n== admin approval ==");

  check(
    "request is listed for the admin",
    (await wallet.getPendingRecharges()).some(
      (r) => r.id === request.id
    )
  );

  const adminCtx = makeCtx({
    userId: ADMIN_ID,
    callbackData: `wallet_approve_${request.id}`,
    isCallback: true,
  });
  adminCtx.session = {};
  await tap(adminCtx, `wallet_approve_${request.id}`);

  check(
    "wallet credited",
    wallet.getBalance(CUSTOMER_ID) === 1000,
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );
  check(
    "request no longer pending",
    !(await wallet.getPendingRecharges()).some(
      (r) => r.id === request.id
    )
  );
  check(
    "customer notified of the credit",
    Boolean(
      findNotification(
        "sendMessage",
        CUSTOMER_ID,
        "RECHARGE APPROVED"
      )
    ),
    "no notification to the customer"
  );
  check(
    "admin screen shows the new balance",
    adminCtx.edited.length === 1 &&
      String(adminCtx.edited[0].text).includes("RECHARGE APPROVED"),
    adminCtx.edited[0]?.text
  );

  // A second tap cannot credit twice.
  const repeatCtx = makeCtx({
    userId: ADMIN_ID,
    callbackData: `wallet_approve_${request.id}`,
    isCallback: true,
  });
  repeatCtx.session = {};
  await tap(repeatCtx, `wallet_approve_${request.id}`);

  check(
    "a second approval credits nothing",
    wallet.getBalance(CUSTOMER_ID) === 1000,
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );

  /*
  |--------------------------------------------------------------------------
  | WALLET CHECKOUT
  |--------------------------------------------------------------------------
  */

  console.log("\n== wallet checkout ==");

  const order = {
    id: "HG-FLOWTEST-1",
    userId: CUSTOMER_ID,
    username: "customer",
    firstName: "Customer",
    playerId: "8595647532",
    gameId: "free_fire",
    gameName: "Free Fire",
    idLabel: "Player ID",
    productId: "free_fire~weekly",
    productKey: "weekly",
    productName: "Weekly",
    price: 590,
    status: "pending_payment",
    paymentProof: null,
    createdAt: new Date().toISOString(),
    paymentSubmittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectReason: null,
    subCategoryId: 110,
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
  };

  check("order seeded", Boolean(await orders.appendOrder(order)));

  ctx = makeCtx({ callbackData: "pay_with_wallet", isCallback: true });
  ctx.session = {
    orderId: order.id,
    waitingForPayment: true,
  };
  await tap(ctx, "pay_with_wallet");

  const paidOrder = await orders.getOrder(order.id);

  check(
    "wallet debited",
    wallet.getBalance(CUSTOMER_ID) === 410,
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );
  check(
    "order marked paid by wallet",
    paidOrder.status === "approved" &&
      paidOrder.paymentMethod === "wallet" &&
      Boolean(paidOrder.walletTransactionId),
    `${paidOrder.status} / ${paidOrder.paymentMethod} / ${paidOrder.walletTransactionId}`
  );
  check(
    "customer sees the payment",
    ctx.edited.some((e) =>
      String(e.text).includes("PAYMENT CONFIRMED")
    ),
    "no payment confirmation"
  );
  check(
    "session closed after payment",
    ctx.session?.waitingForPayment === false,
    JSON.stringify(ctx.session)
  );

  // The same order cannot be paid twice.
  const replayCtx = makeCtx({
    callbackData: "pay_with_wallet",
    isCallback: true,
  });
  replayCtx.session = {
    orderId: order.id,
    waitingForPayment: true,
  };
  await tap(replayCtx, "pay_with_wallet");

  check(
    "an already-paid order is not charged again",
    wallet.getBalance(CUSTOMER_ID) === 410 &&
      replayCtx.sent.some((s) =>
        String(s.text).includes("not pending payment")
      ),
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );

  /*
  |--------------------------------------------------------------------------
  | INSUFFICIENT BALANCE
  |--------------------------------------------------------------------------
  */

  console.log("\n== insufficient balance ==");

  const expensive = {
    ...order,
    id: "HG-FLOWTEST-2",
    price: 100000,
    status: "pending_payment",
  };

  await orders.appendOrder(expensive);

  ctx = makeCtx({ callbackData: "pay_with_wallet", isCallback: true });
  ctx.session = {
    orderId: expensive.id,
    waitingForPayment: true,
  };
  await tap(ctx, "pay_with_wallet");

  check(
    "an unaffordable order is refused",
    ctx.sent.some((s) =>
      String(s.text).includes("Payment failed")
    ),
    "no failure message"
  );
  check(
    "balance unchanged",
    wallet.getBalance(CUSTOMER_ID) === 410,
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );
  check(
    "order still payable",
    (await orders.getOrder(expensive.id)).status ===
      "pending_payment"
  );

  /*
  |--------------------------------------------------------------------------
  | REJECT FLOW
  |--------------------------------------------------------------------------
  */

  console.log("\n== reject flow ==");

  // A second recharge request, this time to be rejected.
  ctx = makeCtx({
    photo: [{ file_id: "small" }, { file_id: "proof_two" }],
  });
  ctx.session = {
    walletFlow: { step: "proof", method: "ez_cash", amount: 250 },
  };
  await photoHandler(ctx);

  const second = (await wallet.getPendingRecharges()).find(
    (r) => r.amount === 250
  );

  check("second request recorded", Boolean(second));

  // The admin opens the reject screen.
  const rejectCtx = makeCtx({
    userId: ADMIN_ID,
    callbackData: `wallet_reject_${second.id}`,
    isCallback: true,
  });
  rejectCtx.session = {};
  await tap(rejectCtx, `wallet_reject_${second.id}`);

  check(
    "reject screen opened",
    rejectCtx.edited.length === 1 &&
      String(rejectCtx.edited[0].text).includes("REJECT RECHARGE"),
    rejectCtx.edited[0]?.text
  );

  // The admin types the reason into the flow.
  const reasonCtx = makeCtx({
    userId: ADMIN_ID,
    text: "screenshot does not match the amount",
  });
  reasonCtx.session = {
    rejectFlow: {
      requestId: second.id,
    },
  };
  await dispatchTextHandlers(reasonCtx);

  const rejected = await wallet.getRecharge(second.id);

  check(
    "request rejected with the reason",
    rejected.status === "rejected" &&
      rejected.rejectReason ===
        "screenshot does not match the amount",
    JSON.stringify(rejected)
  );
  check(
    "no money moved",
    wallet.getBalance(CUSTOMER_ID) === 410,
    `balance ${wallet.getBalance(CUSTOMER_ID)}`
  );
  check(
    "customer told about the rejection",
    Boolean(
      findNotification(
        "sendMessage",
        CUSTOMER_ID,
        "RECHARGE REJECTED"
      )
    ),
    "no notification to the customer"
  );

  /*
  |--------------------------------------------------------------------------
  | SCREENS
  |--------------------------------------------------------------------------
  */

  console.log("\n== screens ==");

  ctx = makeCtx({ callbackData: "wallet", isCallback: true });
  ctx.session = {};
  await tap(ctx, "wallet");

  check(
    "wallet screen shows the balance",
    ctx.edited.length === 1 &&
      String(ctx.edited[0].text).includes("WALLET") &&
      String(ctx.edited[0].text).includes("410"),
    ctx.edited[0]?.text
  );

  const adminWalletsCtx = makeCtx({
    userId: ADMIN_ID,
    callbackData: "admin_wallets",
    isCallback: true,
  });
  adminWalletsCtx.session = {};
  await tap(adminWalletsCtx, "admin_wallets");

  check(
    "admin recharge list renders",
    adminWalletsCtx.edited.length === 1 &&
      String(adminWalletsCtx.edited[0].text).includes(
        "PENDING RECHARGES"
      ),
    adminWalletsCtx.edited[0]?.text
  );

  console.log(`\n${pass} passed, ${fail} failed`);

  process.exitCode = fail === 0 ? 0 : 1;
})().catch(async (error) => {
  console.error("TEST CRASH:", error);
  process.exitCode = 1;
}).finally(cleanUp);
