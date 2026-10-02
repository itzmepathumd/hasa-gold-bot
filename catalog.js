const fs = require("fs");
const crypto = require("crypto");

const CATALOG_FILE = "./catalog.json";

/*
|--------------------------------------------------------------------------
| DEFAULT CATALOG
|--------------------------------------------------------------------------
| Seeded once so an existing install keeps its current products and
| payment details after upgrading.
*/
const DEFAULT_CATALOG = {
  version: 1,
  games: [
    {
      id: "blood_strike",
      name: "Blood Strike",
      emoji: "🎮",
      paused: false,
      idLabel: "Player ID",
      idExample: "123456789",
      packages: [
        {
          id: "elite",
          name: "🎫 Strike Pass Elite",
          price: 1100,
          paused: false,
          note: "",
          sub_category_id: 999,
          requirements: [],
        },
        {
          id: "premium",
          name: "👑 Strike Pass Premium",
          price: 2500,
          paused: false,
          note: "",
          sub_category_id: 1000,
          requirements: [],
        },
        {
          id: "levelup",
          name: "🚀 Level Up Pass",
          price: 600,
          paused: false,
          note: "",
          sub_category_id: 1001,
          requirements: [],
        },
        {
          id: "gold100",
          name: "💎 100 Gold",
          price: 290,
          paused: false,
          note: "",
          sub_category_id: 1002,
          requirements: [],
        },
        {
          id: "gold300",
          name: "💎 300 Gold",
          price: 850,
          paused: false,
          note: "",
          sub_category_id: 1003,
          requirements: [],
        },
        {
          id: "gold500",
          name: "💎 500 Gold",
          price: 1350,
          paused: false,
          note: "",
          sub_category_id: 1004,
          requirements: [],
        },
        {
          id: "gold1000",
          name: "💎 1,000 Gold",
          price: 2700,
          paused: false,
          note: "",
          sub_category_id: 1005,
          requirements: [],
        },
        {
          id: "gold2000",
          name: "💎 2,000 Gold",
          price: 5300,
          paused: false,
          note: "",
          sub_category_id: 1006,
          requirements: [],
        },
      ],
    },
  ],

  payments: [
    {
      id: "bank",
      emoji: "🏦",
      title: "Bank Transfer",
      paused: false,
      lines: [
        "🏦 Bank: Commercial Bank",
        "🔢 Account: 12345678",
        "📍 Branch: Matara",
        "👤 Name: Pathum",
      ],
    },
    {
      id: "ezcash",
      emoji: "📱",
      title: "EZ Cash",
      paused: false,
      lines: ["📱 Number: 077 535 2074", "👤 Name: Pathum"],
    },
  ],
};

/*
|--------------------------------------------------------------------------
| LOW LEVEL IO
|--------------------------------------------------------------------------
*/
function readCatalog() {
  if (!fs.existsSync(CATALOG_FILE)) {
    saveCatalog(DEFAULT_CATALOG);
    return structuredClone(DEFAULT_CATALOG);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));

    return {
      version: parsed.version || 1,
      games: Array.isArray(parsed.games) ? parsed.games : [],
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
    };
  } catch {
    console.error("⚠️ catalog.json unreadable, using defaults");
    return structuredClone(DEFAULT_CATALOG);
  }
}

function saveCatalog(catalog) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

function update(mutator) {
  const catalog = readCatalog();
  const result = mutator(catalog);
  saveCatalog(catalog);
  return result;
}

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/
function shortId(prefix) {
  return `${prefix}_${crypto.randomBytes(3).toString("hex")}`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function uniqueId(base, taken) {
  let id = base || "item";

  while (taken.includes(id)) {
    id = `${base}_${crypto.randomBytes(1).toString("hex")}`;
  }

  return id;
}

function formatPrice(price) {
  return Number(price || 0).toLocaleString("en-US");
}

/*
|--------------------------------------------------------------------------
| GAME QUERIES
|--------------------------------------------------------------------------
*/
function getGames({ includePaused = true } = {}) {
  const catalog = readCatalog();

  return includePaused
    ? catalog.games
    : catalog.games.filter((g) => !g.paused);
}

function getGame(gameId) {
  return readCatalog().games.find((g) => g.id === gameId) || null;
}

function getPackages(gameId, { includePaused = true } = {}) {
  const game = getGame(gameId);

  if (!game) return [];

  return includePaused
    ? game.packages
    : game.packages.filter((p) => !p.paused);
}

function findPackage(gameId, packageId) {
  const game = getGame(gameId);

  if (!game) return null;

  const pkg = game.packages.find((p) => p.id === packageId);

  return pkg ? { game, pkg } : null;
}

function isOrderable(gameId, packageId) {
  const found = findPackage(gameId, packageId);

  return Boolean(found && !found.game.paused && !found.pkg.paused);
}

function activeGames() {
  return getGames({ includePaused: false }).filter(
    (g) => g.packages.some((p) => !p.paused)
  );
}

/*
|--------------------------------------------------------------------------
| GAME MUTATIONS
|--------------------------------------------------------------------------
*/
function addGame({ name, emoji = "🎮", idLabel = "Player ID", idExample = "123456789" }) {
  return update((catalog) => {
    const id = uniqueId(
      slugify(name),
      catalog.games.map((g) => g.id)
    );

    const game = {
      id,
      name: String(name).trim(),
      emoji: String(emoji || "🎮").trim() || "🎮",
      paused: false,
      idLabel: String(idLabel || "Player ID").trim() || "Player ID",
      idExample: String(idExample || "123456789").trim() || "123456789",
      packages: [],
    };

    catalog.games.push(game);

    return game;
  });
}

function updateGame(gameId, patch) {
  return update((catalog) => {
    const game = catalog.games.find((g) => g.id === gameId);

    if (!game) return null;

    if (patch.name !== undefined) game.name = String(patch.name).trim();
    if (patch.emoji !== undefined) game.emoji = String(patch.emoji).trim() || game.emoji;
    if (patch.idLabel !== undefined) game.idLabel = String(patch.idLabel).trim() || game.idLabel;
    if (patch.idExample !== undefined) game.idExample = String(patch.idExample).trim() || game.idExample;
    if (patch.paused !== undefined) game.paused = Boolean(patch.paused);

    return game;
  });
}

function deleteGame(gameId) {
  update((catalog) => {
    catalog.games = catalog.games.filter((g) => g.id !== gameId);
  });
}

function toggleGame(gameId) {
  const game = getGame(gameId);

  if (!game) return null;

  return updateGame(gameId, { paused: !game.paused });
}

/*
|--------------------------------------------------------------------------
| PACKAGE MUTATIONS
|--------------------------------------------------------------------------
*/
function addPackage(gameId, { name, price, note = "", sub_category_id, requirements = [] }) {
  return update((catalog) => {
    const game = catalog.games.find((g) => g.id === gameId);

    if (!game) return null;

    const pkg = {
      id: uniqueId(
        slugify(name),
        game.packages.map((p) => p.id)
      ),
      name: String(name).trim(),
      price: Number(price),
      paused: false,
      note: String(note || "").trim(),
      sub_category_id: sub_category_id ? Number(sub_category_id) : null,
      requirements: Array.isArray(requirements) ? requirements : [],
    };

    game.packages.push(pkg);

    return pkg;
  });
}

function updatePackage(gameId, packageId, patch) {
  return update((catalog) => {
    const game = catalog.games.find((g) => g.id === gameId);

    if (!game) return null;

    const pkg = game.packages.find((p) => p.id === packageId);

    if (!pkg) return null;

    if (patch.name !== undefined) pkg.name = String(patch.name).trim();
    if (patch.price !== undefined) pkg.price = Number(patch.price);
    if (patch.note !== undefined) pkg.note = String(patch.note).trim();
    if (patch.paused !== undefined) pkg.paused = Boolean(patch.paused);
    if (patch.sub_category_id !== undefined) pkg.sub_category_id = patch.sub_category_id ? Number(patch.sub_category_id) : null;
    if (patch.requirements !== undefined) pkg.requirements = Array.isArray(patch.requirements) ? patch.requirements : [];

    return pkg;
  });
}

function deletePackage(gameId, packageId) {
  update((catalog) => {
    const game = catalog.games.find((g) => g.id === gameId);

    if (game) {
      game.packages = game.packages.filter((p) => p.id !== packageId);
    }
  });
}

function togglePackage(gameId, packageId) {
  const found = findPackage(gameId, packageId);

  if (!found) return null;

  return updatePackage(gameId, packageId, { paused: !found.pkg.paused });
}

/*
|--------------------------------------------------------------------------
| PAYMENT METHODS
|--------------------------------------------------------------------------
*/
function getPayments({ includePaused = true } = {}) {
  const catalog = readCatalog();

  return includePaused
    ? catalog.payments
    : catalog.payments.filter((p) => !p.paused);
}

function getPayment(paymentId) {
  return readCatalog().payments.find((p) => p.id === paymentId) || null;
}

function addPayment({ title, emoji = "💳", lines = [] }) {
  return update((catalog) => {
    const payment = {
      id: uniqueId(
        slugify(title),
        catalog.payments.map((p) => p.id)
      ),
      title: String(title).trim(),
      emoji: String(emoji || "💳").trim() || "💳",
      paused: false,
      lines: (Array.isArray(lines) ? lines : [])
        .map((l) => String(l).trim())
        .filter(Boolean),
    };

    catalog.payments.push(payment);

    return payment;
  });
}

function updatePayment(paymentId, patch) {
  return update((catalog) => {
    const payment = catalog.payments.find((p) => p.id === paymentId);

    if (!payment) return null;

    if (patch.title !== undefined) payment.title = String(patch.title).trim();
    if (patch.emoji !== undefined) payment.emoji = String(patch.emoji).trim() || payment.emoji;
    if (patch.paused !== undefined) payment.paused = Boolean(patch.paused);
    if (patch.lines !== undefined) {
      payment.lines = (Array.isArray(patch.lines) ? patch.lines : [])
        .map((l) => String(l).trim())
        .filter(Boolean);
    }

    return payment;
  });
}

function togglePayment(paymentId) {
  const payment = getPayment(paymentId);

  if (!payment) return null;

  return update((catalog) => {
    const target = catalog.payments.find((p) => p.id === paymentId);

    target.paused = !target.paused;

    return target;
  });
}

function deletePayment(paymentId) {
  update((catalog) => {
    catalog.payments = catalog.payments.filter((p) => p.id !== paymentId);
  });
}

module.exports = {
  DEFAULT_CATALOG,
  readCatalog,
  saveCatalog,
  shortId,
  formatPrice,
  getGames,
  getGame,
  getPackages,
  findPackage,
  isOrderable,
  activeGames,
  addGame,
  updateGame,
  deleteGame,
  toggleGame,
  addPackage,
  updatePackage,
  deletePackage,
  togglePackage,
  getPayments,
  getPayment,
  addPayment,
  updatePayment,
  togglePayment,
  deletePayment,
};
