require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const fs = require("fs");
const crypto = require("crypto");
const catalog = require("./catalog");

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

bot.use(session({ defaultSession: () => ({}) }));

bot.use(async (ctx, next) => {
  console.log(
    "📩 UPDATE:",
    ctx.from?.id,
    ctx.message?.text || ctx.callbackQuery?.data || "other"
  );

  await next();
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

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, "[]");
}

function getOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(
    ORDERS_FILE,
    JSON.stringify(orders, null, 2)
  );
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
  pending_payment: { label: "🕒 Awaiting Payment", icon: "🕒" },
  pending_approval: { label: "🔍 Verifying Proof", icon: "🔍" },
  approved: { label: "✅ Approved", icon: "✅" },
  rejected: { label: "❌ Rejected", icon: "❌" },
};

function statusBadge(status) {
  const meta = STATUS_META[status] || {
    label: "📌 " + status,
    icon: "📌",
  };

  return `${meta.icon} ${meta.label}`;
}

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
    ["🏠  Home"],
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
};

function homeMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(LABEL.games, "games")],
    [
      Markup.button.callback(LABEL.myOrders, "my_orders"),
      Markup.button.callback(LABEL.support, "support"),
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
  ]);
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

/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/
bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();

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
    return ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...gamesMenu(),
    });
  }

  return ctx.reply(text, {
    parse_mode: "Markdown",
    ...gamesMenu(),
  });
}

bot.action("games", async (ctx) => {
  await ctx.answerCbQuery();

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

  await ctx.answerCbQuery();

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

  await ctx.answerCbQuery();

  const { game, pkg } = found;

  ctx.session.gameId = game.id;
  ctx.session.packageId = pkg.id;
  ctx.session.selectedProduct = pkg.id;
  ctx.session.waitingForPlayerId = true;

  await ctx.reply(
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
          Markup.button.callback(
            LABEL.products,
            `game_${game.id}`
          ),
        ],
        [Markup.button.callback(LABEL.cancel, "cancel_order")],
      ]),
    }
  );
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.editMessageText(UI.support, {
    parse_mode: "Markdown",
    ...supportMenu(),
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

  if (flow.step === "game_name") {
    ctx.session.adminFlow = { step: "game_emoji", gameName: text };

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

    ctx.session.adminFlow = {
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

    ctx.session.adminFlow = null;

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
    ctx.session.adminFlow = {
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

    const pkg = catalog.addPackage(flow.gameId, {
      name: flow.packageName,
      price,
    });

    const game = getGame(flow.gameId);

    ctx.session.adminFlow = null;

    return ctx.reply(
      `✅ *${esc(pkg.name)}* added!\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 LKR ${catalog.formatPrice(pkg.price)}\n\n` +
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

    ctx.session.adminFlow = null;

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

    ctx.session.adminFlow = null;

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
    ctx.session.adminFlow = {
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

      ctx.session.adminFlow = null;

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

    ctx.session.adminFlow.buffer = [
      ...(flow.buffer || []),
      text,
    ];

    return ctx.reply(
      `✅ Added: \`${esc(text)}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `${ctx.session.adminFlow.buffer
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

    ctx.session.adminFlow = null;

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

  ctx.session.adminFlow = null;

  return next();
});

bot.action("flow_cancel", async (ctx) => {
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  ctx.session.adminFlow = null;

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

  const gameId = ctx.session.gameId;
  const packageId = ctx.session.packageId;

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

  ctx.session.playerId = playerId;
  ctx.session.waitingForPlayerId = false;

  await ctx.reply(
    `🧾 *ORDER CONFIRMATION*\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🎮 *GAME*\n${game.name}\n\n` +
      `📦 *PACKAGE*\n${pkg.name}\n\n` +
      `🆔 *${game.idLabel.toUpperCase()}*\n\`${playerId}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 *TOTAL*\nLKR ${catalog.formatPrice(pkg.price)}\n\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Please check your ${game.idLabel}\n` +
      `and package before confirming.\n\n` +
      `👇 *Ready to place your order?*`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            LABEL.confirm,
            "confirm_order"
          ),
        ],
        [
          Markup.button.callback(
            LABEL.cancel,
            "cancel_order"
          ),
        ],
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
  await ctx.answerCbQuery();

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

  const order = {
    id: generateOrderId(),

    userId: ctx.from.id,

    username: ctx.from.username || null,

    firstName: ctx.from.first_name || "",

    playerId: playerId,

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
  };

  const orders = getOrders();

  orders.push(order);

  saveOrders(orders);

  ctx.session.orderId = order.id;
  ctx.session.waitingForPayment = true;

  await ctx.reply(
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
          Markup.button.callback(
            "📸  I HAVE PAID",
            "payment_done"
          ),
        ],
        [
          Markup.button.callback(
            "❌  CANCEL ORDER",
            "cancel_order"
          ),
        ],
      ]),
    }
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
  await ctx.answerCbQuery();

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

  order.paymentProof = largestPhoto.file_id;

  order.status = "pending_approval";

  order.paymentSubmittedAt =
    new Date().toISOString();

  saveOrders(orders);

  ctx.session.waitingForPayment = false;
              await ctx.reply(
  `📸 *PAYMENT PROOF RECEIVED*

━━━━━━━━━━━━━━━━━━

🧾 *ORDER ID*
${esc(order.id)}

🎮 *GAME*
${esc(order.gameName || "Blood Strike")}

📦 *PRODUCT*
${esc(order.productName)}

💰 *AMOUNT*
LKR ${order.price.toLocaleString()}

━━━━━━━━━━━━━━━━━━

⏳ *STATUS*
Pending Admin Approval

🔐 Your payment screenshot has been
received successfully.

⚡ Please wait while our team verifies
your payment.

📩 You will receive a notification
once your order has been reviewed.

━━━━━━━━━━━━━━━━━━

✨ *HASA GOLD STORE*`,
  {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "📦 My Orders",
          "my_orders"
        ),
      ],
      [
        Markup.button.callback(
          "🏠 Home",
          "home"
        ),
      ],
    ]),
  }
);

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
| APPROVE ORDER
|--------------------------------------------------------------------------
*/

bot.action(/^approve_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply(
      "⛔ You are not authorized to approve orders."
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

  order.status = "approved";

  order.approvedAt =
    new Date().toISOString();

  saveOrders(orders);

  await ctx.editMessageCaption(
    `✅ ORDER APPROVED

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
✅ APPROVED`
  );

  await bot.telegram.sendMessage(
    order.userId,

    `✅ PAYMENT APPROVED!

🧾 Order:
${esc(order.id)}

🎮 ${esc(order.gameName || "Blood Strike")}

📦 Product:
${esc(order.productName)}

🆔 Player ID:
${esc(order.playerId)}

💰 Amount:
LKR ${order.price.toLocaleString()}

━━━━━━━━━━━━━━

✅ Your payment has been approved.

🚀 Your top-up will now be processed.

Thank you for using ${STORE_NAME}!`
  );
});

/*
|--------------------------------------------------------------------------
| REJECT ORDER
|--------------------------------------------------------------------------
*/

bot.action(/^reject_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

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

  order.status = "rejected";

  order.rejectedAt =
    new Date().toISOString();

  saveOrders(orders);

  await ctx.editMessageCaption(
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

  await bot.telegram.sendMessage(
    order.userId,

    `❌ PAYMENT REJECTED

🧾 Order:
${esc(order.id)}

📦 Product:
${esc(order.productName)}

Your payment proof was not approved.

If you believe this was a mistake, please contact ${STORE_NAME}.`
  );
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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  if (ctx.match[1] === "new") {
    ctx.session.adminFlow = { step: "payment_title" };

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  ctx.session.adminFlow = {
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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const payment = catalog.getPayment(ctx.match[1]);

  if (!payment) {
    return ctx.reply("❌ Payment method not found.");
  }

  ctx.session.adminFlow = {
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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  ctx.session.adminFlow = { step: "game_name" };

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ctx.session.pendingDelete = { type: "game", id: game.id };

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const orders = getOrders();

  const approved = orders.filter(
    (o) => o.status === "approved"
  );

  const pending = orders.filter(
    (o) => o.status === "pending_approval"
  );

  const waiting = orders.filter(
    (o) => o.status === "pending_payment"
  );

  const rejected = orders.filter(
    (o) => o.status === "rejected"
  );

  const revenue = approved.reduce(
    (total, order) =>
      total + Number(order.price || 0),
    0
  );

  await ctx.editMessageText(
    `📊 SALES STATISTICS

🧾 Total Orders:
${orders.length}

━━━━━━━━━━━━━━

✅ Approved:
${approved.length}

💰 Approved Revenue:
LKR ${revenue.toLocaleString()}

🔍 Pending Approval:
${pending.length}

⏳ Awaiting Payment:
${waiting.length}

❌ Rejected:
${rejected.length}`,

    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙 Admin Panel",
          "admin_home"
        ),
      ],
    ])
  );
});


/*
|--------------------------------------------------------------------------
| ADMIN HOME
|--------------------------------------------------------------------------
*/

bot.action("admin_home", async (ctx) => {
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  await ctx.editMessageText(
    `👑 ${STORE_NAME}

🛠️ ADMIN PANEL

Select an option below:`,

    adminMenu()
  );
});

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

bot.catch((error) => {
  console.error(
    "❌ BOT ERROR:",
    error
  );
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
    command: "admin",
    description: "👑 Admin panel",
  },
]);
/*
|--------------------------------------------------------------------------
| START BOT
|--------------------------------------------------------------------------
*/

bot.launch();

console.log(
  `🚀 ${STORE_NAME} bot is running...`
);

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
  await ctx.answerCbQuery();

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

  ctx.session.adminFlow = { step: "game_idlabel", gameId: game.id };
});

bot.action(/^sagee_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ctx.session.adminFlow = { step: "game_emoji_existing", gameId: game.id };

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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const game = getGame(ctx.match[1]);

  if (!game) {
    return ctx.reply("❌ Game not found.");
  }

  ctx.session.adminFlow = {
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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  ctx.session.adminFlow = {
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
  await ctx.answerCbQuery();

  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  const found = catalog.findPackage(ctx.match[1], ctx.match[2]);

  if (!found) {
    return ctx.reply("❌ Package not found.");
  }

  ctx.session.adminFlow = {
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
