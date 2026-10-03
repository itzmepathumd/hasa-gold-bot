require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const fs = require("fs");
const crypto = require("crypto");
const catalog = require("./catalog");
const playerValidate = require("./playerValidate");
const analytics = require("./analytics");
const anim = require("./anim");
const { SupplierAdapter } = require("./src/supplier");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing in .env");
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error("❌ ADMIN_ID is missing in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

/*
| Keyed per user so a flow survives updates that carry no chat, such as
| inline callbacks pressed from a message that is no longer in the chat.
*/
bot.use(
  session({
    defaultSession: () => ({}),
    getSessionKey: (ctx) =>
      ctx.from
        ? `${ctx.from.id}:${ctx.chat?.id ?? "inline"}`
        : undefined,
  })
);

/*
| Handlers write flow state through this, because Telegraf leaves
| ctx.session undefined when an update carries no usable key. Without the
| guard the store-management flows throw on ctx.session.adminFlow.
*/
function ensureSession(ctx) {
  if (!ctx.session) {
    ctx.session = {};
  }

  return ctx.session;
}

bot.use(async (ctx, next) => {
  console.log(
    "📩 UPDATE:",
    ctx.from?.id,
    ctx.message?.text || ctx.callbackQuery?.data || "other"
  );

  // Show the real "bot is typing..." indicator for anything that is not an
  // inline button press (those get their own spinner edit).
  if (!ctx.callbackQuery) {
    const action = ctx.message?.photo
      ? "upload_photo"
      : ctx.message?.document
        ? "upload_document"
        : "typing";

    anim.typing(ctx, { action, duration: 2000 });
  }

  await next();
});

/*
|--------------------------------------------------------------------------
| SUPPLIER
|--------------------------------------------------------------------------
| Approving a Free Fire weekly order sends one command to
| @tikka_auto_top_up_bot:
|
|   /id <playerId> <PRODUCT>
|
| Every other package has no confirmed supplier name, so those orders go to
| manual review rather than being sent a guessed command.
*/
const supplierAdapter = new SupplierAdapter({
  commandTemplate: "/id {playerId} {product}",

  // Free Fire "weekly" is the only confirmed supplier product name. Add a
  // Blood Strike name here only once the supplier states it.
  productMapping: {
    weekly: "WEEKLY",
  },

  responseTimeout: 60000,

  replyLogFile: "./supplier_replies.log",

  productionMode:
    process.env.SUPPLIER_PRODUCTION_MODE === "true",
});

const STORE_NAME = "HASA GOLD STORE";

/*
|--------------------------------------------------------------------------
| PRODUCTS & PAYMENT
|--------------------------------------------------------------------------
| These now come from the dynamic catalog (catalog.js) and can be
| changed by the admin at runtime from /admin.
*/

function getGame(gameId) {
  return catalog.getGame(gameId);
}

function getPackages(gameId, options) {
  return catalog.getPackages(gameId, options);
}

function activePayments() {
  return catalog.getPayments({ includePaused: false });
}

function paymentInstructions() {
  const payments = activePayments();

  if (payments.length === 0) {
    return (
      `⚠️ *PAYMENT UNAVAILABLE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `No payment methods are currently\n` +
      `enabled. Please contact support.`
    );
  }

  const blocks = payments.map((method) => {
    const lines = method.lines.length
      ? method.lines.map((l) => `${l}`).join("\n")
      : "_No details set_";

    return `${method.emoji} *${method.title}*\n\n${lines}`;
  });

  return (
    `💳 *PAYMENT METHODS*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    blocks.join("\n\n━━━━━━━━━━━━━━━━━━\n\n")
  );
}

/*
|--------------------------------------------------------------------------
| LOCAL DATABASE
|--------------------------------------------------------------------------
*/

const ORDERS_FILE = "./orders.json";
const ORDERS_TMP = "./orders.json.tmp";
const ORDERS_PREV = "./orders.prev.json";

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, "[]");
}

/*
| Every write goes through this chain, so two approvals arriving at once
| cannot interleave a read-modify-write and lose an order.
*/
let ordersWriteChain = Promise.resolve();

/**
 * Read the order list.
 *
 * A corrupt file returns ok:false rather than an empty list. Returning []
 * on a parse error would make the bot believe it has no orders, and the
 * next write would then overwrite every real order with nothing.
 */
function readOrders() {
  let raw;

  try {
    raw = fs.readFileSync(ORDERS_FILE, "utf8");
  } catch (error) {
    return { ok: false, orders: [], error: error.message };
  }

  // A crash can leave a zero-length file behind.
  if (!raw.trim()) {
    return { ok: false, orders: [], error: "orders.json is empty" };
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        orders: [],
        error: "orders.json is not a list",
      };
    }

    return { ok: true, orders: parsed, error: null };
  } catch (error) {
    return {
      ok: false,
      orders: [],
      error: "orders.json is corrupt: " + error.message,
    };
  }
}

/**
 * Orders for read-only screens. Returns [] when the file is unreadable so
 * a listing shows empty instead of crashing, but writes must not use this.
 */
function getOrders() {
  const result = readOrders();

  if (!result.ok) {
    console.error(
      `[ORDERS] Refusing to read: ${result.error}`
    );
  }

  return result.ok ? result.orders : [];
}

/**
 * Write the order list atomically and keep one rollback copy.
 */
function writeOrders(orders) {
  const payload = JSON.stringify(orders, null, 2);

  fs.writeFileSync(ORDERS_TMP, payload);

  // Keep the previous good file so a bad write can be undone by hand.
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      fs.copyFileSync(ORDERS_FILE, ORDERS_PREV);
    }
  } catch (error) {
    console.error(
      "[ORDERS] Could not save the rollback copy:",
      error.message
    );
  }

  // rename is atomic on the same filesystem, so a reader never sees a
  // half-written file.
  fs.renameSync(ORDERS_TMP, ORDERS_FILE);
}

/**
 * Run a read-modify-write in order, without racing other writers.
 */
function withOrdersLock(task) {
  const run = ordersWriteChain.then(task, task);

  ordersWriteChain = run.then(
    () => {},
    () => {}
  );

  return run;
}

/**
 * Change one order by id.
 *
 * The mutator receives the stored order and returns the record to persist.
 * It reports its decision through `decision`, so the object stored is never
 * a wrapper around the order.
 */
async function mutateOrder(orderId, mutator, decision = {}) {
  return withOrdersLock(async () => {
    const result = readOrders();

    if (!result.ok) {
      decision.ok = false;
      console.error(
        `[ORDERS] Write blocked: ${result.error}`
      );
      await notifyAdminOfStorageFailure(result.error);
      return null;
    }

    const index = result.orders.findIndex(
      (o) => o.id === orderId
    );

    if (index === -1) {
      decision.ok = true;
      decision.found = false;
      return null;
    }

    const updated = mutator(result.orders[index], decision);

    if (updated === false) {
      // The mutator declined, so nothing is written.
      decision.ok = true;
      decision.found = true;
      return result.orders[index];
    }

    result.orders[index] = updated;

    try {
      writeOrders(result.orders);
    } catch (error) {
      decision.ok = false;
      console.error(
        `[ORDERS] Write failed: ${error.message}`
      );
      await notifyAdminOfStorageFailure(error.message);
      return null;
    }

    decision.ok = true;
    decision.found = true;

    return result.orders[index];
  });
}

/**
 * Add a new order.
 */
async function appendOrder(order) {
  return withOrdersLock(async () => {
    const result = readOrders();

    if (!result.ok) {
      console.error(
        `[ORDERS] Append blocked: ${result.error}`
      );
      await notifyAdminOfStorageFailure(result.error);
      return null;
    }

    result.orders.push(order);

    try {
      writeOrders(result.orders);
    } catch (error) {
      console.error(
        `[ORDERS] Append failed: ${error.message}`
      );
      await notifyAdminOfStorageFailure(error.message);
      return null;
    }

    return order;
  });
}

/**
 * Tell the admin the order store is unusable, once per distinct reason.
 */
const storageAlerts = new Set();

async function notifyAdminOfStorageFailure(reason) {
  const key = String(reason).slice(0, 80);

  if (storageAlerts.has(key)) {
    return;
  }

  storageAlerts.add(key);

  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🚨 *ORDER STORE UNUSABLE*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${esc(reason)}\n\n` +
        `No orders were written. Check \`orders.json\`,\n` +
        `and restore from \`orders.prev.json\` if needed.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error(
      "[ORDERS] Could not send the alert:",
      error.message
    );
  }
}

/*
|--------------------------------------------------------------------------
| ORDER ID
|--------------------------------------------------------------------------
*/

function generateOrderId() {
  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `HG-${Date.now().toString().slice(-6)}-${random}`;
}

/*
|--------------------------------------------------------------------------
| MARKDOWN HELPERS
|--------------------------------------------------------------------------
*/
function esc(value) {
  return String(value ?? "").replace(
    /([_*[\]()~`>#+\-=|{}.!\\])/g,
    "\\$1"
  );
}

const STATUS_META = {
  pending_payment: { label: "🕒 Awaiting Payment" },
  pending_approval: { label: "🔍 Verifying Proof" },
  approved: { label: "✅ Approved" },
  rejected: { label: "❌ Rejected" },
  cancelled: { label: "🚫 Cancelled" },
  // Automatic top-up
  ready_for_topup: { label: "⚡ Ready for Top-up" },
  topup_processing: { label: "🔄 Top-up Processing" },
  topup_completed: { label: "✅ Top-up Completed" },
  topup_failed: { label: "❌ Top-up Failed" },
  needs_review: { label: "🕵️ Needs Review" },
};

function statusBadge(status) {
  const meta = STATUS_META[status] || {
    label: "📌 " + status,
  };

  return `${meta.label}`;
}

/*
|--------------------------------------------------------------------------
| CUSTOMER NOTIFICATION
|--------------------------------------------------------------------------
| Pushes a result to a customer with a staged reveal.
*/
async function notifyCustomer(order, { title, body }) {
  return anim.notifyCustomer(bot, order, { title, body });
}

/*
|--------------------------------------------------------------------------
| ADMIN ORDER MESSAGE EDIT
|--------------------------------------------------------------------------
| Order notices reach the admin either as a photo with a caption or as a
| plain text message. Telegram refuses to edit a caption that does not
| exist, so pick the method that matches the message being edited.
| Failures are swallowed on purpose: the order status is already saved
| and the customer notification must still be delivered.
*/
async function editOrderNotice(ctx, text) {
  const message = ctx.callbackQuery?.message;

  try {
    // Photo notices carry a caption; plain notices carry text.
    if (message?.photo) {
      await ctx.editMessageCaption(text);
    } else if (message?.text || message?.caption) {
      await ctx.editMessageText(text);
    } else if (typeof ctx.editMessageCaption === "function") {
      await ctx.editMessageCaption(text);
    } else {
      await ctx.editMessageText(text);
    }
  } catch {
    /* the notice stays as-is; status is already saved */
  }
}

/*
|--------------------------------------------------------------------------
| ORDER CONFIRMATION HELPER
|--------------------------------------------------------------------------
*/
async function sendOrderConfirmation(ctx, game, pkg, playerId, playerInfo, validationError) {
  const playerInfoText = playerInfo
    ? `\n👤 PLAYER NAME\n${esc(playerInfo.player_name)}\n\n🌍 REGION\n${esc(playerInfo.region || "Global")}\n`
    : "";

  await ctx.reply(
    `🧾 *ORDER CONFIRMATION*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `📦 *PACKAGE*\n${pkg.name}\n\n` +
      `🆔 *${game.idLabel.toUpperCase()}*\n\`${playerId}\`` +
      `${playerInfoText}` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 *TOTAL*\nLKR ${catalog.formatPrice(pkg.price)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${validationError && validationError.retryable
        ? "⚠️ Validation skipped — service was unavailable. Proceed at your own risk.\n\n"
        : ""
      }` +
      `⚠️ Please check your ${game.idLabel}\n` +
      `and package before confirming.\n\n` +
      `👇 *Ready to place your order?*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(LABEL.confirm, "confirm_order"),
        ],
        [
          Markup.button.callback(LABEL.cancel, "cancel_order"),
        ],
      ]),
    }
  );
}

/*
|--------------------------------------------------------------------------
| BUTTON REVEAL
|--------------------------------------------------------------------------
| Rewrites the tapped button message into a brief spinner, then into the
| destination screen. Gives inline navigation a sense of motion.
*/
/*
|--------------------------------------------------------------------------
| UI TEXT
|--------------------------------------------------------------------------
*/
const UI = {
  home: `✨ *${STORE_NAME}* ✨

🎮 *Gaming Top-Up Store*

⚡ Instant  •  🔐 Secure  •  💯 Reliable

━━━━━━━━━━━━━━━━━━

🕹️ Browse games
💎 Gold & passes
🧾 Instant order tracking

━━━━━━━━━━━━━━━━━━

👇 *What would you like to do?*`,

  gamesList: `🕹️ *CHOOSE A GAME*

━━━━━━━━━━━━━━━━━━

Pick a game to see the available
packages and start an order.`,

  support: `💬 *CUSTOMER SUPPORT*

━━━━━━━━━━━━━━━━━━

🧾 *How to get help*

Send us your *Order ID* and our
team will assist you shortly.

━━━━━━━━━━━━━━━━━━

We can help with:

💳 Payment issues
📦 Order problems
🎮 Top-up questions
❓ Anything else`,

  noOrders: `📦 *MY ORDERS*

━━━━━━━━━━━━━━━━━━

🗂 You don't have any orders yet.

🛒 Pick a game and place your
first top-up!`,

  storePaused: `⏸ *STORE PAUSED*

━━━━━━━━━━━━━━━━━━

🕒 Top-ups are temporarily
unavailable right now.

Please check back soon or
contact support for details.`,

  packagePaused: `⏸ *PACKAGE UNAVAILABLE*

━━━━━━━━━━━━━━━━━━

🕒 This package is currently
paused by the store.

Please choose another package.`,
};

/*
|--------------------------------------------------------------------------
| REPLY KEYBOARD
|--------------------------------------------------------------------------
*/
function replyMenu() {
  return Markup.keyboard([
    ["🕹️  Games"],
    ["📦  My Orders", "💬  Support"],
    ["ℹ️  About", "🏠  Home"],
  ])
    .resize()
    .persistent();
}

/*
|--------------------------------------------------------------------------
| MAIN MENU
|--------------------------------------------------------------------------
*/
const LABEL = {
  games: "🕹️  GAMES",
  bloodStrike: "🕹️  GAMES",
  myOrders: "📦  MY ORDERS",
  support: "💬  SUPPORT",
  home: "🏠  HOME",
  newOrder: "🛒  NEW ORDER",
  back: "🔙  BACK",
  confirm: "✅  CONFIRM ORDER",
  cancel: "❌  CANCEL",
  products: "🛍  PACKAGES",
  about: "ℹ️  ABOUT",
};

function homeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LABEL.games, "games")],
    [
      Markup.button.callback(LABEL.myOrders, "my_orders"),
      Markup.button.callback(LABEL.support, "support"),
    ],
    [
      Markup.button.callback(LABEL.about, "about"),
      Markup.button.callback(LABEL.home, "home"),
    ],
  ]);
}

/*
|--------------------------------------------------------------------------
| GAME LIST
|--------------------------------------------------------------------------
*/
function gamesListText() {
  const games = catalog.activeGames();

  if (games.length === 0) {
    return UI.storePaused;
  }

  const rows = games.map(
    (g) => `${g.emoji} *${g.name}*  —  ${g.packages.filter((p) => !p.paused).length} packages`
  );

  return (
    `${UI.gamesList}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    rows.join("\n")
  );
}

function gamesMenu() {
  const games = catalog.activeGames();

  const rows = games.map((g) => [
    Markup.button.callback(
      `${g.emoji}  ${g.name}`,
      `game_${g.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(LABEL.myOrders, "my_orders"),
    Markup.button.callback(LABEL.home, "home"),
  ]);

  return Markup.inlineKeyboard(rows);
}

/*
|--------------------------------------------------------------------------
| PACKAGE LIST
|--------------------------------------------------------------------------
*/
function packageListText(game) {
  return (
    `${game.emoji} *${game.name.toUpperCase()}*\n\n` +
    `💎 *SELECT A PACKAGE*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚡ Fast order processing\n` +
    `🔐 Secure payment verification`
  );
}

function packageMenu(game) {
  const available = getPackages(game.id, { includePaused: false });

  if (available.length === 0) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(LABEL.games, "games"),
        Markup.button.callback(LABEL.home, "home"),
      ],
    ]);
  }

  const rows = [];

  available.forEach((pkg) => {
    rows.push([
      Markup.button.callback(
        `${pkg.name}  •  LKR ${catalog.formatPrice(pkg.price)}`,
        `pick_${game.id}~${pkg.id}`
      ),
    ]);
  });

  rows.push([
    Markup.button.callback(LABEL.games, "games"),
    Markup.button.callback(LABEL.home, "home"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function cancelFlowButton() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "❌  CANCEL",
        "flow_cancel"
      ),
    ],
  ]);
}

function supportMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(LABEL.games, "games"),
      Markup.button.callback(LABEL.home, "home"),
    ],
    [Markup.button.callback(LABEL.about, "about")],
  ]);
}

/*
|--------------------------------------------------------------------------
| ABOUT / DEVELOPER
|--------------------------------------------------------------------------
*/
const DEVELOPER = {
  company: "Vynloq Software Solutions",
  telegram: "methsarap",
  whatsapp: "+94753492120",
  website: "https://www.vynloq.web.app",
};

function aboutMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.url(
        "💬  TELEGRAM",
        `https://t.me/${DEVELOPER.telegram}`
      ),
      Markup.button.url(
        "📞  WHATSAPP",
        `https://wa.me/${DEVELOPER.whatsapp.replace(/\D/g, "")}`
      ),
    ],
    [
      Markup.button.url(
        "🌐  WEBSITE",
        DEVELOPER.website
      ),
    ],
    [
      Markup.button.callback(LABEL.games, "games"),
      Markup.button.callback(LABEL.support, "support"),
      Markup.button.callback(LABEL.home, "home"),
    ],
  ]);
}

function aboutText() {
  return (
    `<b>✨ HASA GOLD STORE ✨</b>\n` +
    `<i>Premium gaming top-ups, delivered fast</i>\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👨‍💻 <b>DEVELOPER</b>\n\n` +
    `🏢 <b>Company</b>\n${DEVELOPER.company}\n\n` +
    `💬 <b>Telegram</b>\n@${DEVELOPER.telegram}\n\n` +
    `📞 <b>WhatsApp</b>\n${DEVELOPER.whatsapp}\n\n` +
    `🌐 <b>Website</b>\n${DEVELOPER.website}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 What we offer\n\n` +
    `🕹️ Blood Strike — Gold &amp; passes\n` +
    `🔥 Free Fire — Weekly passes\n` +
    `⚡ Instant player ID verification\n` +
    `🔒 Secure manual payment review\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💜 Built with care by\n` +
    `<b>${DEVELOPER.company}</b>\n\n` +
    `Thank you for shopping with us! 🎉`
  );
}

async function showAbout(ctx) {
  await anim.stages(ctx, {
    title: "Loading developer info",
    emoji: "✨",
    spinner: "search",
    barStyle: "round",
    steps: [
      "Gathering store details",
      "Loading developer profile",
      "Preparing contact links",
    ],
    frame: 700,
    minDuration: 2600,
    // The reveal carries its own keyboard and parse mode, so the buttons
    // land on the same message as the page.
    final: () => ({
      text: aboutText(),
      parse_mode: "HTML",
      extra: aboutMenu(),
    }),
  });
}

function ordersMenu(hasOrders) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        hasOrders ? LABEL.newOrder : LABEL.games,
        "games"
      ),
    ],
    [Markup.button.callback(LABEL.home, "home")],
  ]);
}
/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/
bot.start(async (ctx) => {
  ctx.session = {};

  await ctx.reply(UI.home, {
    parse_mode: "Markdown",
    ...replyMenu(),
  });
});

bot.command("orders", async (ctx) => {
  await sendMyOrders(ctx, false);
});

bot.command("games", async (ctx) => {
  await showGames(ctx, false);
});

bot.command("about", async (ctx) => {
  await showAbout(ctx);
});

/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/
bot.action("home", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  ctx.session = {};

  await ctx.editMessageText(UI.home, {
    parse_mode: "Markdown",
    ...homeMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| GAMES LIST
|--------------------------------------------------------------------------
*/
async function showGames(ctx, isEdit) {
  const text = gamesListText();

  if (text === UI.storePaused) {
    return isEdit
      ? ctx.editMessageText(text, {
          parse_mode: "Markdown",
          ...homeMenu(),
        })
      : ctx.reply(text, {
          parse_mode: "Markdown",
          ...homeMenu(),
        });
  }

  if (isEdit) {
    return anim.revealEdit(ctx, "Loading games", text, {
      parse_mode: "Markdown",
      ...gamesMenu(),
    }, { spinner: "search", frames: 3, delay: 300 });
  }

  return ctx.reply(text, {
    parse_mode: "Markdown",
    ...gamesMenu(),
  });
}

bot.action("games", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  await showGames(ctx, true);
});

/*
|--------------------------------------------------------------------------
| GAME -> PACKAGES
|--------------------------------------------------------------------------
*/
bot.action(/^game_(.+)$/, async (ctx) => {
  const gameId = ctx.match[1];
  const game = getGame(gameId);

  if (!game || game.paused) {
    return ctx.answerCbQuery(
      {
        text: "⏸ This game is currently unavailable.",
        show_alert: true,
      }
    );
  }

  const available = getPackages(gameId, { includePaused: false });

  if (available.length === 0) {
    return ctx.answerCbQuery(
      {
        text: "⏸ No packages are available for this game yet.",
        show_alert: true,
      }
    );
  }

  // A stale button tap makes answerCbQuery throw; that must not stop the
  // package list from rendering, so ack defensively.
  await ctx.answerCbQuery().catch(() => {});

  await ctx.editMessageText(packageListText(game), {
    parse_mode: "Markdown",
    ...packageMenu(game),
  });
});

/*
|--------------------------------------------------------------------------
| PACKAGE SELECTION
|--------------------------------------------------------------------------
*/
bot.action(/^pick_(.+)~(.+)$/, async (ctx) => {
  const [, gameId, packageId] = ctx.match;

  const found = catalog.findPackage(gameId, packageId);

  if (!found || found.game.paused || found.pkg.paused) {
    return ctx.answerCbQuery(
      {
        text: "⏸ This package is currently unavailable.",
        show_alert: true,
      }
    );
  }

  await ctx.answerCbQuery().catch(() => {});

  const { game, pkg } = found;

  ensureSession(ctx).gameId = game.id;
  ensureSession(ctx).packageId = pkg.id;
  ensureSession(ctx).selectedProduct = pkg.id;
  ensureSession(ctx).waitingForPlayerId = true;

  await anim.revealEdit(
    ctx,
    "Preparing your package",
    `${game.emoji} *${pkg.name}*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `💰 *PRICE*\nLKR ${catalog.formatPrice(pkg.price)}\n\n` +
      `⚡ Fast Processing\n` +
      `🔐 Secure Payment Verification\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🆔 *${game.idLabel.toUpperCase()}*\n\n` +
      `Please send your ${game.name} ${game.idLabel} below.\n\n` +
      `Example:\n\`${game.idExample}\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(LABEL.products, `game_${game.id}`),
        ],
        [Markup.button.callback(LABEL.cancel, "cancel_order")],
      ]),
    },
    { spinner: "package", frames: 3, delay: 300 }
  );
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  await ctx.editMessageText(UI.support, {
    parse_mode: "Markdown",
    ...supportMenu(),
  });
});

bot.action("about", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  // The page is long, so it is sent as a new message rather than edited
  // into the button that was tapped.
  await showAbout(ctx);
});
/*
|--------------------------------------------------------------------------
| ADMIN TEXT FLOWS
|--------------------------------------------------------------------------
| Registered before the customer text handler so admin input is never
| mistaken for a Player ID.
*/
bot.on("text", async (ctx, next) => {
  if (ctx.from.id !== ADMIN_ID) {
    return next();
  }

  const flow = ctx.session?.adminFlow;

  if (!flow) {
    return next();
  }

  const text = ctx.message.text.trim();

  if (flow.step === "customer_search") {
    ensureSession(ctx).adminFlow = null;

    const orders = getOrders();
    const users = analytics.buildUsers(orders);
    const hits = analytics.findUsers(users, text);

    if (!hits.length) {
      return ctx.reply(
        `🔎 NO MATCHES\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `Nothing found for *${esc(text)}*.\n\n` +
          `Try a username, name, or Telegram ID.`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔎  SEARCH AGAIN", "admin_user_search")],
            [Markup.button.callback("👥  ALL CUSTOMERS", "admin_users")],
          ]),
        }
      );
    }

    if (hits.length === 1) {
      const user = hits[0];

      return ctx.reply(userDetailText(user, orders), {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("👥  ALL CUSTOMERS", "admin_users")],
          [Markup.button.callback("🔙  Admin Panel", "admin_home")],
        ]),
      });
    }

    const rows = hits.slice(0, 20).map((u) => [
      Markup.button.callback(
        `${u.username ? `@${u.username}` : u.firstName || u.userId}  ·  LKR ${analytics.money(u.spend)}`,
        `admin_user_${u.userId}`
      ),
    ]);

    return ctx.reply(
      `🔎 ${hits.length} MATCHES for *${esc(text)}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        resultsListText(hits),
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          ...rows,
          [Markup.button.callback("👥  ALL CUSTOMERS", "admin_users")],
          [Markup.button.callback("🔙  Admin Panel", "admin_home")],
        ]),
      }
    );
  }

  if (flow.step === "game_name") {
    ensureSession(ctx).adminFlow = { step: "game_emoji", gameName: text };

    return ctx.reply(
      `🎮 *NEW GAME*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Name: *${esc(text)}* ✅\n\n` +
        `Now send an *emoji* for this game.\n\n` +
        `Example: 🎮`,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "game_emoji") {
    const game = catalog.addGame({
      name: flow.gameName,
      emoji: text,
    });

    ensureSession(ctx).adminFlow = {
      step: "package_name",
      gameId: game.id,
    };

    return ctx.reply(
      `✅ *${esc(game.name)}* created!\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🕹️ ID: \`${game.id}\`\n` +
        `📦 Packages: 0\n\n` +
        `Now send the *name* of the first package.`,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "game_idlabel") {
    catalog.updateGame(flow.gameId, { idLabel: text });

    const game = getGame(flow.gameId);

    ensureSession(ctx).adminFlow = null;

    return ctx.reply(
      `✅ *${esc(game.name)}* updated.\n\n` +
        `Now add your first package.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "➕  ADD PACKAGE",
              `sagp_${game.id}`
            ),
          ],
          [
            Markup.button.callback(
              `🔙  ${game.emoji}  ${game.name}`,
              `sag_${game.id}`
            ),
          ],
        ]),
      }
    );
  }

  if (flow.step === "package_name") {
    ensureSession(ctx).adminFlow = {
      step: "package_price",
      gameId: flow.gameId,
      packageName: text,
    };

    return ctx.reply(
      `📦 *NEW PACKAGE*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Name: *${esc(text)}* ✅\n\n` +
        `Now send the *price* in LKR.\n\n` +
        `Example: \`1100\``,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "package_price") {
    const price = Number(text.replace(/[^0-9.]/g, ""));

    if (!Number.isFinite(price) || price <= 0) {
      return ctx.reply(
        `❌ *Invalid price*\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `Send a number greater than 0.\n\n` +
          `Example: \`1100\``,
        { parse_mode: "Markdown" }
      );
    }

    ensureSession(ctx).adminFlow = {
      step: "package_sub_category",
      gameId: flow.gameId,
      packageName: flow.packageName,
      packagePrice: price,
    };

    return ctx.reply(
      `📦 *NEW PACKAGE*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Name: *${esc(flow.packageName)}* ✅\n` +
        `Price: LKR ${catalog.formatPrice(price)} ✅\n\n` +
        `Now send the *Sub-Category ID* for player validation.\n\n` +
        `This is a numeric ID from your validation provider.\n` +
        `Send \`0\` or \`skip\` to disable player validation for this package.\n\n` +
        `Example: \`999\``,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "package_sub_category") {
    let subCategoryId = null;
    const cleaned = text.trim().toLowerCase();

    if (cleaned !== "0" && cleaned !== "skip") {
      const parsed = Number(text.replace(/[^0-9]/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        subCategoryId = parsed;
      } else {
        return ctx.reply(
          `❌ *Invalid Sub-Category ID*\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Send a positive number, or \`0\` / \`skip\` to disable.\n\n` +
            `Example: \`999\``,
          { parse_mode: "Markdown" }
        );
      }
    }

    ensureSession(ctx).adminFlow = {
      step: "package_requirements",
      gameId: flow.gameId,
      packageName: flow.packageName,
      packagePrice: flow.packagePrice,
      subCategoryId,
    };

    return ctx.reply(
      `📦 *NEW PACKAGE*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Name: *${esc(flow.packageName)}* ✅\n` +
        `Price: LKR ${catalog.formatPrice(flow.packagePrice)} ✅\n` +
        `Sub-Category ID: ${subCategoryId ? subCategoryId : "Disabled"} ✅\n\n` +
        `Now send *validation requirement fields* as JSON (optional).\n\n` +
        `These are extra fields needed by the validation API.\n` +
        `Example: \`{"server": "Asia"}\`\n\n` +
        `Send \`{}\` or \`skip\` for none.`,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "package_requirements") {
    let requirements = [];
    const cleaned = text.trim().toLowerCase();

    if (cleaned !== "{}" && cleaned !== "skip") {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          requirements = Object.entries(parsed).map(([key, value]) => ({ field_name: key, value: String(value) }));
        }
      } catch {
        return ctx.reply(
          `❌ *Invalid JSON*\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Send valid JSON like \`{"server": "Asia"}\`\n` +
            `or \`{}\` / \`skip\` for none.`,
          { parse_mode: "Markdown" }
        );
      }
    }

    const pkg = catalog.addPackage(flow.gameId, {
      name: flow.packageName,
      price: flow.packagePrice,
      sub_category_id: flow.subCategoryId,
      requirements,
    });

    const game = getGame(flow.gameId);

    ensureSession(ctx).adminFlow = null;

    return ctx.reply(
      `✅ *${esc(pkg.name)}* added!\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 LKR ${catalog.formatPrice(pkg.price)}\n` +
        `🔢 Sub-Category ID: ${pkg.sub_category_id || "Disabled"}\n` +
        `📋 Requirements: ${pkg.requirements.length > 0 ? pkg.requirements.map(r => `${r.field_name}=${r.value}`).join(", ") : "None"}\n\n` +
        `Add another package or finish.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "➕  ADD ANOTHER",
              `sagp_${game.id}`
            ),
          ],
          [
            Markup.button.callback(
              `🔙  ${game.emoji}  ${game.name}`,
              `sag_${game.id}`
            ),
          ],
        ]),
      }
    );
  }

  if (flow.step === "package_price_update") {
    const price = Number(text.replace(/[^0-9.]/g, ""));

    if (!Number.isFinite(price) || price <= 0) {
      return ctx.reply(
        `❌ *Invalid price*\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `Send a number greater than 0.\n\n` +
          `Example: \`1100\``,
        { parse_mode: "Markdown" }
      );
    }

    catalog.updatePackage(flow.gameId, flow.packageId, { price });

    const found = catalog.findPackage(flow.gameId, flow.packageId);

    ensureSession(ctx).adminFlow = null;

    return ctx.reply(
      `✅ *PRICE UPDATED*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${found.pkg.name}\n` +
        `💰 LKR ${catalog.formatPrice(found.pkg.price)}`,
      {
        parse_mode: "Markdown",
        ...packageAdminMenu(found.game, found.pkg),
      }
    );
  }

  if (flow.step === "package_rename") {
    catalog.updatePackage(flow.gameId, flow.packageId, { name: text });

    const found = catalog.findPackage(flow.gameId, flow.packageId);

    ensureSession(ctx).adminFlow = null;

    return ctx.reply(
      `✅ *PACKAGE RENAMED*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${found.pkg.name}\n` +
        `💰 LKR ${catalog.formatPrice(found.pkg.price)}`,
      {
        parse_mode: "Markdown",
        ...packageAdminMenu(found.game, found.pkg),
      }
    );
  }

  if (flow.step === "payment_title") {
    ensureSession(ctx).adminFlow = {
      step: "payment_lines",
      paymentTitle: text,
      buffer: [],
    };

    return ctx.reply(
      `💳 *${esc(text)}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Send each *detail line*.\n\n` +
        `Example:\n` +
        `\`🏦 Bank: Commercial Bank\`\n` +
        `\`🔢 Account: 12345678\`\n\n` +
        `Send *DONE* when finished.`,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "payment_lines") {
    if (/^done$/i.test(text)) {
      if (!flow.buffer.length) {
        return ctx.reply(
          `⚠️ *No details added yet*\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Send at least one detail line,\n` +
            `or send *CANCEL* to abort.`,
          { parse_mode: "Markdown", ...cancelFlowButton() }
        );
      }

      const isEdit = Boolean(flow.paymentId);

      const payment = isEdit
        ? catalog.updatePayment(flow.paymentId, { lines: flow.buffer })
        : catalog.addPayment({
            title: flow.paymentTitle,
            lines: flow.buffer,
          });

      ensureSession(ctx).adminFlow = null;

      return ctx.reply(
        `✅ *${esc(payment.title)}* saved!\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `${payment.lines.map((l) => `\`${esc(l)}\``).join("\n")}`,
        {
          parse_mode: "Markdown",
          ...paymentAdminMenu(payment),
        }
      );
    }

    ensureSession(ctx).adminFlow.buffer = [
      ...(flow.buffer || []),
      text,
    ];

    return ctx.reply(
      `✅ Added: \`${esc(text)}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${ensureSession(ctx).adminFlow.buffer
          .map((l, i) => `${i + 1}. ${esc(l)}`)
          .join("\n")}\n\n` +
        `Send more lines or *DONE*.`,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  if (flow.step === "payment_rename") {
    const payment = catalog.updatePayment(flow.paymentId, {
      title: text,
    });

    ensureSession(ctx).adminFlow = null;

    return ctx.reply(
      `✅ *PAYMENT METHOD RENAMED*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${payment.emoji} ${esc(payment.title)}`,
      {
        parse_mode: "Markdown",
        ...paymentAdminMenu(payment),
      }
    );
  }

  ensureSession(ctx).adminFlow = null;

  return next();
});

bot.action("flow_cancel", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  ensureSession(ctx).adminFlow = null;

  await ctx.reply(
    `❌ *Cancelled*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `No changes were saved.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🛠️  MANAGE STORE",
            "store_home"
          ),
        ],
      ]),
    }
  );
});

/*
|--------------------------------------------------------------------------
| REPLY KEYBOARD
|--------------------------------------------------------------------------
| Registered before bot.on("text") so these are matched first.
*/
bot.hears("🕹️  Games", async (ctx) => {
  await showGames(ctx, false);
});

bot.hears("📦  My Orders", async (ctx) => {
  await sendMyOrders(ctx, false);
});

bot.hears("💬  Support", async (ctx) => {
  await ctx.reply(UI.support, {
    parse_mode: "Markdown",
    ...supportMenu(),
  });
});

bot.hears("🏠  Home", async (ctx) => {
  ctx.session = {};

  await ctx.reply(UI.home, {
    parse_mode: "Markdown",
    ...homeMenu(),
  });
});

bot.hears("ℹ️  About", async (ctx) => {
  await showAbout(ctx);
});

/*
|--------------------------------------------------------------------------
| PLAYER ID
|--------------------------------------------------------------------------
*/
bot.on("text", async (ctx, next) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    return next();
  }

  if (!ctx.session?.waitingForPlayerId) {
    return;
  }

  const playerId = text;

  const gameId = ensureSession(ctx).gameId;
  const packageId = ensureSession(ctx).packageId;

  const found = catalog.findPackage(gameId, packageId);

  if (!found || found.game.paused || found.pkg.paused) {
    ctx.session = {};

    return ctx.reply(
      `${UI.packagePaused}\n\n━━━━━━━━━━━━━━━━━━\n\n🕹️ Choose another game:`,
      {
        parse_mode: "Markdown",
        ...gamesMenu(),
      }
    );
  }

  const { game, pkg } = found;

  if (!/^[0-9]{5,20}$/.test(playerId)) {
    return ctx.reply(
      `❌ *Invalid ${game.idLabel}*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Please send only the numbers of your\n` +
        `${game.name} ${game.idLabel}.\n\n` +
        `Example:\n\`${game.idExample}\``,
      { parse_mode: "Markdown" }
    );
  }

  // Validate player with SHOP2TOPUP if sub_category_id is configured.
  // stages() owns one message end to end: animate -> API call -> reveal,
  // so the loader never survives as an orphan line above the result.
  const subCategoryId = pkg.sub_category_id;
  let playerInfo = null;
  let validationError = null;

  if (subCategoryId) {
    const { result } = await anim.stages(ctx, {
      title: "Checking Player ID",
      emoji: "🔍",
      spinner: "search",
      barStyle: "round",
      steps: [
        "Connecting to game servers",
        "Looking up player profile",
        "Verifying account status",
      ],
      frame: 800,
      parseMode: "Markdown",
      work: () => playerValidate.validateShop2TopupPlayer(playerId, pkg),

      final: (r) => {
        if (r?.success) {
          return (
            `✅ PLAYER VERIFIED\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 ${esc(game.idLabel.toUpperCase())}\n\`${playerId}\`\n\n` +
            `👤 Player Name\n${esc(r.playerName)}\n\n` +
            `🌍 Region\n${esc(r.region || "Global")}\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `Please confirm this is your account.`
          );
        }

        const e = r || {};
        const retryable = Boolean(e.retryable);

        const heading =
          e.error === "PLAYER_NOT_FOUND"
            ? "❌ PLAYER NOT FOUND"
            : e.error === "PLAYER_CHECK_UNAVAILABLE" ||
                e.error === "NETWORK_ERROR"
              ? "⚠️ VERIFICATION UNAVAILABLE"
              : e.error === "PLAYER_BUSY"
                ? "⏳ PLAYER BUSY"
                : e.error === "RATE_LIMIT_EXCEEDED"
                  ? "🚫 TOO MANY REQUESTS"
                  : `❌ ${esc(String(e.error || "ERROR").replace(/_/g, " "))}`;

        const advice =
          e.error === "PLAYER_NOT_FOUND"
            ? "This ID does not exist in the game. Please check it and try again."
            : e.error === "PLAYER_CHECK_UNAVAILABLE" ||
                e.error === "NETWORK_ERROR"
              ? "We could not reach the game right now. Your ID has not been rejected — please try again in a moment."
              : e.error === "PLAYER_BUSY"
                ? "The game is busy for this player. Please try again shortly."
                : e.error === "RATE_LIMIT_EXCEEDED"
                  ? "Too many checks right now. Please wait a minute and retry."
                  : esc(e.message || "Something went wrong. Please try again.");

        return (
          `${heading}\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `🆔 ${esc(game.idLabel.toUpperCase())}\n\`${playerId}\`\n\n` +
          `💬 ${advice}\n\n` +
          (retryable
            ? `🔄 Send your ${game.idLabel} again to retry.`
            : `💬 Contact support if this keeps happening.`)
        );
      },
    });

    if (result?.success) {
      // Hold the verified player in session; the order is only placed
      // after the customer taps Confirm.
      ensureSession(ctx).pendingPlayerId = playerId;
      ensureSession(ctx).pendingPlayerInfo = {
        player_id: result.playerId,
        player_name: result.playerName,
        region: result.region,
      };
      ensureSession(ctx).waitingForPlayerId = false;

      await anim.successBeat(ctx, {
        text:
          `👆 Tap Confirm below to continue with this account,` +
          ` or Change ID to enter a different one.`,
        extra: {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("✅  CONFIRM", "confirm_player"),
              Markup.button.callback("✏️  CHANGE ID", "change_player_id"),
            ],
          ]),
        },
      });

      return;
    }

    validationError = result;

    // Retryable problems must not look like a wrong ID.
    const retryable = Boolean(result?.retryable);

    if (retryable || result?.error === "PLAYER_NOT_FOUND") {
      return; // Keep waitingForPlayerId set so a retry just works.
    }
    // Other failures are non-retryable; fall through to the order screen.
  }

  // No validation configured or non-retryable error - proceed to order confirmation
  ensureSession(ctx).playerId = playerId;
  ensureSession(ctx).playerInfo = playerInfo;
  ensureSession(ctx).waitingForPlayerId = false;

  await sendOrderConfirmation(ctx, game, pkg, playerId, playerInfo, validationError);
});

/*
|--------------------------------------------------------------------------
| PLAYER CONFIRMATION
|--------------------------------------------------------------------------
| After successful player validation, user confirms or changes their ID
*/
bot.action("confirm_player", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const playerId = ctx.session?.pendingPlayerId;
  const playerInfo = ctx.session?.pendingPlayerInfo;
  const gameId = ctx.session?.gameId;
  const packageId = ctx.session?.packageId;

  if (!playerId || !gameId || !packageId) {
    return ctx.reply(
      "❌ *Session expired*\n\n" +
        "━━━━━━━━━━━━━━━━━━\n\n" +
        "Please start a new order.",
      { parse_mode: "Markdown", ...homeMenu() }
    );
  }

  const found = catalog.findPackage(gameId, packageId);

  if (!found || found.game.paused || found.pkg.paused) {
    ctx.session = {};

    return ctx.reply(
      `${UI.packagePaused}\n\n━━━━━━━━━━━━━━━━━━\n\n🕹️ Choose another game:`,
      {
        parse_mode: "Markdown",
        ...gamesMenu(),
      }
    );
  }

  const { game, pkg } = found;

  // Promote the verified player into the live order session.
  ensureSession(ctx).playerId = playerId;
  ensureSession(ctx).playerInfo = playerInfo;
  ensureSession(ctx).waitingForPlayerId = false;

  // Drop the verified screen so only the order summary remains.
  try {
    await ctx.editMessageText("✅ Confirmed. Building your order…", {
      parse_mode: "Markdown",
    });
  } catch { /* already gone, or content identical */ }

  await sendOrderConfirmation(ctx, game, pkg, playerId, playerInfo, null);
});

bot.action("change_player_id", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const gameId = ctx.session?.gameId;
  const packageId = ctx.session?.packageId;

  if (!gameId || !packageId) {
    return ctx.reply(
      "❌ *Session expired*\n\n" +
        "━━━━━━━━━━━━━━━━━━\n\n" +
        "Please start a new order.",
      { parse_mode: "Markdown", ...homeMenu() }
    );
  }

  const found = catalog.findPackage(gameId, packageId);

  if (!found || found.game.paused || found.pkg.paused) {
    ctx.session = {};

    return ctx.reply(
      `${UI.packagePaused}\n\n━━━━━━━━━━━━━━━━━━\n\n🕹️ Choose another game:`,
      {
        parse_mode: "Markdown",
        ...gamesMenu(),
      }
    );
  }

  const { game, pkg } = found;

  // Discard the pending verification and ask for a fresh ID.
  ensureSession(ctx).pendingPlayerId = null;
  ensureSession(ctx).pendingPlayerInfo = null;
  ensureSession(ctx).playerId = null;
  ensureSession(ctx).playerInfo = null;
  ensureSession(ctx).waitingForPlayerId = true;

  // Tidy the verified screen away in place of a dead prompt.
  try {
    await ctx.editMessageText(
      `✏️ *CHANGE PLAYER ID*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🎮 *GAME*\n${game.name}\n\n` +
        `📦 *PACKAGE*\n${pkg.name}\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Please send your ${game.name} ${game.idLabel} again.\n\n` +
        `Example:\n\`${game.idExample}\``,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(LABEL.cancel, "cancel_order")],
        ]),
      }
    );

    return;
  } catch { /* fall through to a new message */ }

  await ctx.reply(
    `✏️ *CHANGE PLAYER ID*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `📦 *PACKAGE*\n${pkg.name}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Please enter your ${game.name} ${game.idLabel} again.\n\n` +
      `Example:\n\`${game.idExample}\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(LABEL.cancel, "cancel_order")],
      ]),
    }
  );
});

/*
|--------------------------------------------------------------------------
| CONFIRM ORDER
|--------------------------------------------------------------------------
*/

bot.action("confirm_order", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  const gameId = ctx.session?.gameId;
  const packageId = ctx.session?.packageId;
  const playerId = ctx.session?.playerId;

  if (!gameId || !packageId || !playerId) {
    return ctx.reply(
      "❌ *Order session expired*\n\n" +
        "━━━━━━━━━━━━━━━━━━\n\n" +
        "Please start a new order.",
      { parse_mode: "Markdown", ...homeMenu() }
    );
  }

  const found = catalog.findPackage(gameId, packageId);

  if (!found || found.game.paused || found.pkg.paused) {
    ctx.session = {};

    return ctx.reply(
      `${UI.packagePaused}\n\n━━━━━━━━━━━━━━━━━━\n\n🕹️ Choose another game:`,
      {
        parse_mode: "Markdown",
        ...gamesMenu(),
      }
    );
  }

  const { game, pkg } = found;

  const playerInfo = ctx.session?.playerInfo || null;

  const order = {
    id: generateOrderId(),

    userId: ctx.from.id,

    username: ctx.from.username || null,

    firstName: ctx.from.first_name || "",

    playerId: playerId,

    playerName: playerInfo?.player_name || null,

    playerRegion: playerInfo?.region || null,

    gameId: game.id,

    gameName: game.name,

    idLabel: game.idLabel,

    productKey: pkg.id,

    productName: pkg.name,

    price: pkg.price,

    status: "pending_payment",

    paymentProof: null,

    createdAt: new Date().toISOString(),

    paymentSubmittedAt: null,

    approvedAt: null,

    rejectedAt: null,

    // Automatic top-up tracking. Filled in as the order moves.
    topupStatus: null,
    topupAttempts: 0,
    supplierTransactionId: null,
    supplierMessageId: null,
    topupStartedAt: null,
    topupCompletedAt: null,
    topupError: null,
    supplierRawReply: null,
  };

  const created = await appendOrder(order);

  if (!created) {
    return ctx.reply(
      `⚠️ *ORDER NOT SAVED*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `We could not store your order.\n\n` +
        `Please try again in a moment, or contact\n` +
        `support with your payment details.`,
      {
        parse_mode: "Markdown",
        ...supportMenu(),
      }
    );
  }

  ensureSession(ctx).orderId = order.id;
  ensureSession(ctx).waitingForPayment = true;

  // Confirm button was tapped on the order-summary message: rewrite that
  // message into the payment screen so the flow feels continuous.
  await anim.revealEdit(
    ctx,
    "Creating your order",
    `💳 *PAYMENT REQUIRED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🧾 *ORDER ID*\n\`${esc(order.id)}\`\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `📦 *PACKAGE*\n${esc(order.productName)}\n\n` +
      `🆔 *${esc(game.idLabel.toUpperCase())}*\n\`${esc(order.playerId)}\`\n\n` +
      `💰 *TOTAL*\nLKR ${catalog.formatPrice(pkg.price)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${paymentInstructions()}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📸 *PAYMENT PROOF*\n\n` +
      `After making the payment, send your\n` +
      `payment screenshot here.\n\n` +
      `⚡ Your order will be processed after\n` +
      `admin verification.\n\n` +
      `🔐 *${STORE_NAME}*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📸  I HAVE PAID", "payment_done"),
        ],
        [
          Markup.button.callback("❌  CANCEL ORDER", "cancel_order"),
        ],
      ]),
    },
    { spinner: "gear", frames: 3, delay: 300 }
  );
});

bot.action("payment_done", async (ctx) => {
  await ctx.answerCbQuery(
    {
      text: "📸 Now send the payment screenshot.",
      show_alert: true,
    }
  );
});


/*
|--------------------------------------------------------------------------
| CANCEL ORDER
|--------------------------------------------------------------------------
*/

bot.action("cancel_order", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  ctx.session = {};

  await ctx.reply(
    `❌ Order cancelled.

You can start a new order whenever you're ready.`,
    homeMenu()
  );
});

/*
|--------------------------------------------------------------------------
| PAYMENT SCREENSHOT
|--------------------------------------------------------------------------
*/

bot.on("photo", async (ctx) => {
  const orderId = ctx.session?.orderId;

  if (!orderId) {
    return ctx.reply(
      "❌ Please create an order before sending a payment screenshot."
    );
  }

  const orders = getOrders();

  const order = orders.find(
    (o) => o.id === orderId
  );

  if (!order) {
    return ctx.reply(
      "❌ Order not found."
    );
  }

  if (order.status !== "pending_payment") {
    return ctx.reply(
      `⚠️ This order is not waiting for payment.

Status: ${statusBadge(order.status)}`
    );
  }

  const photos = ctx.message.photo;

  const largestPhoto =
    photos[photos.length - 1];

  const proof = largestPhoto.file_id;
  const submittedAt = new Date().toISOString();

  const saved = await mutateOrder(order.id, (current) => {
    if (current.status !== "pending_payment") {
      return false;
    }

    current.paymentProof = proof;
    current.status = "pending_approval";
    current.paymentSubmittedAt = submittedAt;

    return current;
  });

  if (!saved) {
    return ctx.reply(
      `⚠️ *COULD NOT SAVE YOUR PROOF*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Something went wrong while storing your\n` +
        `screenshot.\n\n` +
        `Please send it again, or contact support.`,
      {
        parse_mode: "Markdown",
        ...supportMenu(),
      }
    );
  }

  ensureSession(ctx).waitingForPayment = false;

  await anim.stages(ctx, {
    title: "Submitting your payment proof",
    steps: [
      "Screenshot received",
      "Reading payment details",
      "Saving receipt",
      "Sending to store admin",
    ],
    final:
      `📸 *PAYMENT PROOF SUBMITTED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🧾 *ORDER ID*\n\`${esc(order.id)}\`\n\n` +
      `🎮 *GAME*\n${esc(order.gameName || "Blood Strike")}\n\n` +
      `📦 *PACKAGE*\n${esc(order.productName)}\n\n` +
      `💰 *AMOUNT*\nLKR ${order.price.toLocaleString()}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `⏳ *STATUS*\n${statusBadge("pending_approval")}\n\n` +
      `🔐 Your payment screenshot has been\n` +
      `received successfully.\n\n` +
      `⚡ Please wait while our team verifies\n` +
      `your payment.\n\n` +
      `📩 You will receive a notification\n` +
      `once your order has been reviewed.\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `✨ *HASA GOLD STORE*`,
    extra: {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📦 My Orders", "my_orders"),
        ],
        [
          Markup.button.callback("🏠 Home", "home"),
        ],
      ]),
    },
    frame: 900,
    spinner: "sparkle",
    barStyle: "round",
    emoji: "📸",
    showPercent: true,
    parseMode: "Markdown",
  });

  /*
  |--------------------------------------------------------------------------
  | SEND ORDER TO ADMIN
  |--------------------------------------------------------------------------
  */

  const adminCaption =
    `🔔 NEW PAYMENT TO REVIEW

🧾 Order:
${esc(order.id)}

🎮 Game:
${esc(order.gameName || "Blood Strike")}

📦 Product:
${esc(order.productName)}

🆔 Player ID:
${esc(order.playerId)}

💰 Amount:
LKR ${order.price.toLocaleString()}

👤 Customer:
${order.firstName}

${
  order.username
    ? `📱 Username: @${esc(order.username)}`
    : ""
}

━━━━━━━━━━━━━━

⏳ Status:
PENDING APPROVAL`;

  await bot.telegram.sendPhoto(
    ADMIN_ID,
    largestPhoto.file_id,
    {
      caption: adminCaption,

      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ APPROVE",
              callback_data:
                `approve_${order.id}`,
            },

            {
              text: "❌ REJECT",
              callback_data:
                `reject_${order.id}`,
            },
          ],
        ],
      },
    }
  );
});

/*
|--------------------------------------------------------------------------
| AUTOMATIC TOP-UP
|--------------------------------------------------------------------------
| Fulfilment runs after an order is approved.
|
| The rules exist to protect a paying customer:
|
|   - every transition goes through mutateOrder(), so two approvals at once
|     cannot overwrite each other,
|   - an order is claimed by moving it to topup_processing exactly once, so
|     a double-tapped button cannot send two supplier commands,
|   - a request whose outcome is unknown is NEVER resent, because the first
|     one may already have been delivered,
|   - only an explicitly positive supplier reply counts as delivered;
|     everything else lands in needs_review for a human.
|
| With SUPPLIER_PRODUCTION_MODE=false nothing is sent, so an order settles
| as needs_review rather than being reported as completed.
*/

const TOPUP_MAX_ATTEMPTS = 3;

function isTerminalTopup(order) {
  return (
    order.topupStatus === "topup_completed" ||
    order.topupStatus === "topup_failed"
  );
}

/**
 * Send one order to the supplier and settle the result.
 */
async function processAutoTopup(orderId) {
  // The mutator reports its decision through `claim` while still returning
  // the order itself, so the stored record is never replaced by a wrapper.
  const claim = { action: null };

  const order = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      claim.action = "terminal";
      return current;
    }

    if (
      current.topupStatus === "topup_processing" ||
      current.supplierTransactionId
    ) {
      // The request already went out, so its outcome is unknown. Never
      // resend: hand it to a human.
      claim.action = "in_flight";
      return current;
    }

    const attempts = current.topupAttempts || 0;

    if (attempts >= TOPUP_MAX_ATTEMPTS) {
      current.topupStatus = "topup_failed";
      current.status = "topup_failed";
      current.topupError = "Maximum top-up attempts reached";
      current.topupCompletedAt = new Date().toISOString();
      claim.action = "exhausted";
      return current;
    }

    current.topupStatus = "topup_processing";
    current.topupAttempts = attempts + 1;
    current.topupStartedAt = new Date().toISOString();
    current.topupError = null;
    claim.action = "claimed";

    return current;
  });

  if (!order) {
    console.error(
      `[AUTO-TOPUP] Order ${orderId} not found or not saved`
    );
    return;
  }

  if (claim.action === "terminal") {
    console.log(
      `[AUTO-TOPUP] Order ${orderId} already finished, skipping`
    );
    return;
  }

  if (claim.action === "in_flight") {
    console.log(
      `[AUTO-TOPUP] Order ${orderId} already requested, parking for review`
    );
    await recoverTopupStatus(orderId);
    return;
  }

  if (claim.action === "exhausted") {
    await notifyTopupResult(order, "failed");
    return;
  }

  // The supplier request and the "processing" notice are independent, so
  // they run together instead of making the customer wait out the
  // animation before fulfilment even starts.
  const request = supplierAdapter
    .sendTopup(order)
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );

  await notifyCustomer(order, {
    title: "⚡ TOP-UP PROCESSING",
    body:
      `🚀 Your top-up is now being processed.\n\n` +
      `🎮 ${esc(order.gameName)}\n` +
      `🆔 Player ID: ${esc(order.playerId)}\n` +
      `📦 Product: ${esc(order.productName)}\n\n` +
      `⏳ Please wait while we complete it...\n\n` +
      `Thank you for using ${STORE_NAME}!`,
  });

  const outcome = await request;

  if (!outcome.ok) {
    console.error(
      `[AUTO-TOPUP] Order ${orderId} error:`,
      outcome.error.message
    );

    const parked = await mutateOrder(orderId, (current) => {
      if (isTerminalTopup(current)) {
        return current;
      }

      // The command may still have reached the supplier, so this is
      // deliberately not a failure: a human decides.
      current.topupError = outcome.error.message;
      current.topupStatus = "needs_review";
      current.status = "needs_review";

      return current;
    });

    if (parked) {
      await notifyTopupResult(parked, "pending");
    }

    return;
  }

  const result = outcome.value;

  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    current.supplierTransactionId =
      result.transactionId || current.supplierTransactionId;
    current.supplierMessageId =
      result.messageId || current.supplierMessageId;

    if (result.rawResponse) {
      current.supplierRawReply = result.rawResponse;
    }

    if (result.success) {
      current.topupStatus = "topup_completed";
      current.status = "topup_completed";
      current.topupCompletedAt = new Date().toISOString();
      current.topupError = null;
      return current;
    }

    current.topupError =
      result.statusDetail || result.status || "Unknown error";

    // Processing, an unrecognised reply, or a timeout all mean the outcome
    // is not yet known. Retrying could charge the customer twice, so the
    // order is parked instead.
    if (result.status !== "failed") {
      current.topupStatus = "needs_review";
      current.status = "needs_review";
      return current;
    }

    current.topupStatus = "topup_failed";
    current.status = "topup_failed";
    current.topupCompletedAt = new Date().toISOString();

    return current;
  });

  if (!applied) {
    return;
  }

  await notifyTopupResult(
    applied,
    applied.topupStatus === "topup_completed"
      ? "completed"
      : applied.topupStatus === "topup_failed"
        ? "failed"
        : "pending"
  );
}

/*
|--------------------------------------------------------------------------
| RECOVER TOP-UP STATUS
|--------------------------------------------------------------------------
| Resolves a request that is already with the supplier. It never sends a
| new request, so an uncertain outcome stays uncertain instead of being paid
| for twice.
*/
async function recoverTopupStatus(orderId) {
  const order = getOrders().find(
    (o) => o.id === orderId
  );

  if (!order || isTerminalTopup(order)) {
    return;
  }

  if (
    !order.supplierTransactionId &&
    !order.supplierMessageId
  ) {
    await settleForReview(
      orderId,
      "Supplier request state is unknown"
    );
    return;
  }

  let result;

  try {
    result = await supplierAdapter.checkTopupStatus(order);
  } catch (error) {
    console.error(
      `[RECOVERY] Order ${orderId} lookup failed:`,
      error.message
    );
    return;
  }

  // The supplier has no status command, so this is the expected path.
  if (result.status !== "success" && result.status !== "failed") {
    await settleForReview(orderId, null);
    return;
  }

  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    if (result.status === "success") {
      current.topupStatus = "topup_completed";
      current.status = "topup_completed";
      current.topupCompletedAt = new Date().toISOString();
      current.topupError = null;
      return current;
    }

    current.topupStatus = "topup_failed";
    current.status = "topup_failed";
    current.topupError =
      result.statusDetail || "Supplier reported failure";
    current.topupCompletedAt = new Date().toISOString();

    return current;
  });

  if (!applied) {
    return;
  }

  await notifyTopupResult(
    applied,
    applied.topupStatus === "topup_completed"
      ? "completed"
      : "failed"
  );
}

/*
|--------------------------------------------------------------------------
| SETTLE FOR REVIEW
|--------------------------------------------------------------------------
| Parks an order whose supplier outcome cannot be determined.
*/
async function settleForReview(orderId, reason) {
  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    current.topupStatus = "needs_review";
    current.status = "needs_review";
    current.topupError = reason;

    return current;
  });

  if (applied) {
    await notifyTopupResult(applied, "pending");
  }
}

/*
|--------------------------------------------------------------------------
| TOP-UP RESULT NOTIFICATION
|--------------------------------------------------------------------------
| Tells the customer where the order stands. "pending" keeps the order open
| for manual review instead of claiming a failure we cannot prove.
*/
async function notifyTopupResult(order, resultType) {
  if (resultType === "completed") {
    await notifyCustomer(order, {
      title: "🎉 TOP-UP COMPLETED!",
      body:
        `✅ Your top-up has been delivered.\n\n` +
        `🎮 ${esc(order.gameName)}\n` +
        `🆔 Player ID: ${esc(order.playerId)}\n` +
        `📦 Product: ${esc(order.productName)}\n\n` +
        `Thank you for using ${STORE_NAME}!`,
    });

    return;
  }

  if (resultType === "failed") {
    await notifyCustomer(order, {
      title: "❌ TOP-UP FAILED",
      body:
        `⚠️ We could not complete your top-up.\n\n` +
        `🆔 Player ID: ${esc(order.playerId)}\n` +
        `📦 Product: ${esc(order.productName)}\n\n` +
        (order.topupError
          ? `Reason: ${esc(order.topupError)}\n\n`
          : "") +
        `👨‍💻 Our support team will look into this and\n` +
        `get back to you shortly.\n\n` +
        `Thank you for using ${STORE_NAME}!`,
    });

    return;
  }

  await notifyCustomer(order, {
    title: "⏳ TOP-UP UNDER REVIEW",
    body:
      `Your order is confirmed and our team is\n` +
      `completing it now.\n\n` +
      `🎮 ${esc(order.gameName)}\n` +
      `🆔 Player ID: ${esc(order.playerId)}\n` +
      `📦 Product: ${esc(order.productName)}\n\n` +
      `⏳ We will update you as soon as it is done.\n\n` +
      `Thank you for using ${STORE_NAME}!`,
  });
}

/*
|--------------------------------------------------------------------------
| STARTUP RECOVERY
|--------------------------------------------------------------------------
| Orders that were mid-flight when the process stopped are parked for a
| human, never resent.
*/
async function runStartupRecovery() {
  console.log("[STARTUP] Checking for unfinished top-ups...");

  const pending = getOrders().filter(
    (order) =>
      order.topupStatus === "topup_processing" ||
      order.topupStatus === "ready_for_topup" ||
      order.status === "needs_review"
  );

  if (pending.length === 0) {
    console.log("[STARTUP] Nothing to recover");
    return;
  }

  console.log(
    `[STARTUP] ${pending.length} order(s) need attention`
  );

  for (const order of pending) {
    if (
      order.supplierTransactionId ||
      order.supplierMessageId
    ) {
      await recoverTopupStatus(order.id);
      continue;
    }

    console.warn(
      `[STARTUP] Order ${order.id}: supplier state unknown`
    );

    await mutateOrder(order.id, (current) => {
      if (isTerminalTopup(current)) {
        return current;
      }

      current.topupStatus = "needs_review";
      current.status = "needs_review";
      current.topupError =
        "Interrupted before the supplier request was confirmed";

      return current;
    });
  }

  await notifyAdminOfReview();
}

/*
|--------------------------------------------------------------------------
| ADMIN REVIEW NOTICE
|--------------------------------------------------------------------------
| Lists the orders automation could not settle.
*/
async function notifyAdminOfReview() {
  const reviewing = reviewingOrders();

  if (reviewing.length === 0) {
    return;
  }

  const lines = reviewing
    .slice(0, 10)
    .map(
      (order) =>
        `🧾 ${esc(order.id)}\n` +
        `   ${esc(order.productName)}\n` +
        `   ${esc(order.topupError || "no supplier reply")}`
    )
    .join("\n\n");

  try {
    await bot.telegram.sendMessage(
      ADMIN_ID,
      `🕵️ *TOP-UP NEEDS REVIEW*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${reviewing.length} order(s) could not be confirmed\n` +
        `automatically:\n\n${lines}\n\n` +
        `Use /review to resolve them.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🕵️  OPEN REVIEW QUEUE",
              "review_queue"
            ),
          ],
        ]),
      }
    );
  } catch (error) {
    console.error(
      "[STARTUP] Could not send the review notice:",
      error.message
    );
  }
}

/**
 * Orders waiting for a human decision.
 */
function reviewingOrders() {
  return getOrders().filter(
    (order) => order.status === "needs_review"
  );
}

/*
|--------------------------------------------------------------------------
| APPROVE ORDER
|--------------------------------------------------------------------------
*/

bot.action(/^approve_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply(
      "⛔ You are not authorized to approve orders."
    );
  }

const orderId = ctx.match[1];

  // Approve and hand over to fulfilment in one atomic step, so a
  // double-tapped button cannot start two top-ups.
  const decision = { action: null };

  const approved = await mutateOrder(
    orderId,
    (current) => {
      if (current.status !== "pending_approval") {
        decision.action = "handled";
        return current;
      }

      current.status = "approved";
      current.approvedAt = new Date().toISOString();
      current.topupStatus = "ready_for_topup";
      current.topupAttempts = 0;
      current.supplierTransactionId = null;
      current.supplierMessageId = null;
      current.topupStartedAt = null;
      current.topupCompletedAt = null;
      current.topupError = null;
      current.supplierRawReply = null;
      decision.action = "approved";

      return current;
    },
    decision
  );

  if (!approved) {
    return ctx.reply(
      "❌ Order could not be saved, so nothing was approved."
    );
  }

  if (decision.action === "handled") {
    return ctx.reply(
      `⚠️ This order has already been processed.

Status: ${statusBadge(approved.status)}`
    );
  }

  // Only Free Fire weekly has a confirmed supplier name. Anything else is
  // handled by a person, so the customer is not told a top-up is running.
  const automated = supplierAdapter.canFulfill(approved);

  if (!automated) {
    await settleForReview(
      orderId,
      "No confirmed supplier product for this package"
    );
  }

  // Edit the admin's message in place.
  await editOrderNotice(
    ctx,
    `✅ ORDER APPROVED

🧾 Order:
${esc(approved.id)}

🎮 ${esc(approved.gameName)}

📦 Product:
${esc(approved.productName)}

🆔 Player ID:
${esc(approved.playerId)}

💰 Amount:
LKR ${approved.price.toLocaleString()}

👤 Customer:
${esc(approved.firstName)}

━━━━━━━━━━━━━━━━━━

Status:
${automated ? "⚡ APPROVED - Top-up starting" : "🕵️ APPROVED - Needs manual review"}`
  );

  // Customer gets a staged notification.
  await notifyCustomer(approved, {
    title: "🎉 PAYMENT APPROVED!",
    body: automated
      ? `✅ Your payment has been approved.\n\n` +
        `🚀 Your top-up is now being processed.\n\n` +
        `Thank you for using ${STORE_NAME}!`
      : `✅ Your payment has been approved.\n\n` +
        `👨‍💻 Our team is completing your order now.\n\n` +
        `We will notify you the moment it is done.\n\n` +
        `Thank you for using ${STORE_NAME}!`,
  });

  if (automated) {
    // Fulfilment runs in the background so the admin is not held waiting.
    setImmediate(() => processAutoTopup(orderId));
  }
});

/*
|--------------------------------------------------------------------------
| REJECT ORDER
|--------------------------------------------------------------------------
*/

bot.action(/^reject_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply(
      "⛔ You are not authorized to reject orders."
    );
  }

  const orderId = ctx.match[1];

  const orders = getOrders();

  const order = orders.find(
    (o) => o.id === orderId
  );

  if (!order) {
    return ctx.reply(
      "❌ Order not found."
    );
  }

  if (order.status !== "pending_approval") {
    return ctx.reply(
      `⚠️ This order has already been processed.

Status: ${statusBadge(order.status)}`
    );
  }

  const rejectedAt = new Date().toISOString();

  const rejected = await mutateOrder(order.id, (current) => {
    if (current.status !== "pending_approval") {
      return false;
    }

    current.status = "rejected";
    current.rejectedAt = rejectedAt;

    return current;
  });

  if (!rejected) {
    return ctx.reply(
      "❌ This order could not be updated."
    );
  }

  await editOrderNotice(
    ctx,
    `❌ ORDER REJECTED

🧾 Order:
${esc(order.id)}

🎮 ${esc(order.gameName || "Blood Strike")}

📦 Product:
${esc(order.productName)}

🆔 Player ID:
${esc(order.playerId)}

💰 Amount:
LKR ${order.price.toLocaleString()}

👤 Customer:
${order.firstName}

━━━━━━━━━━━━━━

Status:
❌ REJECTED`
  );

  await notifyCustomer(order, {
    title: "❌ PAYMENT REJECTED",
    body:
      `Your payment proof was not approved.\n\n` +
      `If you believe this was a mistake, please contact ${STORE_NAME}.`,
  });
});

/*
|--------------------------------------------------------------------------
| MY ORDERS
|--------------------------------------------------------------------------
*/
/*
|--------------------------------------------------------------------------
| MY ORDERS
|--------------------------------------------------------------------------
*/
async function sendMyOrders(ctx, isEdit) {
  const orders = getOrders().filter(
    (order) => order.userId === ctx.from.id
  );

  const send = isEdit
    ? ctx.editMessageText.bind(ctx)
    : ctx.reply.bind(ctx);

  if (orders.length === 0) {
    return send(UI.noOrders, {
      parse_mode: "Markdown",
      ...ordersMenu(false),
    });
  }

  let message =
    `📦 *MY ORDERS*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  orders
    .slice()
    .reverse()
    .slice(0, 10)
    .forEach((order) => {
      message +=
        `🧾 *${esc(order.id)}*\n` +
        `📦 ${esc(order.productName)}\n` +
        `🆔 Player ID: \`${esc(order.playerId)}\`\n` +
        `💰 LKR ${Number(order.price).toLocaleString()}\n` +
        `${statusBadge(order.status)}\n\n`;
    });

  return send(message, {
    parse_mode: "Markdown",
    ...ordersMenu(true),
  });
}

bot.action("my_orders", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  await sendMyOrders(ctx, true);
});

/*
|--------------------------------------------------------------------------
| ADMIN COMMAND
|--------------------------------------------------------------------------
*/
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const text =
    `👑 *${STORE_NAME}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🛠️ *ADMIN PANEL*\n\n` +
    `👇 Select an option below:`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...adminMenu(),
  });
});

bot.command("review", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  await ctx.reply(reviewQueueText(), {
    parse_mode: "Markdown",
    ...reviewMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| REVIEW QUEUE
|--------------------------------------------------------------------------
| Every order automation could not settle with certainty. The customer is
| told the order is being completed by the team; a human confirms the
| outcome here.
*/
function reviewQueueText() {
  const reviewing = reviewingOrders();

  if (reviewing.length === 0) {
    return (
      `🕵️ *REVIEW QUEUE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Nothing is waiting for review.\n\n` +
      `Every top-up was settled automatically.`
    );
  }

  let text =
    `🕵️ *REVIEW QUEUE*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ ${reviewing.length} order(s) need a decision:\n\n`;

  for (const order of reviewing.slice(0, 10)) {
    text +=
      `🧾 ${esc(order.id)}\n` +
      `🎮 ${esc(order.gameName)}\n` +
      `📦 ${esc(order.productName)}\n` +
      `🆔 \`${esc(order.playerId)}\`\n` +
      `💬 ${esc(order.topupError || "no supplier reply")}\n\n`;
  }

  if (reviewing.length > 10) {
    text += `…and ${reviewing.length - 10} more.\n\n`;
  }

  text += `👇 Open an order to resolve it:`;

  return text;
}

function reviewMenu() {
  const reviewing = reviewingOrders().slice(0, 10);

  const buttons = reviewing.map((order) => [
    Markup.button.callback(
      `🧾 ${order.id}`,
      `review_order_${order.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback("👑  ADMIN PANEL", "admin_home"),
  ]);

  return Markup.inlineKeyboard(buttons);
}

function reviewOrderScreen(order) {
  const attempts = order.topupAttempts || 0;
  const automated = supplierAdapter.canFulfill(order);

  return (
    `🕵️ *REVIEW ORDER*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 Order:\n\`${esc(order.id)}\`\n\n` +
    `🎮 ${esc(order.gameName)}\n\n` +
    `📦 Product:\n${esc(order.productName)}\n\n` +
    `🆔 Player ID:\n\`${esc(order.playerId)}\`\n\n` +
    `💰 Amount:\nLKR ${esc(order.price)}\n\n` +
    `👤 Customer:\n${esc(order.firstName)} (@${esc(order.username || "unknown")})\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🤖 *AUTOMATION*\n\n` +
    `📤 Attempts: ${attempts} of ${TOPUP_MAX_ATTEMPTS}\n` +
    `📦 Automated: ${automated ? "yes" : "no (no confirmed supplier name)"}\n` +
    (order.supplierTransactionId
      ? `🔖 Transaction:\n\`${esc(order.supplierTransactionId)}\`\n`
      : "") +
    (order.supplierRawReply
      ? `💬 Supplier replied:\n\`${esc(
          order.supplierRawReply.slice(0, 120)
        )}\`\n`
      : "") +
    `⚠️ Reason:\n${esc(order.topupError || "not recorded")}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👇 Check with the supplier first, then pick an outcome.`
  );
}

function reviewOrderMenu(order, { canRetry } = { canRetry: false }) {
  const buttons = [];

  if (order.paymentProof) {
    buttons.push([
      Markup.button.callback(
        `🖼  VIEW PROOF`,
        `review_proof_${order.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      `✅  MARK DELIVERED`,
      `review_done_${order.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback(
      `❌  MARK FAILED`,
      `review_fail_${order.id}`
    ),
  ]);

  // A retry can send a second supplier command, so it is only offered
  // while attempts remain and the admin has confirmed the earlier attempt
  // never reached the supplier.
  if (canRetry) {
    buttons.push([
      Markup.button.callback(
        `🔄  RETRY TOP-UP`,
        `review_retry_${order.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("🕵️  REVIEW QUEUE", "review_queue"),
  ]);

  return Markup.inlineKeyboard(buttons);
}

function canRetryTopup(order) {
  if (order.status !== "needs_review") {
    return false;
  }

  return (order.topupAttempts || 0) < TOPUP_MAX_ATTEMPTS;
}

/*
|--------------------------------------------------------------------------
| OPEN A REVIEW ORDER
|--------------------------------------------------------------------------
*/
bot.action(/^review_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const order = getOrders().find(
    (o) => o.id === ctx.match[1]
  );

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  await ctx.editMessageText(reviewOrderScreen(order), {
    parse_mode: "Markdown",
    ...reviewOrderMenu(order, {
      canRetry: canRetryTopup(order),
    }),
  });
});

bot.action("review_queue", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  await ctx.editMessageText(reviewQueueText(), {
    parse_mode: "Markdown",
    ...reviewMenu(),
  });
});

bot.action(/^review_proof_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const order = getOrders().find(
    (o) => o.id === ctx.match[1]
  );

  if (!order?.paymentProof) {
    return ctx.reply("❌ No payment proof for this order.");
  }

  return ctx.replyWithPhoto(order.paymentProof, {
    caption:
      `🧾 ${esc(order.id)}\n` +
      `📦 ${esc(order.productName)}\n` +
      `🆔 \`${esc(order.playerId)}\`\n` +
      `💰 LKR ${esc(order.price)}`,
  });
});

/*
|--------------------------------------------------------------------------
| MARK DELIVERED
|--------------------------------------------------------------------------
*/
bot.action(/^review_done_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orderId = ctx.match[1];

  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    current.topupStatus = "topup_completed";
    current.status = "topup_completed";
    current.topupCompletedAt = new Date().toISOString();
    current.topupError = null;
    current.resolvedBy = "admin_marked_delivered";
    current.resolvedAt = new Date().toISOString();

    return current;
  });

  if (!applied) {
    return ctx.reply("❌ Order could not be updated.");
  }

  await notifyTopupResult(applied, "completed");

  await ctx.editMessageText(
    `✅ *MARKED DELIVERED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🧾 \`${esc(applied.id)}\`\n\n` +
      `The customer has been told their top-up\n` +
      `is complete.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🕵️  REVIEW QUEUE", "review_queue")],
      ]),
    }
  );
});

/*
|--------------------------------------------------------------------------
| MARK FAILED
|--------------------------------------------------------------------------
*/
bot.action(/^review_fail_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orderId = ctx.match[1];

  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    current.topupStatus = "topup_failed";
    current.status = "topup_failed";
    current.topupCompletedAt = new Date().toISOString();
    current.topupError = "Confirmed unsuccessful by admin";
    current.resolvedBy = "admin_marked_failed";
    current.resolvedAt = new Date().toISOString();

    return current;
  });

  if (!applied) {
    return ctx.reply("❌ Order could not be updated.");
  }

  await notifyTopupResult(applied, "failed");

  await ctx.editMessageText(
    `❌ *MARKED FAILED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🧾 \`${esc(applied.id)}\`\n\n` +
      `The customer has been asked to contact support\n` +
      `for a refund.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🕵️  REVIEW QUEUE", "review_queue")],
      ]),
    }
  );
});

/*
|--------------------------------------------------------------------------
| RETRY TOP-UP
|--------------------------------------------------------------------------
| Sends a second supplier command, so it is only offered while attempts
| remain. The admin must confirm with the supplier first: if the earlier
| command did go through, retrying delivers twice.
*/
bot.action(/^review_retry_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orderId = ctx.match[1];

  const order = getOrders().find((o) => o.id === orderId);

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  if (!canRetryTopup(order)) {
    return ctx.reply(
      `⚠️ This order cannot be retried.

Status: ${statusBadge(order.status)}
Attempts: ${order.topupAttempts || 0} of ${TOPUP_MAX_ATTEMPTS}`
    );
  }

  if (!supplierAdapter.canFulfill(order)) {
    return ctx.reply(
      `⚠️ No confirmed supplier product name for this\n` +
        `package, so it cannot be sent automatically.\n\n` +
        `Complete or fail it by hand.`
    );
  }

  await ctx.answerCbQuery().catch(() => {});

  // Clear the parked state so processAutoTopup will claim the order again.
  const prepared = await mutateOrder(orderId, (current) => {
    if (current.status !== "needs_review") {
      return false;
    }

    current.topupStatus = "ready_for_topup";
    current.supplierTransactionId = null;
    current.supplierMessageId = null;

    return current;
  });

  if (!prepared) {
    return ctx.reply(
      "⚠️ This order is no longer waiting for review."
    );
  }

  await ctx.editMessageText(
    `🔄 *RETRYING*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🧾 \`${esc(orderId)}\`\n\n` +
      `Attempt ${(prepared.topupAttempts || 0) + 1} of ` +
      `${TOPUP_MAX_ATTEMPTS} is starting.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🕵️  REVIEW QUEUE", "review_queue")],
      ]),
    }
  );

  setImmediate(() => processAutoTopup(orderId));
});

/*
|--------------------------------------------------------------------------
| ADMIN PANEL
|--------------------------------------------------------------------------
*/
function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔍  PENDING ORDERS",
        "admin_pending"
      ),
    ],
    [
      Markup.button.callback(
        "🕵️  REVIEW QUEUE",
        "review_queue"
      ),
    ],
    [
      Markup.button.callback(
        "👥  CUSTOMERS",
        "admin_users"
      ),
    ],
    [
      Markup.button.callback(
        "📦  ALL ORDERS",
        "admin_all_orders"
      ),
    ],
    [
      Markup.button.callback(
        "📊  SALES STATISTICS",
        "admin_stats"
      ),
    ],
    [
      Markup.button.callback(
        "🛠️  MANAGE STORE",
        "store_home"
      ),
    ],
  ]);
}

/*
|--------------------------------------------------------------------------
| STORE MANAGEMENT
|--------------------------------------------------------------------------
*/
function storeHomeMenu() {
  const games = catalog.getGames();
  const payments = catalog.getPayments();

  const activeGames = catalog.activeGames().length;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `🕹️  GAMES (${activeGames}/${games.length})`,
        "store_games"
      ),
    ],
    [
      Markup.button.callback(
        `💳  PAYMENT METHODS (${payments.filter((p) => !p.paused).length}/${payments.length})`,
        "store_payments"
      ),
    ],
    [
      Markup.button.callback(
        "🔙  ADMIN PANEL",
        "admin_home"
      ),
    ],
  ]);
}

function storeHomeText() {
  const games = catalog.getGames();
  const payments = catalog.getPayments();

  const activeGames = catalog.activeGames();

  const gamesLine = games.length
    ? games
        .map(
          (g) =>
            `${g.paused ? "⏸" : "🟢"} ${g.emoji} *${g.name}*  (${g.packages.filter((p) => !p.paused).length}/${g.packages.length} pkgs)`
        )
        .join("\n")
    : "_No games yet_";

  const paymentsLine = payments.length
    ? payments
        .map((p) => `${p.paused ? "⏸" : "🟢"} ${p.emoji} *${p.title}*`)
        .join("\n")
    : "_No payment methods yet_";

  return (
    `🛠️ *STORE MANAGEMENT*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🕹️ *Games* (${activeGames.length} live)\n${gamesLine}\n\n` +
    `💳 *Payment Methods* (${payments.filter((p) => !p.paused).length} live)\n${paymentsLine}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `⏸ Paused items are hidden from customers.`
  );
}

bot.action("store_home", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const text = storeHomeText();

  if (ctx.callbackQuery?.message?.text === text) {
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...storeHomeMenu(),
    });
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...storeHomeMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| GAMES MANAGEMENT LIST
|--------------------------------------------------------------------------
*/
function gamesAdminText() {
  const games = catalog.getGames();

  const lines = games.map(
    (g) =>
      `${g.paused ? "⏸" : "🟢"} ${g.emoji} *${g.name}*  (${g.packages.filter((p) => !p.paused).length}/${g.packages.length} pkgs)`
  );

  return (
    `🕹️ *MANAGE GAMES*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    (lines.length ? lines.join("\n") : "_No games yet_") +
    `\n\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 Active  •  ⏸ Paused`
  );
}

function gamesAdminMenu() {
  const rows = catalog.getGames().map((g) => [
    Markup.button.callback(
      `${g.paused ? "⏸" : "🟢"} ${g.emoji}  ${g.name}`,
      `sag_${g.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "➕  ADD NEW GAME",
      "sag_new"
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🔙  STORE MANAGEMENT",
      "store_home"
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

bot.action("store_games", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const text = gamesAdminText();

  if (ctx.callbackQuery?.message?.text === text) {
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...gamesAdminMenu(),
    });
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...gamesAdminMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| PACKAGES LIST FOR A GAME
|--------------------------------------------------------------------------
*/
function packagesAdminText(game) {
  const lines = game.packages.map(
    (p) =>
      `${p.paused ? "⏸" : "🟢"} ${esc(p.name)}  •  LKR ${catalog.formatPrice(p.price)}`
  );

  return (
    `${game.emoji} *${game.name.toUpperCase()}*\n` +
    `📦 *PACKAGES*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    (lines.length ? lines.join("\n") : "_No packages yet_")
  );
}

function packagesAdminMenu(game) {
  const rows = game.packages.map((p) => [
    Markup.button.callback(
      `${p.paused ? "⏸" : "🟢"} ${p.name}  •  ${catalog.formatPrice(p.price)}`,
      `sap_${game.id}~${p.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "➕  ADD PACKAGE",
      `sapn_${game.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      `🔙  ${game.emoji}  ${game.name}`,
      `sag_${game.id}`
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

/*
|--------------------------------------------------------------------------
| PAYMENT METHODS LIST
|--------------------------------------------------------------------------
*/
function paymentsAdminText() {
  const payments = catalog.getPayments();

  const lines = payments.map(
    (p) => `${p.paused ? "⏸" : "🟢"} ${p.emoji} *${p.title}*`
  );

  return (
    `💳 *PAYMENT METHODS*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    (lines.length ? lines.join("\n") : "_No payment methods yet_") +
    `\n\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 Active  •  ⏸ Paused\n\n` +
    `⚠️ Paused methods are hidden from\n` +
    `customers' payment instructions.`
  );
}

function paymentsAdminMenu() {
  const rows = catalog.getPayments().map((p) => [
    Markup.button.callback(
      `${p.paused ? "⏸" : "🟢"} ${p.emoji}  ${p.title}`,
      `sapay_${p.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "➕  ADD PAYMENT METHOD",
      "sapay_new"
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🔙  STORE MANAGEMENT",
      "store_home"
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

bot.action("store_payments", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const text = paymentsAdminText();

  if (ctx.callbackQuery?.message?.text === text) {
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...paymentsAdminMenu(),
    });
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...paymentsAdminMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| SINGLE PAYMENT METHOD
|--------------------------------------------------------------------------
*/
function paymentAdminText(payment) {
  const lines = payment.lines.length
    ? payment.lines.map((l) => `\`${esc(l)}\``).join("\n")
    : "_No details set_";

  return (
    `${payment.emoji} *${payment.title.toUpperCase()}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${payment.paused ? "⏸ PAUSED" : "🟢 ACTIVE"}\n\n` +
    `📝 *Details*\n${lines}`
  );
}

function paymentAdminMenu(payment) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        payment.paused ? "▶️  ENABLE" : "⏸  DISABLE",
        `sapayt_${payment.id}`
      ),
    ],
    [
      Markup.button.callback(
        "✏️  EDIT DETAILS",
        `sapaye_${payment.id}`
      ),
      Markup.button.callback(
        "🏷  RENAME",
        `sapayr_${payment.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🗑  DELETE",
        `sapayd_${payment.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🔙  PAYMENT METHODS",
        "store_payments"
      ),
    ],
  ]);
}

bot.action(/^sapay_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  if (ctx.match[1] === "new") {
    ensureSession(ctx).adminFlow = { step: "payment_title" };

    return ctx.reply(
      `➕ *ADD PAYMENT METHOD*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Send the *title* of the payment method.\n\n` +
        `Example: \`Bank Transfer\``,
      {
        parse_mode: "Markdown",
        ...cancelFlowButton(),
      }
    );
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  await ctx.reply(paymentAdminText(payment), {
    parse_mode: "Markdown",
    ...paymentAdminMenu(payment),
  });
});

bot.action(/^sapayt_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.togglePayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  await ctx.editMessageText(paymentAdminText(payment), {
    parse_mode: "Markdown",
    ...paymentAdminMenu(payment),
  });
});

bot.action(/^sapayd_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  await ctx.reply(
    `⚠️ *DELETE PAYMENT METHOD*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Delete *${esc(payment.title)}*?\n\n` +
      `⚠️ This cannot be undone.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅  YES, DELETE",
            `sapaydc_${payment.id}`
          ),
          Markup.button.callback(
            "↩️  KEEP IT",
            `sapay_${payment.id}`
          ),
        ],
      ]),
    }
  );
});

bot.action(/^sapaydc_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  catalog.deletePayment(payment.id);

  await ctx.editMessageText(
    `🗑 *PAYMENT METHOD DELETED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `*${esc(payment.title)}* has been removed.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙  PAYMENT METHODS",
            "store_payments"
          ),
        ],
      ]),
    }
  );
});

bot.action(/^sapaye_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  ensureSession(ctx).adminFlow = {
    step: "payment_lines",
    paymentId: payment.id,
    buffer: [],
  };

  await ctx.reply(
    `✏️ *EDIT DETAILS*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Send each detail line for\n` +
      `*${esc(payment.title)}*.\n\n` +
      `Example:\n` +
      `\`🏦 Bank: Commercial Bank\`\n` +
      `\`🔢 Account: 12345678\`\n\n` +
      `Send *DONE* when finished.`,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});

bot.action(/^sapayr_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  ensureSession(ctx).adminFlow = {
    step: "payment_rename",
    paymentId: payment.id,
  };

  await ctx.reply(
    `🏷 *RENAME PAYMENT METHOD*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Send the new title for\n` +
      `*${esc(payment.title)}*.`,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});


bot.action(/^sagl_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  await ctx.reply(packagesAdminText(game), {
    parse_mode: "Markdown",
    ...packagesAdminMenu(game),
  });
});

/*
|--------------------------------------------------------------------------
| SINGLE PACKAGE MANAGEMENT
|--------------------------------------------------------------------------
*/
function packageAdminText(game, pkg) {
  const live = game.packages.filter((p) => !p.paused).length;

  return (
    `📦 *PACKAGE DETAILS*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 Game: ${game.emoji} ${esc(game.name)}\n\n` +
    `🏷 Name: ${esc(pkg.name)}\n\n` +
    `💰 Price: LKR ${catalog.formatPrice(pkg.price)}\n\n` +
    `📌 Status: ${pkg.paused ? "⏸ Paused" : "🟢 Active"}\n\n` +
    `📊 Live packages: ${live}/${game.packages.length}`
  );
}

function packageAdminMenu(game, pkg) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        pkg.paused ? "▶️  RESUME" : "⏸  PAUSE",
        `sapt_${game.id}~${pkg.id}`
      ),
    ],
    [
      Markup.button.callback(
        "💰  UPDATE PRICE",
        `sape_price_${game.id}~${pkg.id}`
      ),
    ],
    [
      Markup.button.callback(
        "✏️  RENAME",
        `sape_name_${game.id}~${pkg.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🗑  DELETE PACKAGE",
        `sapd_${game.id}~${pkg.id}`
      ),
    ],
    [
      Markup.button.callback(
        `🔙  ${game.emoji}  ${game.name}`,
        `sag_${game.id}`
      ),
    ],
  ]);
}

bot.action(/^sap_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  const { game, pkg } = found;

  await ctx.reply(packageAdminText(game, pkg), {
    parse_mode: "Markdown",
    ...packageAdminMenu(game, pkg),
  });
});

bot.action(/^sapt_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const gameId = ctx.match[1];
  const pkg = catalog.togglePackage(gameId, ctx.match[2]);

  if (!pkg) {
    return ctx.reply("❌ Package not found.");
  }

  const game = getGame(gameId);

  await ctx.editMessageText(packageAdminText(game, pkg), {
    parse_mode: "Markdown",
    ...packageAdminMenu(game, pkg),
  });
});

bot.action(/^sapd_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  const { game, pkg } = found;

  await ctx.reply(
    `⚠️ *DELETE PACKAGE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Delete *${esc(pkg.name)}* from\n` +
      `*${esc(game.name)}*?\n\n` +
      `⚠️ This cannot be undone.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅  YES, DELETE",
            `sapdc_${game.id}~${pkg.id}`
          ),
          Markup.button.callback(
            "↩️  KEEP IT",
            `sap_${game.id}~${pkg.id}`
          ),
        ],
      ]),
    }
  );
});

bot.action(/^sapdc_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const gameId = ctx.match[1];
  const packageId = ctx.match[2];

  const found = catalog.findPackage(gameId, packageId);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  const { game, pkg } = found;

  catalog.deletePackage(gameId, packageId);

  await ctx.editMessageText(
    `🗑 *PACKAGE DELETED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `*${esc(pkg.name)}* has been removed\n` +
      `from *${esc(game.name)}*.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📋  PACKAGES",
            `sagl_${gameId}`
          ),
        ],
        [
          Markup.button.callback(
            `🔙  ${game.emoji}  ${game.name}`,
            `sag_${gameId}`
          ),
        ],
      ]),
    }
  );
});

/*
|--------------------------------------------------------------------------
| SINGLE GAME MANAGEMENT
|--------------------------------------------------------------------------
*/
function gameAdminText(game) {
  const pkgs = game.packages;

  const pkgLines = pkgs.length
    ? pkgs
        .map(
          (p) =>
            `${p.paused ? "⏸" : "🟢"} ${esc(p.name)}  •  LKR ${catalog.formatPrice(p.price)}`
        )
        .join("\n")
    : "_No packages yet_";

  return (
    `${game.emoji} *${game.name.toUpperCase()}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${game.paused ? "⏸ PAUSED" : "🟢 ACTIVE"}\n\n` +
    `📦 *Packages* (${pkgs.filter((p) => !p.paused).length}/${pkgs.length} live)\n${pkgLines}\n\n` +
    `━━━━━━━━━━━━━━━━━━`
  );
}

function gameAdminMenu(game) {
  const rows = [
    [
      Markup.button.callback(
        game.paused ? "▶️  RESUME GAME" : "⏸  PAUSE GAME",
        `sagt_${game.id}`
      ),
    ],
    [
      Markup.button.callback(
        "➕  ADD PACKAGE",
        `sagp_new_${game.id}`
      ),
      Markup.button.callback(
        "✏️  EDIT GAME",
        `sage_${game.id}`
      ),
    ],
  ];

  if (game.packages.length) {
    rows.push([
      Markup.button.callback(
        "📋  MANAGE PACKAGES",
        `sagl_${game.id}`
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "🗑  DELETE GAME",
      `sagd_${game.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "🔙  GAMES LIST",
      "store_games"
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

bot.action("sag_new", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  ensureSession(ctx).adminFlow = { step: "game_name" };

  await ctx.reply(
    `➕ *ADD NEW GAME*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Send the *name* of the new game.\n\n` +
      `Example: \`PUBG Mobile\``,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});

bot.action(/^sag_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found. It may have been deleted.");
  }

  const text = gameAdminText(game);

  if (ctx.callbackQuery?.message?.text === text) {
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...gameAdminMenu(game),
    });
  }

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...gameAdminMenu(game),
  });
});

/*
|--------------------------------------------------------------------------
| TOGGLE GAME PAUSE
|--------------------------------------------------------------------------
*/
bot.action(/^sagt_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = catalog.toggleGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  await ctx.editMessageText(gameAdminText(game), {
    parse_mode: "Markdown",
    ...gameAdminMenu(game),
  });
});

/*
|--------------------------------------------------------------------------
| DELETE GAME
|--------------------------------------------------------------------------
*/
bot.action(/^sagd_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ensureSession(ctx).pendingDelete = { type: "game", id: game.id };

  await ctx.reply(
    `⚠️ *DELETE GAME*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Are you sure you want to delete\n` +
      `*${esc(game.name)}* and its ${game.packages.length} package(s)?\n\n` +
      `⚠️ This cannot be undone.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅  YES, DELETE",
            `sagdc_${game.id}`
          ),
          Markup.button.callback(
            "↩️  KEEP IT",
            `sag_${game.id}`
          ),
        ],
      ]),
    }
  );
});

bot.action(/^sagdc_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  catalog.deleteGame(game.id);

  await ctx.editMessageText(
    `🗑 *GAME DELETED*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `*${esc(game.name)}* and its packages\n` +
      `have been removed from the store.`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙  GAMES LIST",
            "store_games"
          ),
        ],
      ]),
    }
  );
});



/*
|--------------------------------------------------------------------------
| PENDING ORDERS
|--------------------------------------------------------------------------
*/

bot.action("admin_pending", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();

  const pending = orders
    .filter((o) => o.status === "pending_approval")
    .slice()
    .reverse();

  if (pending.length === 0) {
    return ctx.editMessageText(
      `🔍 *PENDING ORDERS*

━━━━━━━━━━━━━━━━━━

✅ There are no orders waiting
for approval.`,
      { parse_mode: "Markdown", ...adminMenu() }
    );
  }

  let message =
    `🔍 *PENDING ORDERS*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  for (const order of pending.slice(0, 10)) {
    message +=
      `🧾 ${esc(order.id)}\n` +
      `📦 ${esc(order.productName)}\n` +
      `🆔 \`${esc(order.playerId)}\`\n` +
      `💰 LKR ${order.price.toLocaleString()}\n\n`;
  }

  const buttons = pending
    .slice(0, 10)
    .map((order) => [
      Markup.button.callback(
        `👁️  ${order.id}`,
        `admin_order_${order.id}`
      ),
    ]);

  buttons.push([
    Markup.button.callback(
      "🔙  ADMIN PANEL",
      "admin_home"
    ),
  ]);

  await ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});


/*
|--------------------------------------------------------------------------
| VIEW ORDER
|--------------------------------------------------------------------------
*/

bot.action(/^admin_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orderId = ctx.match[1];

  const orders = getOrders();

  const order = orders.find(
    (o) => o.id === orderId
  );

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  const customer = order.username
    ? `@${esc(order.username)}`
    : order.firstName || "Unknown";

  const message =
    `🧾 *ORDER DETAILS*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 Order ID: \`${order.id}\`\n` +
    `🎮 Game: ${esc(order.gameName || "Blood Strike")}\n` +
    `📦 Product: ${order.productName}\n` +
    `🆔 Player ID: \`${order.playerId}\`\n` +
    `💰 Amount: LKR ${order.price.toLocaleString()}\n` +
    `👤 Customer: ${customer}\n\n` +
    `${statusBadge(order.status)}`;

  const buttons = [];

  if (order.status === "pending_approval") {
    buttons.push([
      Markup.button.callback(
        "📸  VIEW PAYMENT PROOF",
        `admin_proof_${order.id}`
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        "✅  APPROVE",
        `approve_${order.id}`
      ),
      Markup.button.callback(
        "❌  REJECT",
        `reject_${order.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "🔙  PENDING ORDERS",
      "admin_pending"
    ),
  ]);

  await ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});


/*
|--------------------------------------------------------------------------
| VIEW PAYMENT PROOF
|--------------------------------------------------------------------------
*/

bot.action(/^admin_proof_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orderId = ctx.match[1];

  const orders = getOrders();

  const order = orders.find(
    (o) => o.id === orderId
  );

  if (!order) {
    return ctx.reply("❌ Order not found.");
  }

  if (!order.paymentProof) {
    return ctx.reply(
      "❌ No payment proof found."
    );
  }

  await ctx.replyWithPhoto(
    order.paymentProof,
    {
      caption:
        `📸 PAYMENT PROOF\n\n` +
        `🧾 ${esc(order.id)}\n` +
        `📦 ${esc(order.productName)}\n` +
        `💰 LKR ${order.price.toLocaleString()}`,

      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅  APPROVE",
            `approve_${order.id}`
          ),
          Markup.button.callback(
            "❌  REJECT",
            `reject_${order.id}`
          ),
        ],
        [
          Markup.button.callback(
            "🔙  ORDER DETAILS",
            `admin_order_${order.id}`
          ),
        ],
      ]),
    }
  );
});


/*
|--------------------------------------------------------------------------
| ALL ORDERS
|--------------------------------------------------------------------------
*/

bot.action("admin_all_orders", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();

  if (orders.length === 0) {
    return ctx.editMessageText(
      "📦 No orders yet.",
      adminMenu()
    );
  }

  const latest = orders
    .slice()
    .reverse()
    .slice(0, 15);

  let message =
    `📦 *ALL ORDERS*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  for (const order of latest) {
    message +=
      `🧾 ${esc(order.id)}\n` +
      `📦 ${esc(order.productName)}\n` +
      `💰 LKR ${order.price.toLocaleString()}\n` +
      `${statusBadge(order.status)}\n\n`;
  }

  await ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙  ADMIN PANEL",
          "admin_home"
        ),
      ],
    ]),
  });
});


/*
|--------------------------------------------------------------------------
| SALES STATISTICS
|--------------------------------------------------------------------------
*/

bot.action("admin_stats", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();

  await ctx.editMessageText(statsText(orders), {
    parse_mode: "Markdown",
    ...statsMenu(),
  });
});

/*
|--------------------------------------------------------------------------
| ANALYTICS VIEWS
|--------------------------------------------------------------------------
| Pure formatting, kept beside the handlers so the screens stay readable.
*/
function statsText(orders) {
  const s = analytics.summarise(orders);
  const daily = analytics.dailyRevenue(orders, 7);
  const games = analytics.byGame(orders).slice(0, 5);
  const products = analytics.byProduct(orders, 5);

  const peak = daily.reduce((m, d) => Math.max(m, d.revenue), 0);

  const spark = daily
    .map((d) => {
      if (!d.revenue) return "▱";
      const ratio = peak ? d.revenue / peak : 0;
      return ratio > 0.75 ? "▰" : ratio > 0.4 ? "▰" : ratio > 0 ? "▱" : "▱";
    })
    .join("");

  return (
    `📊 SALES DASHBOARD\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 Revenue (approved)\n` +
    `LKR ${analytics.money(s.revenue)}\n\n` +
    `⏳ In flight (unapproved)\n` +
    `LKR ${analytics.money(s.inFlightValue)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 Total orders: ${s.totalOrders}\n` +
    `✅ Approved: ${s.approved}\n` +
    `🔍 Pending: ${s.inFlight}\n` +
    `❌ Rejected: ${s.rejected}\n` +
    `👥 Customers: ${s.uniqueUsers}\n` +
    `📈 Approval rate: ${s.approvalRate.toFixed(0)}%\n` +
    `🧮 Avg order: LKR ${analytics.money(Math.round(s.avgOrder))}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📅 LAST 7 DAYS\n` +
    `\`${spark}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 TOP GAMES\n` +
    (games.length
      ? games
          .map(
            (g, i) =>
              `${i + 1}. ${esc(g.name)} — ${g.orders} · LKR ${analytics.money(g.revenue)}`
          )
          .join("\n")
      : "_No approved orders yet_") +
    `\n\n━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 TOP PRODUCTS\n` +
    (products.length
      ? products
          .map(
            (p, i) =>
              `${i + 1}. ${esc(p.name)} — ${p.orders} · LKR ${analytics.money(p.revenue)}`
          )
          .join("\n")
      : "_No approved orders yet_")
  );
}

function statsMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("👥  CUSTOMERS", "admin_users"),
      Markup.button.callback("🏆  LEADERBOARD", "admin_leaderboard"),
    ],
    [
      Markup.button.callback("🔎  SEARCH USER", "admin_user_search"),
    ],
    [
      Markup.button.callback("🔙  Admin Panel", "admin_home"),
    ],
  ]);
}

function userRow(u, rank) {
  const medal = rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : `${rank + 1}.`;
  const who = u.username ? `@${esc(u.username)}` : esc(u.firstName || "No username");

  return (
    `${medal} ${who}\n` +
    `    💰 LKR ${analytics.money(u.spend)}  ·  🧾 ${u.orders} order${u.orders === 1 ? "" : "s"}`
  );
}

function usersText(orders, page = 0) {
  const users = analytics.buildUsers(orders);
  const view = analytics.paginate(users, page, 6);

  const header =
    `👥 CUSTOMERS\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${users.length} customer${users.length === 1 ? "" : "s"} · ` +
    `LKR ${analytics.money(users.reduce((t, u) => t + u.spend, 0))} lifetime\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  if (!view.total) {
    return header + `_No customers yet._`;
  }

  const body = view.items
    .map((u, i) => userRow(u, view.page * 6 + i))
    .join("\n\n");

  const footer = `\n\n━━━━━━━━━━━━━━━━━━\n\n📄 ${view.page + 1} / ${view.pages}`;

  return header + body + footer;
}

function resultsListText(hits) {
  return hits
    .slice(0, 20)
    .map(
      (u, i) =>
        `${i + 1}. ${u.username ? `@${esc(u.username)}` : esc(u.firstName || "—")}\n` +
        `    💰 LKR ${analytics.money(u.spend)} · 🧾 ${u.orders}`
    )
    .join("\n\n");
}

function usersMenu(page = 0, pages = 1) {
  const rows = [];

  if (page > 0) {
    rows.push([
      Markup.button.callback("⬅️  PREV", `admin_users_p_${page - 1}`),
    ]);
  }

  if (page < pages - 1) {
    rows.push([
      Markup.button.callback("NEXT  ➡️", `admin_users_p_${page + 1}`),
    ]);
  }

  rows.push([
    Markup.button.callback("🏆  LEADERBOARD", "admin_leaderboard"),
    Markup.button.callback("🔎  SEARCH", "admin_user_search"),
  ]);

  rows.push([
    Markup.button.callback("🔙  Admin Panel", "admin_home"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function userDetailText(user, orders) {
  const mine = orders
    .filter((o) => o.userId === user.userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const recent = mine.slice(0, 6);

  const approvalRate = mine.length
    ? (mine.filter((o) => o.status === "approved").length / mine.length) * 100
    : 0;

  return (
    `👤 CUSTOMER PROFILE\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 Telegram ID\n\`${user.userId}\`\n\n` +
    `👤 Name\n${esc(user.firstName || "—")}\n\n` +
    `📛 Username\n${user.username ? `@${esc(user.username)}` : "_none_"}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 Lifetime spend\nLKR ${analytics.money(user.spend)}\n\n` +
    `🧾 Total orders\n${user.orders}\n\n` +
    `✅ Approved\n${user.approved}\n\n` +
    `🔍 In flight\n${user.pending}\n\n` +
    `❌ Rejected\n${user.rejected}\n\n` +
    `📈 Approval rate\n${approvalRate.toFixed(0)}%\n\n` +
    `⭐ Favourite\n${user.favourite ? esc(user.favourite) : "—"}\n\n` +
    `🎮 Games played\n${user.games.length ? user.games.map(esc).join(", ") : "—"}\n\n` +
    `🕐 First seen\n${analytics.when(user.firstSeen)}\n\n` +
    `🕑 Last order\n${analytics.when(user.lastSeen)}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `📜 RECENT ORDERS\n\n` +
    (recent.length
      ? recent
          .map(
            (o) =>
              `${statusBadge(o.status)}\n` +
              `\`${esc(o.id)}\` · ${esc(o.productName)}\n` +
              `LKR ${analytics.money(o.price)} · ${analytics.when(o.createdAt)}`
          )
          .join("\n\n")
      : "_None_")
  );
}

/*
|--------------------------------------------------------------------------
| CUSTOMER LIST
|--------------------------------------------------------------------------
*/
bot.action("admin_users", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();
  const users = analytics.buildUsers(orders);
  const view = analytics.paginate(users, 0, 6);

  await ctx.editMessageText(usersText(orders, 0), {
    parse_mode: "Markdown",
    ...usersMenu(0, view.pages),
  });
});

bot.action(/^admin_users_p_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const page = Number(ctx.match[1]) || 0;
  const orders = getOrders();
  const users = analytics.buildUsers(orders);
  const view = analytics.paginate(users, page, 6);

  await ctx.editMessageText(usersText(orders, page), {
    parse_mode: "Markdown",
    ...usersMenu(page, view.pages),
  });
});

/*
|--------------------------------------------------------------------------
| CUSTOMER PROFILE
|--------------------------------------------------------------------------
| The callback carries the id so a profile can be opened directly from a
| search result or from an order screen.
*/
bot.action(/^admin_user_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const targetId = Number(ctx.match[1]);
  const orders = getOrders();
  const users = analytics.buildUsers(orders);

  const user = users.find((u) => u.userId === targetId);

  if (!user) {
    return ctx.answerCbQuery({ text: "Customer not found.", show_alert: true }).catch(() => {});
  }

  await ctx.editMessageText(userDetailText(user, orders), {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "👥  ALL CUSTOMERS",
          "admin_users"
        ),
      ],
      [
        Markup.button.callback("🔙  Admin Panel", "admin_home"),
      ],
    ]),
  });
});

/*
|--------------------------------------------------------------------------
| LEADERBOARD
|--------------------------------------------------------------------------
*/
bot.action("admin_leaderboard", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();
  const users = analytics.buildUsers(orders).filter((u) => u.spend > 0);

  if (!users.length) {
    return ctx.editMessageText(
      "🏆 LEADERBOARD\n\n_No approved orders yet._",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙  Admin Panel", "admin_home")],
        ]),
      }
    );
  }

  const view = analytics.paginate(users, 0, 8);

  const podium = users
    .slice(0, 3)
    .map(
      (u, i) =>
        `${["🥇", "🥈", "🥉"][i]} @${esc(u.username || u.firstName || u.userId)} — ` +
        `LKR ${analytics.money(u.spend)}`
    )
    .join("\n");

  const rest = view.items
    .map((u, i) => userRow(u, view.page * 8 + i + 3))
    .join("\n\n");

  await ctx.editMessageText(
    `🏆 TOP CUSTOMERS\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${podium}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${rest}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `📄 ${view.page + 1} / ${view.pages}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        view.page < view.pages - 1
          ? [Markup.button.callback("NEXT  ➡️", `admin_lb_p_${view.page + 1}`)]
          : [],
        [
          Markup.button.callback("👥  ALL CUSTOMERS", "admin_users"),
          Markup.button.callback("🔙  Admin Panel", "admin_home"),
        ],
      ].filter((row) => row.length)),
    }
  );
});

bot.action(/^admin_lb_p_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const page = Number(ctx.match[1]) || 0;
  const orders = getOrders();
  const users = analytics.buildUsers(orders).filter((u) => u.spend > 0);

  if (!users.length) {
    return ctx.editMessageText("🏆 LEADERBOARD\n\n_No approved orders yet._", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙  Admin Panel", "admin_home")],
      ]),
    });
  }

  const view = analytics.paginate(users, page, 8);

  await ctx.editMessageText(
    `🏆 TOP CUSTOMERS (${view.page + 1}/${view.pages})\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      view.items.map((u, i) => userRow(u, view.page * 8 + i)).join("\n\n") +
      `\n\n━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 Total: LKR ${analytics.money(users.reduce((t, u) => t + u.spend, 0))}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        view.page > 0
          ? [Markup.button.callback("⬅️  PREV", `admin_lb_p_${view.page - 1}`)]
          : [],
        view.page < view.pages - 1
          ? [Markup.button.callback("NEXT  ➡️", `admin_lb_p_${view.page + 1}`)]
          : [],
        [
          Markup.button.callback("👥  ALL CUSTOMERS", "admin_users"),
          Markup.button.callback("🔙  Admin Panel", "admin_home"),
        ],
      ].filter((row) => row.length)),
    }
  );
});

/*
|--------------------------------------------------------------------------
| CUSTOMER SEARCH
|--------------------------------------------------------------------------
*/
bot.action("admin_user_search", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  ensureSession(ctx).adminFlow = { step: "customer_search" };

  await ctx.reply(
    `🔎 SEARCH CUSTOMER\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Send a *username*, *name*, or *Telegram ID*.\n\n` +
      `Example: \`methsarp\` or \`8278530664\`\n\n` +
      `Send /admin to cancel.`,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});


/*
|--------------------------------------------------------------------------
| ADMIN HOME
|--------------------------------------------------------------------------
*/

bot.action("admin_home", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const s = analytics.summarise(getOrders());

  await ctx.editMessageText(
    `👑 ${STORE_NAME}\n\n` +
      `🛠️ ADMIN PANEL\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🔍 Pending orders: ${s.inFlight}\n` +
      `👥 Customers: ${s.uniqueUsers}\n` +
      `💰 Revenue: LKR ${analytics.money(s.revenue)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Select an option below:`,

    {
      parse_mode: "Markdown",
      ...adminMenu(),
    }
  );
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

bot.catch((error) => {
  // Tapping a button on an old message makes answerCbQuery fail with an
  // expired query id. That is a normal race, not a fault: log it briefly
  // and keep serving so the rest of the bot is unaffected.
  const message = String(error?.description || error?.message || "");

  if (message.includes("query is too old") || message.includes("QUERY_ID_INVALID")) {
    console.warn("⚠️  Stale callback query ignored:", message);
    return;
  }

  console.error("❌ BOT ERROR:", error);
});
bot.telegram.setMyCommands([
  {
    command: "start",
    description: "🏠 Open the store",
  },
  {
    command: "games",
    description: "🕹️ Browse games",
  },
  {
    command: "orders",
    description: "📦 View my orders",
  },
  {
    command: "about",
    description: "ℹ️ Developer & contact",
  },
  {
    command: "review",
    description: "🕵️ Review unresolved top-ups",
  },
  {
    command: "admin",
    description: "👑 Admin panel",
  },
]);

/*
|--------------------------------------------------------------------------
| START BOT
|--------------------------------------------------------------------------
| Every handler is registered before the bot connects, so the supplier
| client and the startup recovery both run on a complete bot.
*/
async function startBot() {
  try {
    await supplierAdapter.initialize();
  } catch (error) {
    console.error(
      "[SUPPLIER] Not available:",
      error.message
    );
    console.log(
      "[SUPPLIER] Approvals will be held for manual review"
    );
  }

  try {
    await runStartupRecovery();
  } catch (error) {
    console.error(
      "[STARTUP] Recovery failed:",
      error.message
    );
  }

  await bot.launch();

  console.log(
    `🚀 ${STORE_NAME} bot is running...`
  );
}

// Tests require this file to reach the handlers, so only start when this
// file is the entry point.
if (require.main === module) {
  startBot();
}

module.exports = {
  bot,
  supplierAdapter,
  processAutoTopup,
  recoverTopupStatus,
  runStartupRecovery,
  settleForReview,
  notifyAdminOfReview,
  reviewingOrders,
  getOrders,
  readOrders,
  mutateOrder,
  appendOrder,
};

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);

/*
|--------------------------------------------------------------------------
| FLOW STARTERS
|--------------------------------------------------------------------------
*/

bot.action(/^sage_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  await ctx.reply(
    `✏️ *EDIT GAME*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `*Name:* ${esc(game.name)}\n` +
      `*Emoji:* ${game.emoji}\n` +
      `*ID Label:* ${esc(game.idLabel)}\n\n` +
      `Send a new value for the *ID label*\n` +
      `(what customers must enter).\n\n` +
      `Example: \`Player ID\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🏷  CHANGE EMOJI",
            `sagee_${game.id}`
          ),
        ],
        [
          Markup.button.callback(
            `🔙  ${game.emoji}  ${game.name}`,
            `sag_${game.id}`
          ),
        ],
      ]),
    }
  );

  ensureSession(ctx).adminFlow = { step: "game_idlabel", gameId: game.id };
});

bot.action(/^sagee_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ensureSession(ctx).adminFlow = { step: "game_emoji_existing", gameId: game.id };

  await ctx.reply(
    `🏷 *CHANGE EMOJI*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Send a new emoji for *${esc(game.name)}*.\n\n` +
      `Example: 🎮`,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});

bot.action(/^sagp_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ensureSession(ctx).adminFlow = {
    step: "package_name",
    gameId: game.id,
  };

  await ctx.reply(
    `➕ *NEW PACKAGE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Adding to *${esc(game.name)}*\n\n` +
      `Send the *name* of the package.\n\n` +
      `Example: \`💎 100 Gold\``,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});

bot.action(/^sape_price_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  ensureSession(ctx).adminFlow = {
    step: "package_price_update",
    gameId: found.game.id,
    packageId: found.pkg.id,
  };

  await ctx.reply(
    `💰 *UPDATE PRICE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `${found.pkg.name}\n` +
      `Current: LKR ${catalog.formatPrice(found.pkg.price)}\n\n` +
      `Send the new price in LKR.\n\n` +
      `Example: \`1250\``,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});

bot.action(/^sape_name_(.+)~(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  ensureSession(ctx).adminFlow = {
    step: "package_rename",
    gameId: found.game.id,
    packageId: found.pkg.id,
  };

  await ctx.reply(
    `✏️ *RENAME PACKAGE*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `Current: ${found.pkg.name}\n\n` +
      `Send the new package name.`,
    {
      parse_mode: "Markdown",
      ...cancelFlowButton(),
    }
  );
});
