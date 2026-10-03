/*
|--------------------------------------------------------------------------
| ORDER DATABASE
|--------------------------------------------------------------------------
| The single place the rest of the bot reads or writes orders.
|
| Two backends sit behind one interface:
|
|   Firestore  - the production store. Every write is a transaction, so an
|                order cannot be approved twice or claimed for top-up twice.
|
|   JSON files - used only when Firestore is not configured, which keeps
|                local development and any deployment that has not finished
|                migrating working exactly as before.
|
| Reads come from an in-memory mirror rather than a query per screen. The
| admin panels read orders from about twenty places that are all synchronous
| today; making them await would mean rewriting every list screen and the
| analytics that read them. The mirror is filled once at startup from
| Firestore and updated by every write, so the collection is never
| re-downloaded to render a screen. Firestore remains the source of truth:
| the mirror is rebuilt from it on every boot, and nothing is written
| only to memory.
|
| Because writes go to Firestore and then to the mirror, a Firestore failure
| leaves the mirror untouched and reports ok:false. The order is never
| reported as saved when it was not.
*/

const jsonStore = require("./jsonOrders");
const firestoreStore = require("./ordersFirestore");
const { shouldUseFirestore, getDb, describeStatus, healthCheck, closeDb } = require("./firestore");

let mode = "json";
let mirror = [];
let mirrorReady = false;

/*
| Told when the store cannot be read or written, so the admin learns the
| shop has stopped taking orders instead of losing one silently.
*/
let onStorageFailure = async () => {};

function setOrderStoreFailureHandler(handler) {
  onStorageFailure = handler;
  jsonStore.setFailureHandler(handler);
}

function usingFirestore() {
  return mode === "firestore";
}

/**
 * Which store is in use, and why. Safe to print: no credential values.
 */
function describe() {
  return { ...describeStatus(), mirrorReady, mirroredOrders: mirror.length };
}

/**
 * Load the read mirror.
 *
 * On the JSON backend this is a no-op, because the file is already the
 * store. On Firestore the collection is read once here and never again
 * during normal running.
 */
async function hydrate() {
  if (!shouldUseFirestore()) {
    mode = "json";
    mirrorReady = false;

    // The file is the store here, so it is already loaded. Reporting the
    // real count keeps the startup log honest.
    return { mode, orders: jsonStore.getOrders().length };
  }

  const db = await getDb();

  if (!db) {
    // Configured but unreachable. Falling back keeps the shop trading
    // instead of refusing every order until the config is fixed.
    console.warn(
      "[DB] Firestore is configured but unreachable; using the JSON store"
    );

    mode = "json";
    mirrorReady = false;

    return { mode, orders: 0 };
  }

  try {
    mirror = await firestoreStore.fetchAllOrders();

    // Oldest first, matching the order the JSON file had.
    mirror.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    mode = "firestore";
    mirrorReady = true;

    console.log(`[DB] Using Firestore, ${mirror.length} order(s) loaded`);

    return { mode, orders: mirror.length };
  } catch (error) {
    console.error(
      "[DB] Could not load orders from Firestore, falling back to JSON:",
      error.message
    );

    mode = "json";
    mirrorReady = false;

    return { mode, orders: 0 };
  }
}

function readOrders() {
  if (usingFirestore()) {
    // A mirror that never loaded is not an empty order book.
    if (!mirrorReady) {
      return {
        ok: false,
        orders: [],
        error: "Firestore mirror is not loaded yet",
      };
    }

    return { ok: true, orders: mirror.slice(), error: null };
  }

  return jsonStore.readOrders();
}

/**
 * Orders for read-only screens. Returns [] when the store is unreadable so
 * a listing shows empty instead of crashing, but writes must not use this.
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
  if (!usingFirestore()) {
    return jsonStore.mutateOrder(orderId, mutator, decision);
  }

  const result = await firestoreStore.updateOrder(orderId, mutator, decision);

  if (!result.ok) {
    console.error(`[ORDERS] Firestore update failed: ${result.error}`);
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
 * Add a new order. Refuses a duplicate id.
 */
async function appendOrder(order) {
  if (!usingFirestore()) {
    return jsonStore.appendOrder(order);
  }

  const result = await firestoreStore.createOrder(order);

  if (!result.ok) {
    console.error(`[ORDERS] Firestore create failed: ${result.error}`);
    await onStorageFailure(result.error);

    return null;
  }

  replaceMirror(order);

  return order;
}

/*
|--------------------------------------------------------------------------
| DIRECT QUERIES
|--------------------------------------------------------------------------
| These go to Firestore instead of the mirror. They are for the admin
| screens that must show a large slice of the order book without loading it,
| and for reports that should reflect committed data only.
*/

async function getOrder(orderId) {
  if (!usingFirestore()) {
    return getOrders().find((o) => o.id === orderId) || null;
  }

  const order = await firestoreStore.fetchOrder(orderId);

  if (order) {
    replaceMirror(order);
  }

  return order;
}

async function getUserOrders(userId) {
  if (!usingFirestore()) {
    return getOrders().filter((o) => o.userId === userId);
  }

  return firestoreStore.fetchUserOrders(userId);
}

async function getOrdersByStatus(statuses) {
  if (!usingFirestore()) {
    const list = Array.isArray(statuses) ? statuses : [statuses];

    return getOrders().filter((o) => list.includes(o.status));
  }

  return firestoreStore.fetchOrdersByStatus(statuses);
}

/**
 * Orders waiting on the customer or on the admin.
 */
async function getPendingOrders() {
  return getOrdersByStatus(["pending_payment", "pending_approval"]);
}

/**
 * Counts per state, taken from Firestore without loading the records.
 */
async function getOrderStats() {
  if (!usingFirestore()) {
    const orders = getOrders();
    const counts = {};

    for (const order of orders) {
      const status = order.status || "unknown";

      counts[status] = (counts[status] || 0) + 1;
    }

    return { counts, total: orders.length, revenue: revenueOf(orders) };
  }

  const counts = await firestoreStore.fetchStatusCounts();
  const orders = mirror;

  return {
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    revenue: revenueOf(orders),
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
  usingFirestore,
  describe,
  setOrderStoreFailureHandler,
  healthCheck,
  closeDb,
};