require("dotenv").config();

const { Telegraf, Markup, session } = require("telegraf");
const fs = require("fs");
const crypto = require("crypto");

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

bot.use(session());

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
| PAYMENT DETAILS
|--------------------------------------------------------------------------
| Change these whenever needed.
*/

const PAYMENT = {
  bank: "Commercial Bank",
  account: "12345678",
  branch: "Matara",
  ezcash: "077 535 2074",
  name: "Pathum",
};

/*
|--------------------------------------------------------------------------
| BLOOD STRIKE PRODUCTS
|--------------------------------------------------------------------------
*/

const PRODUCTS = {
  elite: {
    name: "🎫 Strike Pass Elite",
    price: 1100,
  },

  premium: {
    name: "👑 Strike Pass Premium",
    price: 2500,
  },

  levelup: {
    name: "🚀 Level Up Pass",
    price: 600,
  },

  gold100: {
    name: "💎 100 Gold",
    price: 290,
  },

  gold300: {
    name: "💎 300 Gold",
    price: 850,
  },

  gold500: {
    name: "💎 500 Gold",
    price: 1350,
  },

  gold1000: {
    name: "💎 1,000 Gold",
    price: 2700,
  },

  gold2000: {
    name: "💎 2,000 Gold",
    price: 5300,
  },
};

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
| MAIN MENU
|--------------------------------------------------------------------------
*/
function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🎮  BLOOD STRIKE",
        "blood_strike"
      ),
    ],
    [
      Markup.button.callback(
        "📦  MY ORDERS",
        "my_orders"
      ),
    ],
    [
      Markup.button.callback(
        "💬  SUPPORT",
        "support"
      ),
    ],
  ]);
}
function replyMenu() {
  return Markup.keyboard([
    [
      "🎮 Blood Strike",
      "📦 My Orders",
    ],
    [
      "💬 Support",
      "🏠 Home",
    ],
  ]).resize();
}
/*
|--------------------------------------------------------------------------
| PRODUCT MENU
|--------------------------------------------------------------------------
*/
function productMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🎫 Strike Pass Elite",
        "product_elite"
      ),
    ],
    [
      Markup.button.callback(
        "👑 Strike Pass Premium",
        "product_premium"
      ),
    ],
    [
      Markup.button.callback(
        "🚀 Level Up Pass",
        "product_levelup"
      ),
    ],
    [
      Markup.button.callback(
        "💎 100 Gold",
        "product_gold100"
      ),
      Markup.button.callback(
        "💎 300 Gold",
        "product_gold300"
      ),
    ],
    [
      Markup.button.callback(
        "💎 500 Gold",
        "product_gold500"
      ),
      Markup.button.callback(
        "💎 1,000 Gold",
        "product_gold1000"
      ),
    ],
    [
      Markup.button.callback(
        "💎 2,000 Gold",
        "product_gold2000"
      ),
    ],
    [
      Markup.button.callback(
        "🏠 Home",
        "home"
      ),
    ],
  ]);
}

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/
bot.start(async (ctx) => {
  ctx.session = {};

  await ctx.reply(
    `✨ *WELCOME TO ${STORE_NAME}* ✨

🎮 *Blood Strike Top-Up Store*

Fast • Secure • Reliable

━━━━━━━━━━━━━━━━━━

💎 Gold
🎫 Strike Pass
🚀 Level Up Pass

━━━━━━━━━━━━━━━━━━

👇 *Choose an option below:*`,
    {
      parse_mode: "Markdown",
      ...replyMenu(),
    }
  );
});
bot.command("orders", async (ctx) => {
  const userId = ctx.from.id;

  const orders = getOrders().filter(
    (order) => order.userId === userId
  );

  if (orders.length === 0) {
    return ctx.reply(
      `📦 MY ORDERS

━━━━━━━━━━━━━━━━━━

You don't have any orders yet.

🎮 Choose a product and place
your first Blood Strike top-up!`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🎮 Blood Strike",
            "blood_strike"
          ),
        ],
        [
          Markup.button.callback(
            "🏠 Home",
            "home"
          ),
        ],
      ])
    );
  }

  let message =
    `📦 MY ORDERS\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  orders
    .slice()
    .reverse()
    .slice(0, 10)
    .forEach((order) => {
      message +=
        `🧾 ${order.id}\n` +
        `📦 ${order.productName}\n` +
        `🆔 Player ID: ${order.playerId}\n` +
        `💰 LKR ${Number(order.price).toLocaleString()}\n` +
        `📌 ${order.status}\n\n`;
    });

  await ctx.reply(
    message,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🎮 New Order",
          "blood_strike"
        ),
      ],
      [
        Markup.button.callback(
          "🏠 Home",
          "home"
        ),
      ],
    ])
  );
});
/*
|--------------------------------------------------------------------------
| HOME
|--------------------------------------------------------------------------
*/
bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();

  ctx.session = {};

  await ctx.editMessageText(
    `✨ *WELCOME TO ${STORE_NAME}* ✨

🎮 *Blood Strike Top-Up Store*

Fast • Secure • Reliable

━━━━━━━━━━━━━━━━━━

💎 Gold
🎫 Strike Pass
🚀 Level Up Pass

━━━━━━━━━━━━━━━━━━

👇 *Choose an option below:*`,
    {
      parse_mode: "Markdown",
      ...mainMenu(),
    }
  );
});

/*
|--------------------------------------------------------------------------
| BLOOD STRIKE
|--------------------------------------------------------------------------
*/
bot.action("blood_strike", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `🎮 *BLOOD STRIKE*

💎 *SELECT YOUR PRODUCT*

━━━━━━━━━━━━━━━━━━

🎫 Strike Pass
🚀 Level Up Pass
💎 Gold Top-Up

⚡ Fast order processing
🔐 Secure payment verification`,
    {
      parse_mode: "Markdown",
      ...productMenu(),
    }
  );
});
bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `💬 *CUSTOMER SUPPORT*

━━━━━━━━━━━━━━━━━━

Need help with an order?

🧾 Please send your Order ID
when contacting support.

📩 *HASA GOLD STORE*

━━━━━━━━━━━━━━━━━━

We can help with:

💳 Payment issues
📦 Order problems
🎮 Top-up questions
❓ Other store questions`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🏠 Home",
            "home"
          ),
        ],
      ]),
    }
  );
});
/*
|--------------------------------------------------------------------------
| PRODUCT SELECTION
|--------------------------------------------------------------------------
*/
for (const key of Object.keys(PRODUCTS)) {
  bot.action(`product_${key}`, async (ctx) => {
    await ctx.answerCbQuery();

    const product = PRODUCTS[key];

    ctx.session.selectedProduct = key;
    ctx.session.waitingForPlayerId = true;

    await ctx.reply(
      `✨ *${product.name}*

━━━━━━━━━━━━━━━━━━

💰 *PRICE*
LKR ${product.price.toLocaleString()}

⚡ Fast Processing
🔐 Secure Payment Verification
🎮 Blood Strike Top-Up

━━━━━━━━━━━━━━━━━━

🆔 *PLAYER ID*

Please send your Blood Strike
Player ID below.

Example:
123456789`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔙 Products",
              "blood_strike"
            ),
          ],
        ]),
      }
    );
  });
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

  if (!ctx.session?.waitingForPlayerId) {
    return;
  }

  const playerId = text;

  if (!/^[0-9]{5,20}$/.test(playerId)) {
    return ctx.reply(
      `❌ Invalid Player ID.

Please send only the numbers of your Blood Strike Player ID.

Example:

123456789`
    );
  }

  const productKey = ctx.session.selectedProduct;
  const product = PRODUCTS[productKey];

  if (!product) {
    ctx.session = {};

    return ctx.reply(
      "❌ Product session expired. Please start again.",
      mainMenu()
    );
  }

  ctx.session.playerId = playerId;
  ctx.session.waitingForPlayerId = false;
               await ctx.reply(
  `🧾 *ORDER CONFIRMATION*

━━━━━━━━━━━━━━━━━━

🎮 *GAME*
Blood Strike

📦 *PRODUCT*
${product.name}

🆔 *PLAYER ID*
${playerId}

━━━━━━━━━━━━━━━━━━

💰 *TOTAL*
LKR ${product.price.toLocaleString()}

━━━━━━━━━━━━━━━━━━

⚠️ Please check your Player ID
and product before confirming.

👇 *Ready to place your order?*`,
  {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✅ Confirm Order",
          "confirm_order"
        ),
      ],
      [
        Markup.button.callback(
          "❌ Cancel",
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

  const productKey = ctx.session?.selectedProduct;
  const playerId = ctx.session?.playerId;

  if (!productKey || !playerId) {
    return ctx.reply(
      "❌ Your order session expired.\n\nPlease start a new order.",
      mainMenu()
    );
  }

  const product = PRODUCTS[productKey];

  if (!product) {
    ctx.session = {};

    return ctx.reply(
      "❌ Product not found.",
      mainMenu()
    );
  }

  const order = {
    id: generateOrderId(),

    userId: ctx.from.id,

    username: ctx.from.username || null,

    firstName: ctx.from.first_name || "",

    playerId: playerId,

    productKey: productKey,

    productName: product.name,

    price: product.price,

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
  `💳 *PAYMENT REQUIRED*

━━━━━━━━━━━━━━━━━━

🧾 *ORDER ID*
${order.id}

🎮 *GAME*
Blood Strike

📦 *PRODUCT*
${order.productName}

🆔 *PLAYER ID*
${order.playerId}

💰 *TOTAL*
LKR ${order.price.toLocaleString()}

━━━━━━━━━━━━━━━━━━

🏦 *BANK TRANSFER*

🏦 Bank
${PAYMENT.bank}

🔢 Account
${PAYMENT.account}

📍 Branch
${PAYMENT.branch}

👤 Account Name
${PAYMENT.name}

━━━━━━━━━━━━━━━━━━

💸 *EZ CASH*
📱 ${PAYMENT.ezcash}

━━━━━━━━━━━━━━━━━━

📸 *PAYMENT PROOF*

After making the payment, send your
payment screenshot here.

⚡ Your order will be processed after
admin verification.

🔐 *HASA GOLD STORE*`,
  {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "❌ Cancel Order",
          "cancel_order"
        ),
      ],
    ]),
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
    mainMenu()
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

Current status:
${order.status}`
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
${order.id}

🎮 *GAME*
Blood Strike

📦 *PRODUCT*
${order.productName}

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
${order.id}

🎮 Game:
Blood Strike

📦 Product:
${order.productName}

🆔 Player ID:
${order.playerId}

💰 Amount:
LKR ${order.price.toLocaleString()}

👤 Customer:
${order.firstName}

${
  order.username
    ? `📱 Username: @${order.username}`
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

Current status:
${order.status}`
    );
  }

  order.status = "approved";

  order.approvedAt =
    new Date().toISOString();

  saveOrders(orders);

  await ctx.editMessageCaption(
    `✅ ORDER APPROVED

🧾 Order:
${order.id}

🎮 Blood Strike

📦 Product:
${order.productName}

🆔 Player ID:
${order.playerId}

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
${order.id}

🎮 Blood Strike

📦 Product:
${order.productName}

🆔 Player ID:
${order.playerId}

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

Current status:
${order.status}`
    );
  }

  order.status = "rejected";

  order.rejectedAt =
    new Date().toISOString();

  saveOrders(orders);

  await ctx.editMessageCaption(
    `❌ ORDER REJECTED

🧾 Order:
${order.id}

🎮 Blood Strike

📦 Product:
${order.productName}

🆔 Player ID:
${order.playerId}

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
${order.id}

📦 Product:
${order.productName}

Your payment proof was not approved.

If you believe this was a mistake, please contact ${STORE_NAME}.`
  );
});

/*
|--------------------------------------------------------------------------
| MY ORDERS
|--------------------------------------------------------------------------
*/
bot.action("my_orders", async (ctx) => {
  await ctx.answerCbQuery();

  const orders = getOrders().filter(
    (order) => order.userId === ctx.from.id
  );

  if (orders.length === 0) {
    return ctx.editMessageText(
      `📦 *MY ORDERS*

━━━━━━━━━━━━━━━━━━

You don't have any orders yet.

🎮 Choose a product and place
your first Blood Strike top-up!`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🎮 Blood Strike",
              "blood_strike"
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
  }

  const latest = orders
    .slice()
    .reverse()
    .slice(0, 10);

  let message =
    `📦 *MY ORDERS*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n`;

  for (const order of latest) {
    message +=
      `🧾 *${order.id}*\n` +
      `📦 ${order.productName}\n` +
      `🆔 Player ID: ${order.playerId}\n` +
      `💰 LKR ${Number(order.price).toLocaleString()}\n` +
      `📌 ${order.status}\n\n`;
  }

  await ctx.editMessageText(message, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🎮 New Order",
          "blood_strike"
        ),
      ],
      [
        Markup.button.callback(
          "🏠 Home",
          "home"
        ),
      ],
    ]),
  });
});

/*
|--------------------------------------------------------------------------
| ADMIN COMMAND
|--------------------------------------------------------------------------
*/
/*
|--------------------------------------------------------------------------
| ADMIN PANEL
|--------------------------------------------------------------------------
*/

function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔍 Pending Orders",
        "admin_pending"
      ),
    ],
    [
      Markup.button.callback(
        "📦 All Orders",
        "admin_all_orders"
      ),
    ],
    [
      Markup.button.callback(
        "📊 Sales Statistics",
        "admin_stats"
      ),
    ],
  ]);
}


/*
|--------------------------------------------------------------------------
| ADMIN COMMAND
|--------------------------------------------------------------------------
*/

bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("⛔ Admin access only.");
  }

  await ctx.reply(
    `👑 ${STORE_NAME}

🛠️ ADMIN PANEL

Select an option below:`,
    adminMenu()
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
      `🔍 PENDING ORDERS

✅ There are no orders waiting for approval.`,
      adminMenu()
    );
  }

  let message = "🔍 PENDING ORDERS\n\n";

  for (const order of pending.slice(0, 10)) {
    message +=
      `🧾 ${order.id}\n` +
      `📦 ${order.productName}\n` +
      `🆔 ${order.playerId}\n` +
      `💰 LKR ${order.price.toLocaleString()}\n\n`;
  }

  const buttons = pending
    .slice(0, 10)
    .map((order) => [
      Markup.button.callback(
        `👁️ ${order.id}`,
        `admin_order_${order.id}`
      ),
    ]);

  buttons.push([
    Markup.button.callback(
      "🔙 Admin Panel",
      "admin_home"
    ),
  ]);

  await ctx.editMessageText(
    message,
    Markup.inlineKeyboard(buttons)
  );
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
    ? `@${order.username}`
    : order.firstName || "Unknown";

  const message =
    `🧾 ORDER DETAILS\n\n` +
    `🆔 Order ID:\n${order.id}\n\n` +
    `🎮 Game:\nBlood Strike\n\n` +
    `📦 Product:\n${order.productName}\n\n` +
    `🆔 Player ID:\n${order.playerId}\n\n` +
    `💰 Amount:\nLKR ${order.price.toLocaleString()}\n\n` +
    `👤 Customer:\n${customer}\n\n` +
    `📌 Status:\n${order.status}`;

  const buttons = [];

  if (order.status === "pending_approval") {
    buttons.push([
      Markup.button.callback(
        "📸 View Payment Proof",
        `admin_proof_${order.id}`
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        "✅ APPROVE",
        `approve_${order.id}`
      ),
      Markup.button.callback(
        "❌ REJECT",
        `reject_${order.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "🔙 Pending Orders",
      "admin_pending"
    ),
  ]);

  await ctx.editMessageText(
    message,
    Markup.inlineKeyboard(buttons)
  );
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
        `🧾 ${order.id}\n` +
        `📦 ${order.productName}\n` +
        `💰 LKR ${order.price.toLocaleString()}`,

      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ APPROVE",
            `approve_${order.id}`
          ),
          Markup.button.callback(
            "❌ REJECT",
            `reject_${order.id}`
          ),
        ],
        [
          Markup.button.callback(
            "🔙 Order Details",
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

  let message = "📦 ALL ORDERS\n\n";

  for (const order of latest) {
    message +=
      `🧾 ${order.id}\n` +
      `📦 ${order.productName}\n` +
      `💰 LKR ${order.price.toLocaleString()}\n` +
      `📌 ${order.status}\n\n`;
  }

  await ctx.editMessageText(
    message,
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
