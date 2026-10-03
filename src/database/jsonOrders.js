/*
|--------------------------------------------------------------------------
| JSON ORDER STORE
|--------------------------------------------------------------------------
| The original orders.json implementation, kept byte-for-byte in behaviour.
|
| It stays as the fallback for local development and for any deployment that
| has not configured Firestore yet. Once Firestore is in use this file is
| never called, which is what keeps the JSON store from becoming a second
| source of truth.
|
| The important property preserved here is that a corrupt file reports
| ok:false instead of pretending there are no orders. Returning [] on a parse
| error would make the next write erase every real order.
*/

const fs = require("fs");

const ORDERS_FILE = "./orders.json";
const ORDERS_TMP = "./orders.json.tmp";
const ORDERS_PREV = "./orders.prev.json";

/**
 * Called when the store cannot be read or written, so the admin is told the
 * shop has stopped taking orders instead of silently losing one.
 */
let onStorageFailure = async () => {};

function setFailureHandler(handler) {
  onStorageFailure = handler;
}

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, "[]");
}

/*
| Every write goes through this chain, so two approvals arriving at once
| cannot interleave a read-modify-write and lose an order.
*/
let writeChain = Promise.resolve();

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
 * Orders for read-only screens. Returns [] when the file is unreadable so a
 * listing shows empty instead of crashing, but writes must not use this.
 */
function getOrders() {
  const result = readOrders();

  if (!result.ok) {
    console.error(`[ORDERS] Refusing to read: ${result.error}`);
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
function withLock(task) {
  const run = writeChain.then(task, task);

  writeChain = run.then(
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
  return withLock(async () => {
    const result = readOrders();

    if (!result.ok) {
      decision.ok = false;
      console.error(`[ORDERS] Write blocked: ${result.error}`);
      await onStorageFailure(result.error);
      return null;
    }

    const index = result.orders.findIndex((o) => o.id === orderId);

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
      console.error(`[ORDERS] Write failed: ${error.message}`);
      await onStorageFailure(error.message);
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
  return withLock(async () => {
    const result = readOrders();

    if (!result.ok) {
      console.error(`[ORDERS] Append blocked: ${result.error}`);
      await onStorageFailure(result.error);
      return null;
    }

    // Refuse a duplicate id rather than letting the list grow two copies
    // of the same order, which would double every total.
    if (result.orders.some((o) => o.id === order.id)) {
      console.error(
        `[ORDERS] Append blocked: order ${order.id} already exists`
      );

      return null;
    }

    result.orders.push(order);

    try {
      writeOrders(result.orders);
    } catch (error) {
      console.error(`[ORDERS] Append failed: ${error.message}`);
      await onStorageFailure(error.message);
      return null;
    }

    return order;
  });
}

module.exports = {
  ORDERS_FILE,
  readOrders,
  getOrders,
  mutateOrder,
  appendOrder,
  setFailureHandler,
};