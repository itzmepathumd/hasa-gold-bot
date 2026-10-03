/*
|--------------------------------------------------------------------------
| PRODUCT CATALOGUE
|--------------------------------------------------------------------------
| The store catalogue as documents in the `products` collection.
|
| Document ids are the callback string itself, for example
| products/blood_strike~elite. Package ids are only unique inside a game, so
| a bare package id would collide, and reusing the exact string the buttons
| already send means every existing callback keeps working after the move.
|
| Game-level fields are copied onto each product document. A store this size
| reads the whole catalogue on every screen, so denormalising the game name
| and id label avoids a second read per lookup and keeps the shape a screen
| expects to see in one place.
|
| Payment methods live in `settings`, since they are shop configuration
| rather than things a customer buys.
|
| The catalogue is read far more often than it is written, and it is small,
| so it is cached in memory and refreshed on every write.
*/

const { getDb } = require("./firestore");

const PRODUCTS = "products";
const SETTINGS = "settings";
const PAYMENT_METHODS = "settings";

let cache = null;

function toDocument(game, pkg) {
  return {
    // Identity, kept exactly as the buttons already use it.
    productId: `${game.id}~${pkg.id}`,
    gameId: game.id,
    packageId: pkg.id,
    gameName: game.name,
    gameEmoji: game.emoji || null,
    gamePaused: Boolean(game.paused),
    idLabel: game.idLabel || "Player ID",
    idExample: game.idExample || null,

    // Product.
    name: pkg.name,
    price: Number(pkg.price) || 0,
    paused: Boolean(pkg.paused),
    note: pkg.note || "",
    subCategoryId: pkg.sub_category_id ?? null,
    requirements: pkg.requirements || [],

    updatedAt: new Date().toISOString(),
  };
}

function fromSnapshot(snapshot) {
  const data = snapshot.data();

  // Rebuild the nested shape the screens read, so nothing above this layer
  // has to know the catalogue was flattened.
  return {
    id: data.packageId,
    name: data.name,
    price: data.price,
    paused: data.paused,
    note: data.note || "",
    sub_category_id: data.subCategoryId,
    requirements: data.requirements || [],
  };
}

/**
 * Load every product, grouped by game, in the shape catalog.js exposes.
 */
async function fetchCatalog() {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const snapshot = await db.collection(PRODUCTS).get();

  const games = new Map();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!games.has(data.gameId)) {
      games.set(data.gameId, {
        id: data.gameId,
        name: data.gameName,
        emoji: data.gameEmoji || "",
        paused: Boolean(data.gamePaused),
        idLabel: data.idLabel || "Player ID",
        idExample: data.idExample || "",
        packages: [],
      });
    }

    games.get(data.gameId).packages.push(fromSnapshot(doc));
  }

  const paymentMethods = await fetchPaymentMethods();

  return {
    version: 1,
    games: Array.from(games.values()),
    payments: paymentMethods,
  };
}

/**
 * Payment methods, stored under settings so the admin screens find them
 * where they expect configuration to live.
 */
async function fetchPaymentMethods() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db.collection(SETTINGS).get();

    return snapshot.docs
      .filter((doc) => doc.id.startsWith("payment_"))
      .map((doc) => {
        const data = doc.data();

        return {
          id: data.id,
          emoji: data.emoji || "",
          title: data.title,
          paused: Boolean(data.paused),
          lines: data.lines || [],
        };
      });
  } catch (error) {
    console.error(`[CATALOG] Payment methods read failed: ${error.message}`);

    return [];
  }
}

async function writeProduct(game, pkg) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db
      .collection(PRODUCTS)
      .doc(`${game.id}~${pkg.id}`)
      .set(toDocument(game, pkg), { merge: true });

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function writePaymentMethod(payment) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  try {
    await db
      .collection(SETTINGS)
      .doc(`payment_${payment.id}`)
      .set(
        {
          id: payment.id,
          emoji: payment.emoji || "",
          title: payment.title,
          paused: Boolean(payment.paused),
          lines: payment.lines || [],
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Re-read the catalogue into the cache.
 */
async function refresh() {
  const catalog = await fetchCatalog();

  if (catalog) {
    cache = catalog;
  }

  return cache;
}

function getCached() {
  return cache;
}

async function getProduct(gameId, packageId) {
  const catalog = cache || (await refresh());

  if (!catalog) {
    return null;
  }

  const game = catalog.games.find((g) => g.id === gameId);
  const pkg = game && game.packages.find((p) => p.id === packageId);

  return game && pkg ? { game, pkg } : null;
}

module.exports = {
  PRODUCTS,
  SETTINGS,
  PAYMENT_METHODS,
  toDocument,
  fetchCatalog,
  fetchPaymentMethods,
  writeProduct,
  writePaymentMethod,
  refresh,
  getCached,
  getProduct,
};