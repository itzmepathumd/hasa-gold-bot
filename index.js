require("./loadenv");

const { Telegraf, Markup, session } = require("telegraf");
const fs = require("fs");
const crypto = require("crypto");
const catalog = require("./catalog");
const playerValidate = require("./playerValidate");
const analytics = require("./analytics");
const anim = require("./anim");
const botStatus = require("./status");
const webhookServer = require("./webhookServer");
const { Shop2TopupAdapter } = require("./src/shop2topup");

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

/*
| A wrong ADMIN_ID is otherwise invisible: the bot starts cleanly, trades
| normally, and simply refuses every /admin with "Admin access only". That
| reads like a permissions problem when it is really a typo in .env, so the
| real id is printed on boot and checked for a shape Telegram ids never have.
*/
console.log(`👑 Admin id: ${ADMIN_ID}`);

if (!Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  console.error(
    `❌ ADMIN_ID "${process.env.ADMIN_ID}" is not a Telegram user id. ` +
      `It must be the plain numeric id, with no @ or username.`
  );
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

  // Updates only arrive while the bot is connected and polling, so their
  // arrival is the cheapest honest proof Telegram is still talking to us.
  botStatus.record("telegram", true, "polling");

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
| TOP-UP PROVIDER
|--------------------------------------------------------------------------
| Approving an order places it with SHOP2TOPUP:
|
|   POST /api/endpoints/v1/orders/create
|     { order_id, sub_category_id, quantity, requirements }
|
| The wallet is charged the moment that order is created, so the order_id is
| a UUID minted before the call and stored on the order. It is the provider's
| idempotency key: the same UUID always returns the same order, so a retry
| can never charge twice.
|
| A package with no sub_category_id was never mapped onto a provider
| product, so those orders go to manual review rather than being sent a
| guessed request.
*/
const topupProvider = new Shop2TopupAdapter({
  productionMode:
    process.env.SHOP2TOPUP_PRODUCTION_MODE === "true",

  // The catalog is this file's business, not the provider module's, so the
  // product behind an order is resolved here.
  resolveProduct: (order) => {
    if (!order?.gameId || !order?.productKey) {
      return null;
    }

    const found = catalog.findPackage(order.gameId, order.productKey);

    return found ? found.pkg : null;
  },
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
| ORDER DATABASE
|--------------------------------------------------------------------------
| Orders are read and written only through the database layer, which uses
| Firestore when it is configured and the JSON files otherwise. Nothing here
| touches a file directly any more.
*/

const {
  readOrders,
  getOrders,
  mutateOrder,
  appendOrder,
  getOrder,
  getUserOrders,
  getOrdersByStatus,
  getPendingOrders,
  getOrderStats,
  // Lifecycle. Aliased so they read clearly next to the other store calls
  // and cannot be confused with a similarly named helper elsewhere.
  hydrate: hydrateOrders,
  describe: describeOrderStore,
  setOrderStoreFailureHandler,
  healthCheck: checkOrderStoreHealth,
  closeDb: closeOrderStore,
} = require("./src/database/orders");

/*
| Tell the admin the order store is unusable, once per distinct reason.
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
        `No orders were written. The store is\n` +
        `checked at every start, so nothing was lost.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error(
      "[ORDERS] Could not send the alert:",
      error.message
    );
  }
}

setOrderStoreFailureHandler(notifyAdminOfStorageFailure);

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

/*
|--------------------------------------------------------------------------
| INLINE CODE
|--------------------------------------------------------------------------
| A code span is literal: Telegram does not process backslash escapes inside
| backticks, so escaping there leaks the backslashes into the message. An
| order ID such as HG-1234-ABCD would reach the customer as HG\-1234\-ABCD.
| Values placed in backticks go through this instead.
*/
function code(value) {
  return `\`${String(value ?? "")
    .replace(/\\/g, "")
    .replace(/`/g, "'")}\``;
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
  status: "📡  STATUS",
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
      Markup.button.callback(LABEL.status, "status"),
    ],
    [Markup.button.callback(LABEL.home, "home")],
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

bot.command("status", async (ctx) => {
  await showStatus(ctx);
});

/*
|--------------------------------------------------------------------------
| STATUS
|--------------------------------------------------------------------------
| Customers get the plain panel: is the shop working, and what to do if it is
| not. The admin panel carries the internals, and this text is built from an
| allowlist so none of them can reach a customer by accident.
*/

async function showStatus(ctx) {
  const { customer } = renderStatusViews();

  // A last line of defence. If a future field ever leaks an internal name,
  // the customer sees a plain answer rather than the detail.
  const leaks = botStatus.leaksInternals(customer);

  if (leaks.length > 0) {
    console.error(
      "[STATUS] Refusing to show a customer panel containing:",
      leaks.join(", ")
    );

    return ctx.reply(
      `📡 *SERVICE STATUS*\n\n━━━━━━━━━━━━━━━━━━\n\n` +
        `🟢 All systems operational\n\n` +
        `Please try again shortly if something does not respond.`
    );
  }

  await ctx.reply(customer, {
    parse_mode: "HTML",
    ...customerStatusMenu(),
  });
}

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

bot.action("status", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  await showStatus(ctx);
});

/*
| A refresh edits in place, unlike the first open, so pressing refresh
| repeatedly does not fill the chat with copies of the same panel.
*/
bot.action("status_refresh", async (ctx) => {
  await ctx.answerCbQuery("Refreshing…").catch(() => {});

  const { customer } = renderStatusViews();

  await ctx.editMessageText(customer, {
    parse_mode: "HTML",
    ...customerStatusMenu(),
  });
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
          payment.lines.map((l) => code(l)).join("\n"),
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
      `✅ Added: ${code(text)}\n\n` +
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
| PLAYER CHECK RATE LIMIT
|--------------------------------------------------------------------------
| Every ID lookup is a real SHOP2TOPUP request, so the store pays for each
| one. Without a cap, a single user restarting the order flow repeatedly
| drains the quota for everyone. The map is pruned on access so it cannot
| grow without bound.
*/

const PLAYER_CHECK_WINDOW_MS = 60_000;
const PLAYER_CHECK_MAX_PER_WINDOW = 5;

const playerCheckHits = new Map();

function allowPlayerCheck(userId) {
  const now = Date.now();
  const hits = (playerCheckHits.get(userId) || []).filter(
    (t) => now - t < PLAYER_CHECK_WINDOW_MS
  );

  if (hits.length >= PLAYER_CHECK_MAX_PER_WINDOW) {
    playerCheckHits.set(userId, hits);

    return false;
  }

  hits.push(now);
  playerCheckHits.set(userId, hits);

  return true;
}

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

  // Not waiting for an ID, so this message is not ours. Pass it on so the
  // fallback can answer instead of the bot going silent.
  if (!ctx.session?.waitingForPlayerId) {
    return next();
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

  if (!allowPlayerCheck(ctx.from.id)) {
    return ctx.reply(
      `⏳ *PLEASE SLOW DOWN*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Too many player ID checks in a row.\n\n` +
        `Wait a minute and send the ID again.\n` +
        `Nothing has been charged or ordered.`,
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
      work: async () => {
        const result = await playerValidate.validateShop2TopupPlayer(playerId, pkg);

        // A rejected player ID is the API working correctly, so only a
        // transport or service failure counts against its health. Recording it
        // here is what lets the status panel answer without calling out.
        if (result?.success) {
          botStatus.record("validation", true, "last check succeeded");
        } else if (result?.retryable) {
          botStatus.record(
            "validation",
            false,
            result.error || "player check unavailable"
          );
        } else {
          botStatus.record("validation", true, "last check answered");
        }

        return result;
      },

      final: (r) => {
        if (r?.success) {
          return (
            `✅ PLAYER VERIFIED\n\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `🆔 ${esc(game.idLabel.toUpperCase())}\n\`${playerId}\`\n\n` +
            `👤 Player Name\n${esc(r.playerName)}\n\n` +
            // SHOP2TOPUP returns no region for Blood Strike, so the row is
            // hidden rather than claiming "Global".
            (r.region
              ? `🌍 Region\n${esc(r.region)}\n\n`
              : "") +
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

    // The same "gameId~packageId" string the products collection and the
    // migration use. Stored at creation so an order always carries the id
    // SHOP2TOPUP and the product lookup resolve against.
    productId: `${game.id}~${pkg.id}`,

    productKey: pkg.id,

    productName: pkg.name,

    price: pkg.price,

    status: "pending_payment",

    paymentProof: null,

    createdAt: new Date().toISOString(),

    paymentSubmittedAt: null,

    approvedAt: null,

    rejectedAt: null,

    rejectedBy: null,

    rejectReason: null,

    // The provider's product id, kept as a snapshot so an admin editing the
    // catalog cannot change what an existing order buys.
    subCategoryId: pkg.sub_category_id || null,

    // Automatic top-up tracking. Filled in as the order moves.
    topupStatus: null,
    topupAttempts: 0,

    // The provider's idempotency key. Minted when fulfilment is claimed, one
    // step before the wallet can be charged, and never changed afterwards.
    providerOrderId: null,
    providerTransactionId: null,
    providerStatus: null,
    providerRaw: null,
    topupRetryArmed: false,
    topupStartedAt: null,
    topupCompletedAt: null,
    topupError: null,
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
      `🧾 *ORDER ID*\n${code(order.id)}\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `📦 *PACKAGE*\n${esc(order.productName)}\n\n` +
      `🆔 *${esc(game.idLabel.toUpperCase())}*\n${code(order.playerId)}\n\n` +
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

/*
|--------------------------------------------------------------------------
| OTHER MESSAGE TYPES
|--------------------------------------------------------------------------
| Stickers, voice notes, videos and files are not commands and not payment
| proofs, so without this the bot again says nothing at all.
*/

const MEDIA_GUIDE =
  `👋 *I ONLY READ TEXT AND SCREENSHOTS*\n\n` +
  `━━━━━━━━━━━━━━━━━━\n\n` +
  `You sent something I cannot use.\n\n` +
  `Here is what I understand:\n\n` +
  `💬 *Text* like \`hi\`, \`help\` or \`orders\`\n` +
  `📸 *A photo* of your payment receipt\n` +
  `🆔 *Numbers* for your game player ID\n\n` +
  `Tap a button below to continue.`;

for (const mediaType of [
  "sticker",
  "voice",
  "video",
  "video_note",
  "animation",
  "document",
  "contact",
  "location",
  "venue",
  "dice",
  "poll",
]) {
  bot.on(mediaType, async (ctx) => {
    // An admin typing into a flow must not be answered by the store.
    if (ctx.from.id === ADMIN_ID && ctx.session?.adminFlow) {
      return;
    }

    // A payment was expected, so point at the actual next step instead of
    // describing the whole bot.
    if (ctx.session?.waitingForPayment) {
      const orderRef = ctx.session.orderId
        ? `Order ${code(ctx.session.orderId)} is still\nwaiting for payment.\n\n`
        : `Your order is still waiting for payment.\n\n`;

      return ctx.reply(
        `📸 *PAYMENT SCREENSHOT NEEDED*\n\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          orderRef +
          `Send the receipt as a *photo*, not a file,\nsticker or voice note.\n\n` +
          `_Type cancel to drop this order._`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("❌  CANCEL ORDER", "cancel_order")],
          ]),
        }
      );
    }

    await ctx.reply(MEDIA_GUIDE, {
      parse_mode: "Markdown",
      ...replyMenu(),
    });
  });
}

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
      `🧾 *ORDER ID*\n${code(order.id)}\n\n` +
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
| Fulfilment runs after an order is approved, and places the order with
| SHOP2TOPUP.
|
| The rules exist to protect a paying customer:
|
|   - every transition goes through mutateOrder(), so two approvals at once
|     cannot overwrite each other,
|   - an order is claimed by moving it to topup_processing exactly once, so
|     a double-tapped button cannot place two provider orders,
|   - the claim also mints the provider's idempotency key and stores it
|     BEFORE anything is charged, so a crash mid-call can be looked up
|     instead of guessed at,
|   - a request whose outcome is unknown is NEVER resent under a new key,
|     because the wallet may already have been charged,
|   - only an explicitly completed provider status counts as delivered;
|     everything else lands in needs_review for a human.
|
| With SHOP2TOPUP_PRODUCTION_MODE=false nothing is ordered, so an order
| settles as needs_review rather than being reported as completed.
*/

const TOPUP_MAX_ATTEMPTS = 3;

/*
| The provider charges the wallet as soon as an order is created, so a
| "pending" answer is not the end of it. These bound how long the shop keeps
| asking before a human takes over.
*/
const TOPUP_POLL_INTERVAL_MS = 60 * 1000;
const TOPUP_POLL_ATTEMPTS = 10;

function isTerminalTopup(order) {
  return (
    order.topupStatus === "topup_completed" ||
    order.topupStatus === "topup_failed"
  );
}

/*
| The idempotency key for an order, from any era of the shop: provider orders
| carry providerOrderId, and records written by the old supplier bot carry
| supplierTransactionId/supplierMessageId instead.
*/
function providerOrderKey(order) {
  return (
    order?.providerOrderId ||
    order?.supplierTransactionId ||
    order?.supplierMessageId ||
    null
  );
}

/**
 * Send one order to the provider and settle the result.
 */
async function processAutoTopup(orderId) {
  // An order with no provider product is never claimed, so it never gets an
  // idempotency key and never reaches the API. Approval normally parks these
  // first; this is the backstop for every other path in.
  const known = getOrders().find((o) => o.id === orderId);

  if (!known) {
    console.error(`[AUTO-TOPUP] Order ${orderId} not found`);
    return;
  }

  if (isTerminalTopup(known)) {
    return;
  }

  if (!topupProvider.canFulfill(known)) {
    await settleForReview(
      orderId,
      "This package is not mapped to a provider product"
    );
    return;
  }

  // The mutator reports its decision through `claim` while still returning
  // the order itself, so the stored record is never replaced by a wrapper.
  const claim = { action: null };

  const order = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      claim.action = "terminal";
      return current;
    }

    // An admin retry re-arms an order that already carries a provider order
    // id. That is deliberate: the same UUID is reused, so the provider
    // returns the order it already has instead of charging again.
    const rearmed = Boolean(current.topupRetryArmed);

    if (
      current.topupStatus === "topup_processing" ||
      (providerOrderKey(current) && !rearmed)
    ) {
      // The order already went out, so its outcome is unknown. Never
      // resend under a new key: hand it to a human.
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

    // The idempotency key is written here, before anything is charged. If
    // the process dies between this save and the provider's answer, the
    // order can still be read back by this exact UUID instead of being
    // ordered a second time.
    current.providerOrderId =
      current.providerOrderId || topupProvider.newOrderId() || null;
    current.topupRetryArmed = false;

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

  // The provider request and the "processing" notice are independent, so
  // they run together instead of making the customer wait out the
  // animation before fulfilment even starts.
  const request = topupProvider
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

      // The order may already have been charged, so this is
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

    current.providerOrderId =
      result.orderId || current.providerOrderId || providerOrderKey(current);
    current.providerTransactionId =
      result.transactionId || current.providerTransactionId;
    current.providerStatus = result.providerStatus || null;

    if (result.raw) {
      current.providerRaw = result.raw;
    }

    if (result.success) {
      current.topupStatus = "topup_completed";
      current.status = "topup_completed";
      current.topupCompletedAt = new Date().toISOString();
      current.topupError = null;
      current.providerFailed = false;
      return current;
    }

    current.topupError =
      result.statusDetail || result.status || "Unknown error";

    // "pending" means the wallet has been charged and the provider is still
    // delivering. An unknown answer means the order may exist at all. Neither
    // is a failure, and ordering again could charge twice, so the order is
    // parked and read back from the provider instead.
    if (result.status !== "failed") {
      current.topupStatus = "needs_review";
      current.status = "needs_review";
      return current;
    }

    current.topupStatus = "topup_failed";
    current.status = "topup_failed";
    current.topupCompletedAt = new Date().toISOString();

    // The provider refused this order, so no top-up was delivered and the
    // customer has been told. That is not a closed sale: their money is
    // still involved, so the order goes to the review queue for a person.
    current.providerFailed = true;

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

  if (applied.providerFailed) {
    await notifyAdminOfReview();
  }

  // The provider may still be delivering, and the customer has already been
  // told it is under review. Keep asking until it settles or a human takes
  // over; this only ever reads the existing order back.
  if (applied.topupStatus === "needs_review" && applied.providerOrderId) {
    scheduleTopupResolution(orderId);
  }
}

/*
|--------------------------------------------------------------------------
| RESOLVE A RUNNING PROVIDER ORDER
|--------------------------------------------------------------------------
| The provider charges at creation and delivers afterwards, so a "pending"
| answer is the normal shape of a real top-up. This asks the provider about
| the order that already exists, on a bounded schedule, and settles the
| record as soon as it has an answer.
|
| It never places an order, so a customer cannot be charged twice by it.
*/
const topupResolutions = new Map();

function scheduleTopupResolution(orderId, attempt = 1) {
  if (topupResolutions.has(orderId)) {
    return;
  }

  const timer = setTimeout(() => {
    topupResolutions.delete(orderId);
    resolveTopupOrder(orderId, attempt).catch((error) => {
      console.error(
        `[AUTO-TOPUP] Order ${orderId} resolution failed:`,
        error.message
      );
    });
  }, TOPUP_POLL_INTERVAL_MS);

  // Nothing here should keep the process alive on its own.
  timer.unref?.();

  topupResolutions.set(orderId, timer);
}

async function resolveTopupOrder(orderId, attempt = 1) {
  const order = getOrders().find((o) => o.id === orderId);

  if (!order || isTerminalTopup(order) || !order.providerOrderId) {
    return;
  }

  let result;

  try {
    result = await topupProvider.checkTopupStatus(order);
  } catch (error) {
    console.error(
      `[AUTO-TOPUP] Order ${orderId} lookup failed:`,
      error.message
    );
    result = { status: "unknown", statusDetail: "lookup_failed" };
  }

  if (result.status === "success" || result.status === "failed") {
    const applied = await mutateOrder(orderId, (current) => {
      if (isTerminalTopup(current)) {
        return current;
      }

      if (result.transactionId) {
        current.providerTransactionId = result.transactionId;
      }

      current.providerStatus = result.providerStatus || null;

      if (result.raw) {
        current.providerRaw = result.raw;
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
        result.statusDetail || "The provider reported a failure";
      current.topupCompletedAt = new Date().toISOString();
      current.providerFailed = true;

      return current;
    });

    if (applied) {
      await notifyTopupResult(
        applied,
        applied.topupStatus === "topup_completed" ? "completed" : "failed"
      );

      if (applied.providerFailed) {
        await notifyAdminOfReview();
      }
    }

    return;
  }

  if (attempt >= TOPUP_POLL_ATTEMPTS) {
    await settleForReview(
      orderId,
      `The provider has not settled this order after ${attempt} checks`
    );

    return;
  }

  scheduleTopupResolution(orderId, attempt + 1);
}

function stopTopupResolutions() {
  for (const timer of topupResolutions.values()) {
    clearTimeout(timer);
  }

  topupResolutions.clear();
}

/*
|--------------------------------------------------------------------------
| RECOVER TOP-UP STATUS
|--------------------------------------------------------------------------
| Resolves an order that is already with the provider. It only reads the
| existing order back, so an uncertain outcome stays uncertain instead of
| being paid for twice.
*/
async function recoverTopupStatus(orderId) {
  const order = getOrders().find(
    (o) => o.id === orderId
  );

  if (!order || isTerminalTopup(order)) {
    return;
  }

  if (!providerOrderKey(order)) {
    await settleForReview(
      orderId,
      "No provider order exists for this record, so its state cannot be read"
    );
    return;
  }

  let result;

  try {
    result = await topupProvider.checkTopupStatus(order);
  } catch (error) {
    console.error(
      `[RECOVERY] Order ${orderId} lookup failed:`,
      error.message
    );
    return;
  }

  // Still running, or the provider would not say. Neither is a failure, and
  // ordering again could charge the customer twice.
  if (result.status !== "success" && result.status !== "failed") {
    await settleForReview(orderId, result.reason || result.statusDetail || null);
    scheduleTopupResolution(orderId);
    return;
  }

  const applied = await mutateOrder(orderId, (current) => {
    if (isTerminalTopup(current)) {
      return current;
    }

    if (result.transactionId) {
      current.providerTransactionId = result.transactionId;
    }

    if (result.raw) {
      current.providerRaw = result.raw;
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
      result.statusDetail || "The provider reported a failure";
    current.topupCompletedAt = new Date().toISOString();
    current.providerFailed = true;

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

  if (applied.providerFailed) {
    await notifyAdminOfReview();
  }
}

/*
|--------------------------------------------------------------------------
| SETTLE FOR REVIEW
|--------------------------------------------------------------------------
| Parks an order whose provider outcome cannot be determined.
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
      order.status === "needs_review" ||
      // Paid and approved but never handed to the provider. Approval always
      // sets ready_for_topup, so this shape only appears if a write was
      // interrupted or the record predates the top-up feature. Left alone it
      // would stay invisible while the customer waits.
      (order.status === "approved" && !order.topupStatus)
  );

  if (pending.length === 0) {
    console.log("[STARTUP] Nothing to recover");
    return;
  }

  console.log(
    `[STARTUP] ${pending.length} order(s) need attention`
  );

  for (const order of pending) {
    if (providerOrderKey(order)) {
      await recoverTopupStatus(order.id);
      continue;
    }

    console.warn(
      `[STARTUP] Order ${order.id}: no provider order was recorded`
    );

    await mutateOrder(order.id, (current) => {
      if (isTerminalTopup(current)) {
        return current;
      }

      // Keep whatever the status was so parking a record never erases
      // the fact that it had already been paid and approved.
      if (!current.previousStatus) {
        current.previousStatus = current.status;
      }

      current.topupStatus = "needs_review";
      current.status = "needs_review";
      current.topupError =
        "Interrupted before a provider order was recorded";

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
        `   ${esc(order.topupError || "not settled by the provider")}`
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
/*
| Everything a human still has to decide on.
|
| Two shapes land here. An order whose outcome could not be read back is
| parked as needs_review. An order the provider refused is marked
| providerFailed: the customer has been told it failed, but nobody has
| settled what happens with their money, so it waits for a person instead of
| quietly counting as a closed sale.
*/
function reviewingOrders() {
  return getOrders().filter(
    (order) =>
      order.status === "needs_review" ||
      (order.providerFailed && order.status === "topup_failed")
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
      current.topupStartedAt = null;
      current.topupCompletedAt = null;
      current.topupError = null;
      current.topupRetryArmed = false;
      current.providerStatus = null;
      current.providerRaw = null;
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

  // A package with no provider sub_category_id was never mapped onto a
  // product the API can sell, so it is handled by a person and the customer
  // is not told a top-up is running.
  const automated = topupProvider.canFulfill(approved);

  if (!automated) {
    await settleForReview(
      orderId,
      "This package is not mapped to a provider product"
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
  const rejectReason = "Rejected by admin";

  const rejected = await mutateOrder(order.id, (current) => {
    if (current.status !== "pending_approval") {
      return false;
    }

    current.status = "rejected";
    current.rejectedAt = rejectedAt;
    // A rejection with no recorded reason cannot be defended later if the
    // customer disputes it, so the actor and reason are always stored.
    current.rejectedBy = ctx.from.id;
    current.rejectReason = rejectReason;

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
        `🆔 Player ID: ${code(order.playerId)}\n` +
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
      `🆔 ${code(order.playerId)}\n` +
      `💬 ${esc(order.topupError || "not settled by the provider")}\n\n`;
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
  const automated = topupProvider.canFulfill(order);
  const providerId = providerOrderKey(order);

  return (
    `🕵️ *REVIEW ORDER*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 Order:\n${code(order.id)}\n\n` +
    `🎮 ${esc(order.gameName)}\n\n` +
    `📦 Product:\n${esc(order.productName)}\n\n` +
    `🆔 Player ID:\n${code(order.playerId)}\n\n` +
    `💰 Amount:\nLKR ${esc(order.price)}\n\n` +
    `👤 Customer:\n${esc(order.firstName)} (@${esc(order.username || "unknown")})\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🤖 *AUTOMATION*\n\n` +
    `📤 Attempts: ${attempts} of ${TOPUP_MAX_ATTEMPTS}\n` +
    `📦 Automated: ${
      automated ? "yes" : "no (no provider product mapped)"
    }\n` +
    // The provider's own id for this order. It is the only safe handle:
    // asking about this id cannot place a second order or charge again.
    (providerId
      ? `🔖 Provider order:\n${code(providerId)}\n`
      : `🔖 Provider order:\nnever placed\n`) +
    (order.providerTransactionId
      ? `🧾 Provider reference:\n${code(order.providerTransactionId)}\n`
      : "") +
    (order.providerStatus
      ? `📶 Provider status:\n${esc(order.providerStatus)}\n`
      : "") +
    `⚠️ Reason:\n${esc(order.topupError || "not recorded")}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👇 Check the provider order above, then pick an outcome.`
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

  // A retry re-runs the provider call with the same provider order id, so
  // it returns the order the provider already holds. That is exactly what a
  // still-running order needs, and exactly what a refused one does not: the
  // provider would refuse it again. So the button is offered only where a
  // retry can still change the outcome.
  if (canRetry && canRetryProviderOrder(order)) {
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
| Whether re-running the provider call could still change anything. It is
| offered for an order the provider is still working on, never for one it
| refused.
*/
function canRetryProviderOrder(order) {
  return (
    order.status === "needs_review" &&
    Boolean(order.providerOrderId) &&
    !order.providerFailed
  );
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
      `🆔 ${code(order.playerId)}\n` +
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
      `🧾 ${code(applied.id)}\n\n` +
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
      `🧾 ${code(applied.id)}\n\n` +
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
| Runs the provider call again, so it is only offered while attempts remain.
|
| The retry keeps the order's provider id. That id is the provider's
| idempotency key, so the retry returns the order that already exists rather
| than buying a second one. An admin who needs a genuinely fresh purchase
| marks the order failed and handles it off-platform.
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

  if (!topupProvider.canFulfill(order)) {
    return ctx.reply(
      `⚠️ This package is not mapped to a provider\n` +
        `product, so it cannot be ordered automatically.\n\n` +
        `Complete or fail it by hand.`
    );
  }

  // Re-arm the parked order. The provider id is deliberately left alone: it
  // is what stops a retry from becoming a second purchase.
  const prepared = await mutateOrder(orderId, (current) => {
    if (current.status !== "needs_review") {
      return false;
    }

    current.topupStatus = "ready_for_topup";
    current.topupRetryArmed = true;

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
      `🧾 ${code(orderId)}\n\n` +
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
        "📡  SYSTEM STATUS",
        "admin_status"
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
| STATUS PANEL
|--------------------------------------------------------------------------
| status.js decides what is true and formats it; this section supplies the
| live values only it cannot obtain for itself and owns the routes.
|
| There is no live check behind the admin panel: health comes from what the
| bot has actually done since it started, because probing on every open would
| spend API quota to answer a question the last real result already answers.
*/

function statusContext() {
  const store = describeOrderStore();
  const games = catalog.getGames();
  const providerState = topupProvider.getStatus();

  return {
    store: {
      ...store,
      orders: getOrders().length,
    },
    runtime: {
      // How updates arrive. When the shop goes quiet this is the first thing
      // worth knowing: on a sleeping host it is usually not polling.
      transport,
      port: webhookHandle ? webhookServer.port() : null,
    },
    catalog: {
      games: games.length,
      products: games.reduce(
        (total, game) => total + catalog.getPackages(game.id).length,
        0
      ),
      payments: catalog.getPayments().length,
    },
    provider: {
      // The mode matters more than the partner: the admin needs to see that
      // top-ups are simulated, and why.
      mode: providerState.testMode ? "test" : "production",
      available: providerState.ready,
      detail: providerState.testMode
        ? "No real top-ups are sent"
        : providerState.ready
          ? `via ${providerState.provider} order API`
          : providerState.configured
            ? "The provider is not ready, so approvals go to manual review"
            : "No API key configured, so approvals go to manual review",
    },
    shuttingDown: isShuttingDown,
  };
}

function adminStatusMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄  REFRESH", "admin_status_refresh")],
    [
      Markup.button.callback(LABEL.games, "games"),
      Markup.button.callback("🔙  ADMIN PANEL", "admin_home"),
    ],
  ]);
}

function customerStatusMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄  REFRESH", "status_refresh"),
      Markup.button.callback(LABEL.support, "support"),
    ],
    [Markup.button.callback(LABEL.home, "home")],
  ]);
}

/*
| Both handlers take the same snapshot, so the admin view and the customer
| view can never describe two different moments.
*/
function renderStatusViews() {
  const snap = botStatus.snapshot(statusContext());

  return {
    snap,
    admin: botStatus.renderAdmin(snap, STORE_NAME),
    customer: botStatus.renderCustomer(snap, STORE_NAME),
  };
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
    ? payment.lines.map((l) => code(l)).join("\n")
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
      `🆔 ${code(order.playerId)}\n` +
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
| SYSTEM STATUS
|--------------------------------------------------------------------------
*/

bot.action("admin_status", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const { admin } = renderStatusViews();

  await ctx.editMessageText(admin, {
    parse_mode: "Markdown",
    ...adminStatusMenu(),
  });
});

// Same panel, re-read. Separate callback data because a press on the same
// button twice in a row would otherwise be answered with "edited message is
// not modified" and look like nothing happened.
bot.action("admin_status_refresh", async (ctx) => {
  await ctx.answerCbQuery("Refreshing…").catch(() => {});

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const { admin } = renderStatusViews();

  await ctx.editMessageText(admin, {
    parse_mode: "Markdown",
    ...adminStatusMenu(),
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
              `${code(o.id)} · ${esc(o.productName)}\n` +
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
// Customers only see what they can actually use. The admin commands are
// registered separately against the admin's chat so they do not clutter
// the command list for everyone else.
const CUSTOMER_COMMANDS = [
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
    command: "status",
    description: "📡 Service status",
  },
  {
    command: "support",
    description: "💬 Contact customer support",
  },
  {
    command: "cancel",
    description: "❌ Cancel the current order",
  },
];

const ADMIN_COMMANDS = [
  {
    command: "admin",
    description: "👑 Admin panel",
  },
  {
    command: "review",
    description: "🕵️ Review unresolved top-ups",
  },
];

/*
| A chat-scoped list REPLACES the default list for that chat rather than
| adding to it, so scoping the admin commands alone left the admin chat
| showing only /admin and /review. Everything goes in one default list
| instead. The handlers already check the admin ID, so a customer typing
| /admin just gets "Admin access only".
*/
const ALL_COMMANDS = [...CUSTOMER_COMMANDS, ...ADMIN_COMMANDS];

// These are fire-and-forget: a BotFather outage or a bad token would
// otherwise surface as an unhandled rejection and take the bot down. The
// commands are a convenience, so a failure only degrades the menu.
bot.telegram
  .setMyCommands(ALL_COMMANDS)
  .catch((error) =>
    console.warn(
      "⚠️  Could not publish the command list:",
      error.message
    )
  );

// The stale chat-scoped list from an earlier build would otherwise keep
// overriding the default list in the admin chat, so clear it.
bot.telegram
  .deleteMyCommands({ scope: { type: "chat", chat_id: ADMIN_ID } })
  .catch(() => {});

/*
|--------------------------------------------------------------------------
| START BOT
|--------------------------------------------------------------------------
| Every handler is registered before the bot connects, so the top-up
| provider and the startup recovery both run on a complete bot.
*/
let webhookHandle = null;
let transport = "polling";

async function startBot() {
  // The order store decides itself, and loading it has to finish before
  // recovery runs so recovery reads the same data the screens will.
  const store = await hydrateOrders();

  console.log(`[DB] Order store: ${store.mode} (${store.orders} order(s))`);

  try {
    await topupProvider.initialize();
  } catch (error) {
    console.error(
      "[TOPUP] Not available:",
      error.message
    );
    console.log(
      "[TOPUP] Approvals will be held for manual review"
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

  /*
  | Two ways to receive updates. With WEBHOOK_URL set, the platform's public
  | HTTPS URL is registered with Telegram and this process listens for the
  | pushes; that is what a sleeping-host platform needs. Without it the bot
  | polls, which is how it has always run and what local use and the tests
  | rely on.
  */
  if (webhookServer.shouldUseWebhook()) {
    const secretToken = webhookServer.secret();

    if (!secretToken) {
      // Not fatal, but the webhook URL would then be open to anyone who
      // learns it, and a forged update can approve an order.
      console.warn(
        "[WEBHOOK] WEBHOOK_SECRET is not set. Anyone who knows the URL " +
          "can post fake updates to this bot. Set it before going live."
      );
    }

    // Listen before registering: if the bind fails there is no point telling
    // Telegram to start sending updates at nothing.
    webhookHandle = await webhookServer.listen(bot);

    try {
      await webhookServer.register(bot);
    } catch (error) {
      await webhookServer.close(webhookHandle);
      webhookHandle = null;

      throw error;
    }

    // No polling is started in webhook mode, because bot.launch() is skipped
    // entirely. Deleting the webhook here would undo the registration above,
    // and Telegram would then deliver nothing at all.
    transport = "webhook";
  } else {
    await bot.launch();

    transport = "polling";
  }

  // Uptime starts when the bot can actually answer, not before, so the
  // number in the status panel describes serving time rather than boot time.
  botStatus.markBoot();

  console.log(
    `🚀 ${STORE_NAME} bot is running (${transport})...`
  );
}

// Tests require this file to reach the handlers, so only start when this
// file is the entry point.
if (require.main === module) {
  startBot();
}

module.exports = {
  bot,
  status: botStatus,
  webhookServer,
  topupProvider,
  processAutoTopup,
  resolveTopupOrder,
  recoverTopupStatus,
  runStartupRecovery,
  settleForReview,
  notifyAdminOfReview,
  reviewingOrders,
  reviewOrderMenu,
  getOrders,
  readOrders,
  mutateOrder,
  appendOrder,
  getOrder,
  getUserOrders,
  getOrdersByStatus,
  getPendingOrders,
  getOrderStats,
  describeOrderStore,
};

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
| The provider lookups are timers the shop scheduled itself, so they are
| cancelled on the way out rather than left to fire into a closing process.
*/

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await bot.stop(signal);
  } catch (error) {
    console.error("[SHUTDOWN] bot.stop failed:", error.message);
  }

  // Clear the webhook before the socket goes, so a redeploy does not leave
  // Telegram retrying a URL that is about to stop existing.
  if (webhookHandle) {
    await webhookServer.unregister(bot);
    await webhookServer.close(webhookHandle);
    webhookHandle = null;
  }

  // Pending provider lookups must not outlive the process.
  stopTopupResolutions();

  await topupProvider.shutdown();

  await closeOrderStore();

  // Orders left in topup_processing are recovered on the next startup.
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

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

/*
|--------------------------------------------------------------------------
| FALLBACK
|--------------------------------------------------------------------------
| Everything that reaches here was not claimed by an earlier handler. Without
| a fallback the bot stays silent, which reads as broken rather than as "I
| did not understand". Plain words map to the matching screen so a customer
| typing "hi" or "help" in the chat gets the same result as tapping a button.
*/

const TEXT_SHORTCUTS = {
  home: "home",
  menu: "home",
  start: "home",
  hi: "home",
  hello: "home",
  hey: "home",
  support: "support",
  help: "support",
  contact: "support",
  orders: "orders",
  myorders: "orders",
  myorder: "orders",
  cancel: "cancel",
  stop: "cancel",
  about: "about",
  games: "games",
};

// The admin commands are only useful to the admin, so they are only
// advertised to them. Every command here has a real handler.
const CUSTOMER_COMMANDS_TEXT = `/start · /games · /orders · /about · /support · /cancel`;
const ADMIN_COMMANDS_TEXT = `/admin · /review`;

function knownCommands(ctx) {
  return ctx.from.id === ADMIN_ID
    ? `${CUSTOMER_COMMANDS_TEXT} · ${ADMIN_COMMANDS_TEXT}`
    : CUSTOMER_COMMANDS_TEXT;
}

bot.on("text", async (ctx) => {
  // An admin mid-flow is typing into an admin flow, not chatting with the
  // store, so this must never answer them.
  if (ctx.from.id === ADMIN_ID && ctx.session?.adminFlow) {
    return;
  }

  // A mid-purchase session owns the next message, so only nudge instead of
  // drawing a menu that would hide what they are being asked for.
  if (ctx.session?.waitingForPlayerId) {
    return;
  }

  const raw = ctx.message.text.trim();

  // "/help@SomeBot" arrives with the bot username attached in groups.
  const isCommand = raw.startsWith("/");

  const word = (
    isCommand ? raw.slice(1).split("@")[0].split(" ")[0] : raw
  ).toLowerCase();

  const target = TEXT_SHORTCUTS[word];

  // A pending order still has to be paid, so nudge instead of drawing a menu.
  // An explicit "cancel" is honoured, otherwise the customer is stuck being
  // told to send a screenshot they no longer intend to send.
  if (ctx.session?.waitingForPayment && target !== "cancel") {
    const orderRef = ctx.session.orderId
      ? `Order ${code(ctx.session.orderId)} is waiting\nfor your payment proof.\n\n`
      : `Your order is waiting for your\npayment proof.\n\n`;

    return ctx.reply(
      `📸 *PAYMENT SCREENSHOT NEEDED*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        orderRef +
        `Send the screenshot as a photo here.\n` +
        `Any text will not be treated as payment.\n\n` +
        `_Type cancel to drop this order._`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("❌  CANCEL ORDER", "cancel_order")],
        ]),
      }
    );
  }

  if (target === "home") {
    ctx.session = {};

    return ctx.reply(UI.home, {
      parse_mode: "Markdown",
      ...replyMenu(),
    });
  }

  if (target === "support") {
    return ctx.reply(UI.support, {
      parse_mode: "Markdown",
      ...supportMenu(),
    });
  }

  if (target === "orders") {
    return sendMyOrders(ctx, false);
  }

  if (target === "games") {
    return showGames(ctx, false);
  }

  if (target === "about") {
    return showAbout(ctx);
  }

  if (target === "cancel") {
    ctx.session = {};

    return ctx.reply(
      `❌ Cancelled.

Nothing is saved. Tap below to start again.`,
      homeMenu()
    );
  }

  if (isCommand) {
    return ctx.reply(
      `🤔 *THAT IS NOT A COMMAND I KNOW*\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `\`/${esc(word)}\` is not something I understand.\n\n` +
        `These are the commands I can run:\n\n` +
        `${knownCommands(ctx)}\n\n` +
        `Or tap a button below to get going.`,
      {
        parse_mode: "Markdown",
        ...replyMenu(),
      }
    );
  }

  await ctx.reply(
    `👋 *I DID NOT UNDERSTAND THAT*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `I am a top-up bot, so I can only help with\n` +
      `these things:\n\n` +
      `🎮 Free Fire and Blood Strike top-ups\n` +
      `🆔 Checking a player ID\n` +
      `🧾 Order status and payment\n\n` +
      `Type *help* any time, or tap a button below.`,
    {
      parse_mode: "Markdown",
      ...replyMenu(),
    }
  );
});
