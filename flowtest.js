const telegraf = require("telegraf");

/*
|--------------------------------------------------------------------------
| FLOW TEST
|--------------------------------------------------------------------------
| Simulates the admin text flows against the real bot handlers to verify
| that ctx.session is always usable and each step advances correctly.
*/

require("dotenv").config();

/*
| The bot refuses to start without a token, so the tests supply a fake one.
| Every Telegram call in these tests is stubbed, so nothing reaches the
| network with it.
*/
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456:FAKE_TOKEN_FOR_TESTS";
process.env.ADMIN_ID = process.env.ADMIN_ID || "1";

telegraf.Telegraf.prototype.launch = function () {};

const ADMIN_ID = Number(process.env.ADMIN_ID || 1);

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}

/*
|--------------------------------------------------------------------------
| MINIMAL CONTEXT STUB
|--------------------------------------------------------------------------
*/
function makeCtx({ text, callbackData, isCallback = false }) {
  const sent = [];
  const edited = [];
  const answered = [];

  const ctx = {
    from: { id: ADMIN_ID, username: "admin", first_name: "Admin" },
    chat: { id: ADMIN_ID },
    message: isCallback ? undefined : { text },
    callbackQuery: isCallback
      ? { data: callbackData, message: { text: "seed" } }
      : undefined,
    match: isCallback ? [callbackData] : undefined,
    session: undefined,
    sent,
    edited,
    answered,
    async reply(text, extra) {
      sent.push({ text, extra });
      return sent[sent.length - 1];
    },
    async editMessageText(text, extra) {
      edited.push({ text, extra });
      return edited[edited.length - 1];
    },
    async answerCbQuery(arg) {
      answered.push(arg);
      return true;
    },
  };

  return ctx;
}

/*
|--------------------------------------------------------------------------
| RUN
|--------------------------------------------------------------------------
*/
const catalog = require("./catalog");

// capture handlers registered by index.js
const registered = { action: [], text: [] };
const realAction = telegraf.Telegraf.prototype.action;
const realOn = telegraf.Telegraf.prototype.on;
const realHears = telegraf.Telegraf.prototype.hears;

telegraf.Telegraf.prototype.action = function (match, ...rest) {
  registered.action.push({ match, fn: rest[0] });
  return this;
};
telegraf.Telegraf.prototype.on = function (event, ...rest) {
  if (event === "text") registered.text.push(rest[0]);
  return this;
};
// bot.hears() internally registers bot.on("text", filter, handler) which
// would pollute our capture. Neutralise it; the hears routes are covered
// by route.js / deadscan.js instead.
telegraf.Telegraf.prototype.hears = function () {
  return this;
};

require("./index.js");

telegraf.Telegraf.prototype.action = realAction;
telegraf.Telegraf.prototype.on = realOn;
telegraf.Telegraf.prototype.hears = realHears;

// Mirrors Telegram dispatch: first matching handler wins.
function findAction(data) {
  const entry = registered.action.find((a) =>
    typeof a.match === "string" ? a.match === data : a.match.test(data)
  );
  return entry ? entry.fn : null;
}

// Real telegraf sets ctx.match to the regex capture array (full match first,
// then capture groups). Reproduce that so handlers reading ctx.match work.
async function tap(ctx, data) {
  const entry = registered.action.find((a) =>
    typeof a.match === "string" ? a.match === data : a.match.test(data)
  );
  if (!entry) throw new Error("no handler for " + data);

  if (entry.match instanceof RegExp) {
    const m = data.match(entry.match);
    ctx.match = m;
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

// The session property is defined by the middleware as a getter/setter
// backed by the store. Emulate that here.
function attachSession(ctx) {
  let ref = {};
  Object.defineProperty(ctx, "session", {
    get() {
      return ref;
    },
    set(v) {
      ref = v;
    },
  });
}

console.log("\n== add game flow ==");

(async () => {
  const addGame = findAction("sag_new");
  check("sag_new handler exists", typeof addGame === "function");

  let ctx = makeCtx({ callbackData: "sag_new", isCallback: true });
  attachSession(ctx);
  await addGame(ctx);
  check(
    "flow starts at game_name",
    ctx.session.adminFlow?.step === "game_name",
    JSON.stringify(ctx.session.adminFlow)
  );
  check("prompt sent", ctx.sent.length === 1);
  check(
    "has cancel button",
    JSON.stringify(ctx.sent[0]?.extra || {}).includes("flow_cancel")
  );

  // send game name
  const textHandler = registered.text[0];
  check("admin text handler registered", typeof textHandler === "function");

  ctx = makeCtx({ text: "PUBG Mobile" });
  attachSession(ctx);
  ctx.session = { adminFlow: { step: "game_name" } };
  await textHandler(ctx, async () => {});
  check("asks for emoji", ctx.session.adminFlow?.step === "game_emoji",
    JSON.stringify(ctx.session.adminFlow));

  // send emoji -> should create game
  ctx = makeCtx({ text: "🪂" });
  attachSession(ctx);
  ctx.session = { adminFlow: { step: "game_emoji", gameName: "PUBG Mobile" } };
  await textHandler(ctx, async () => {});
  check("game created and asks for package name",
    ctx.session.adminFlow?.step === "package_name",
    JSON.stringify(ctx.session.adminFlow));

  const created = catalog.getGame(ctx.session.adminFlow.gameId);
  check("game exists in catalog", created?.name === "PUBG Mobile",
    created ? created.id : "missing");

  console.log("\n== add package flow ==");

  // send package name
  ctx = makeCtx({ text: "💎 600 UC" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: { step: "package_name", gameId: created.id },
  };
  await textHandler(ctx, async () => {});
  check("asks for price", ctx.session.adminFlow?.step === "package_price",
    JSON.stringify(ctx.session.adminFlow));

  // invalid price rejected
  ctx = makeCtx({ text: "abc" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: {
      step: "package_price",
      gameId: created.id,
      packageName: "💎 600 UC",
    },
  };
  await textHandler(ctx, async () => {});
  check("invalid price rejected (flow retained)",
    ctx.session.adminFlow?.step === "package_price",
    JSON.stringify(ctx.session.adminFlow));

  // valid price -> asks for sub_category_id
  ctx = makeCtx({ text: "1900" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: {
      step: "package_price",
      gameId: created.id,
      packageName: "💎 600 UC",
    },
  };
  await textHandler(ctx, async () => {});
  check("asks for sub_category_id", ctx.session.adminFlow?.step === "package_sub_category",
    JSON.stringify(ctx.session.adminFlow));

  // skip sub_category_id
  ctx = makeCtx({ text: "skip" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: {
      step: "package_sub_category",
      gameId: created.id,
      packageName: "💎 600 UC",
      packagePrice: 1900,
    },
  };
  await textHandler(ctx, async () => {});
  check("asks for requirements", ctx.session.adminFlow?.step === "package_requirements",
    JSON.stringify(ctx.session.adminFlow));

  // skip requirements
  ctx = makeCtx({ text: "skip" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: {
      step: "package_requirements",
      gameId: created.id,
      packageName: "💎 600 UC",
      packagePrice: 1900,
      subCategoryId: null,
    },
  };
  await textHandler(ctx, async () => {});
  check("flow cleared after save", !ctx.session.adminFlow,
    JSON.stringify(ctx.session.adminFlow));

  const pkg = catalog.getPackages(created.id);
  check("package created with price", pkg.length === 1 && pkg[0].price === 1900,
    JSON.stringify(pkg));
  check("success message sent", ctx.sent.length === 1);
  check("offers add-another button",
    JSON.stringify(ctx.sent[0]?.extra || {}).includes("sagp_"));

  console.log("\n== update price flow ==");

  const priceBtn = "sape_price_" + created.id + "~" + pkg[0].id;
  ctx = makeCtx({ callbackData: priceBtn, isCallback: true });
  attachSession(ctx);
  await tap(ctx, priceBtn);
  check(
    "price flow starts",
    ctx.session.adminFlow?.step === "package_price_update",
    JSON.stringify(ctx.session.adminFlow)
  );

  ctx = makeCtx({ text: "2100" });
  attachSession(ctx);
  ctx.session = {
    adminFlow: {
      step: "package_price_update",
      gameId: created.id,
      packageId: pkg[0].id,
    },
  };
  await textHandler(ctx, async () => {});
  const updated = catalog.findPackage(created.id, pkg[0].id);
  check("price updated to 2100", updated?.pkg.price === 2100,
    JSON.stringify(updated?.pkg));

  console.log("\n== toggle pause flow ==");

  const togglePkg = "sapt_" + created.id + "~" + pkg[0].id;
  ctx = makeCtx({ callbackData: togglePkg, isCallback: true });
  attachSession(ctx);
  await tap(ctx, togglePkg);
  check("package paused",
    catalog.findPackage(created.id, pkg[0].id)?.pkg.paused === true);
  check("package not orderable while paused",
    catalog.isOrderable(created.id, pkg[0].id) === false);

  ctx = makeCtx({ callbackData: togglePkg, isCallback: true });
  attachSession(ctx);
  await tap(ctx, togglePkg);
  check("package resumed",
    catalog.findPackage(created.id, pkg[0].id)?.pkg.paused === false);

  console.log("\n== payment flow ==");

  ctx = makeCtx({ callbackData: "sapay_new", isCallback: true });
  attachSession(ctx);
  await tap(ctx, "sapay_new");
  check("payment flow starts",
    ctx.session.adminFlow?.step === "payment_title",
    JSON.stringify(ctx.session.adminFlow));

  ctx = makeCtx({ text: "eZ Reload" });
  attachSession(ctx);
  ctx.session = { adminFlow: { step: "payment_title" } };
  await textHandler(ctx, async () => {});
  check("payment flow collects lines",
    ctx.session.adminFlow?.step === "payment_lines",
    JSON.stringify(ctx.session.adminFlow));

  for (const line of ["📱 Number: 077 111 1111", "👤 Name: Test"]) {
    const c = makeCtx({ text: line });
    attachSession(c);
    c.session = {
      adminFlow: {
        step: "payment_lines",
        paymentTitle: "eZ Reload",
        buffer: ctx.session.adminFlow.buffer,
      },
    };
    await textHandler(c, async () => {});
    ctx.session = c.session;
  }
  check("lines buffered", ctx.session.adminFlow.buffer.length === 2,
    JSON.stringify(ctx.session.adminFlow.buffer));

  const doneCtx = makeCtx({ text: "DONE" });
  attachSession(doneCtx);
  doneCtx.session = { adminFlow: ctx.session.adminFlow };
  await textHandler(doneCtx, async () => {});
  const pay = catalog
    .getPayments()
    .find((p) => p.title === "eZ Reload");
  check("payment created with 2 lines", pay?.lines.length === 2,
    JSON.stringify(pay));
  check("flow cleared", !doneCtx.session.adminFlow);

  console.log("\n== cancel flow ==");

  ctx = makeCtx({ text: "whatever" });
  attachSession(ctx);
  ctx.session = { adminFlow: { step: "game_name" } };
  await tap(ctx, "flow_cancel");
  check("flow cancelled", !ctx.session.adminFlow);

  console.log("\n== store management without a live session ==");

  // Telegraf leaves ctx.session undefined when an update carries no
  // usable session key. Writing ctx.session.adminFlow directly threw
  // "Cannot set properties of undefined" and broke the whole admin store
  // flow, so these handlers must go through the guard.
  const sessionless = [
    ["sage_blood_strike", "edit game"],
    ["sagee_blood_strike", "change emoji"],
    ["sagp_blood_strike", "new package"],
    ["sapay_reload", "view payment"],
  ];

  for (const [data, label] of sessionless) {
    const c = makeCtx({ text: undefined });

    // Deliberately no attachSession: ctx.session stays undefined.
    try {
      await tap(c, data);
      check(
        label + " survives an undefined session",
        true
      );
    } catch (error) {
      check(
        label + " survives an undefined session",
        false,
        error.message
      );
    }
  }

  const priceCtx = makeCtx({ text: undefined });
  const somePkg = catalog.getPackages("blood_strike")[0];

  if (somePkg) {
    try {
      await tap(
        priceCtx,
        `sape_price_blood_strike~${somePkg.id}`
      );
      check("update price survives an undefined session", true);
    } catch (error) {
      check(
        "update price survives an undefined session",
        false,
        error.message
      );
    }
  }

  console.log("\n== review queue without a live session ==");

  for (const [data, label] of [
    ["review_queue", "review queue"],
    ["admin_home", "admin home"],
    ["admin_pending", "pending orders"],
  ]) {
    const c = makeCtx({ text: undefined });

    try {
      await tap(c, data);
      check(label + " survives an undefined session", true);
    } catch (error) {
      check(
        label + " survives an undefined session",
        false,
        error.message
      );
    }
  }

  console.log("\n== cleanup ==");
  catalog.deleteGame(created.id);
  if (pay) catalog.deletePayment(pay.id);
  check("catalog restored to 2 games", catalog.getGames().length === 2);
  check("catalog restored to 2 payments", catalog.getPayments().length === 2);

  console.log(
    "\n" +
      (fail === 0
        ? "ALL FLOW CHECKS PASSED"
        : fail + " CHECK(S) FAILED") +
      "  (" +
      pass +
      " passed, " +
      fail +
      " failed)\n"
  );

  process.exit(fail > 0 ? 1 : 0);
})();
