/*
|--------------------------------------------------------------------------
| ORDER DATABASE
|--------------------------------------------------------------------------
| The single place the rest of the bot reads or writes orders.
|
| Storage is PostgreSQL on Supabase. There is no second backend: a shop that
| cannot store an order must not take one. When the database is unreachable
| the store reports ok:false and the admin is told once per reason, instead
| of the shop silently trading on a copy.
|
| Reads come from an in-memory mirror rather than a query per screen. Several
| admin screens and the analytics read the order book synchronously; making
| them await would mean rewriting every list screen. The mirror is filled
| once at startup from PostgreSQL and updated by every write, so the
| collection is never re-downloaded to render a screen. PostgreSQL remains
| the source of truth: the mirror is rebuilt from it on every boot, and
| nothing is ever written only to memory.
|
| Writes go to the database and then to the mirror, so a failed write leaves
| the mirror untouched and reports ok:false. An order is never reported as
| saved when it was not.
*/

const pgStore = require("./pgOrders");
const {
  getDb,
  describeStatus,
  healthCheck,
  closeDb,
  withTimeout,
  LOAD_TIMEOUT_MS,
} = require("./connection");

let mirror = [];
let mirrorReady = false;

/*
| Told when the store cannot be read or written, so the admin learns the
| shop has stopped taking orders instead of losing one silently.
*/
let onStorageFailure = async () => {};

function setOrderStoreFailureHandler(handler) {
  onStorageFailure = handler;
}

function usingDatabase() {
  return describeStatus().mode === "postgres";
}

/**
 * Which store is in use, and whether the mirror came up. Safe to print: no
 * credential values.
 */
function describe() {
  return { ...describeStatus(), mirrorReady, mirroredOrders: mirror.length };
}

/**
 * Load the read mirror.
 */
async function hydrate() {
  if (!usingDatabase()) {
    mirror = [];
    mirrorReady = false;

    console.warn(
      "[DB] SUPABASE_DB_URL is not set, so the order store is empty. " +
        "See database/schema.sql and .env.example."
    );

    return { mode: "json", orders: 0, ok: false };
  }

  try {
    // Bounded, so an unreachable database costs a warning rather than a
    // bot that sits silent through start-up.
    mirror = await withTimeout(
      pgStore.fetchAllOrders(),
      LOAD_TIMEOUT_MS,
      "Loading orders from PostgreSQL"
    );

    mirror.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    mirrorReady = true;

    console.log(`[DB] Using PostgreSQL, ${mirror.length} order(s) loaded`);

    return { mode: "postgres", orders: mirror.length, ok: true };
  } catch (error) {
    console.error(`[DB] Could not load orders: ${error.message}`);

    mirror = [];
    mirrorReady = false;

    await onStorageFailure(error.message);

    return { mode: "postgres", orders: 0, ok: false, error: error.message };
  }
}

function readOrders() {
  // A mirror that never loaded is not an empty order book.
  if (!mirrorReady) {
    return {
      ok: false,
      orders: [],
      error: "The order mirror is not loaded yet",
    };
  }

  return { ok: true, orders: mirror.slice(), error: null };
}

/**
 * Orders for read-only screens. Returns [] when the store is unreadable so a
 * listing shows empty instead of crashing, but writes must not use this.
 */
function getOrders() {
  const result = readOrders();

  if (!result.ok) {
    console.error(`[ORDERS] Refusing to read: ${result.error}`);
  }

  return result.ok ? result.orders : [];
}

function replaceMirror(order) {
  const index = mirror.findIndex((o) => o.id === order.id);

  if (index === -1) {
    mirror.push(order);
  } else {
    mirror[index] = order;
  }

  mirror.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function dropFromMirror(orderId) {
  mirror = mirror.filter((o) => o.id !== orderId);
}

/**
 * Change one order by id.
 *
 * The mutator receives the stored order and returns the record to persist.
 * It reports its decision through `decision`, so the object stored is never
 * a wrapper around the order.
 */
async function mutateOrder(orderId, mutator, decision = {}) {
  if (!usingDatabase()) {
    await onStorageFailure("The order store is not available");
    return null;
  }

  const result = await pgStore.updateOrder(orderId, mutator, decision);

  if (!result.ok) {
    console.error(`[ORDERS] Update failed: ${result.error}`);
    await onStorageFailure(result.error);

    return null;
  }

  // Only mirror a change that was actually committed.
  if (result.order) {
    replaceMirror(result.order);
  }

  return result.order;
}

/**
 * Add a new order. Refuses a duplicate order number.
 */
async function appendOrder(order) {
  if (!usingDatabase()) {
    await onStorageFailure("The order store is not available");
    return null;
  }

  const result = await pgStore.createOrder(order);

  if (!result.ok) {
    console.error(`[ORDERS] Create failed: ${result.error}`);

    if (!result.duplicate) {
      await onStorageFailure(result.error);
    }

    return null;
  }

  replaceMirror(order);

  return order;
}

/*
|--------------------------------------------------------------------------
| DIRECT QUERIES
|--------------------------------------------------------------------------
| These go to the database instead of the mirror. They are for the admin
| screens that must show a large slice of the order book without loading it,
| and for reports that should reflect committed data only.
*/

async function getOrder(orderId) {
  if (!usingDatabase()) {
    return getOrders().find((o) => o.id === orderId) || null;
  }

  const order = await pgStore.fetchOrder(orderId);

  if (order) {
    replaceMirror(order);
  }

  return order;
}

async function getUserOrders(userId) {
  if (!usingDatabase()) {
    return getOrders().filter((o) => String(o.userId) === String(userId));
  }

  return pgStore.fetchUserOrders(userId);
}

async function getOrdersByStatus(statuses) {
  if (!usingDatabase()) {
    const list = Array.isArray(statuses) ? statuses : [statuses];

    return getOrders().filter((o) => list.includes(o.status));
  }

  return pgStore.fetchOrdersByStatus(statuses);
}

/**
 * Orders waiting on the customer or on the admin.
 */
async function getPendingOrders() {
  return getOrdersByStatus(["pending_payment", "pending_approval"]);
}

/**
 * Counts per state, taken from the database without loading the records.
 */
async function getOrderStats() {
  if (!usingDatabase()) {
    const orders = getOrders();
    const counts = {};

    for (const order of orders) {
      const status = order.status || "unknown";

      counts[status] = (counts[status] || 0) + 1;
    }

    return { counts, total: orders.length, revenue: revenueOf(orders) };
  }

  const counts = await pgStore.fetchStatusCounts();

  return {
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    revenue: revenueOf(mirror),
  };
}

function revenueOf(orders) {
  return orders
    .filter((o) => o.status === "approved" || o.status === "topup_completed")
    .reduce((sum, o) => sum + (Number(o.price) || 0), 0);
}

module.exports = {
  // Same surface the bot already uses.
  readOrders,
  getOrders,
  mutateOrder,
  appendOrder,
  // Queries that go straight to the store.
  getOrder,
  getUserOrders,
  getOrdersByStatus,
  getPendingOrders,
  getOrderStats,
  // Lifecycle.
  hydrate,
  usingDatabase,
  describe,
  setOrderStoreFailureHandler,
  healthCheck,
  closeDb,
};
