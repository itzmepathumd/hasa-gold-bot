/*
|--------------------------------------------------------------------------
| FIRESTORE ORDER STORE
|--------------------------------------------------------------------------
| Orders live in the `orders` collection with the order id as the document
| id, so an order keeps the same id it had in orders.json and the migration
| is a straight copy.
|
| Concurrency: creating an order, approving it, and claiming it for top-up
| all run inside a transaction. Firestore retries a transaction callback
| when another writer touches the same document, so the mutators passed to
| mutateOrder() must stay side-effect free - they may run more than once.
| Every mutator in this project only sets fields on the record it is given,
| which satisfies that rule.
|
| Timestamps are kept as ISO strings rather than Firestore Timestamps. The
| admin screens, analytics and order exports all format these values
| directly, and storing them unchanged means none of that code has to be
| rewritten. A field must stay a string for the history to read correctly.
*/

const { getDb } = require("./firestore");

const COLLECTION = "orders";

/**
 * Firestore rejects undefined, and a field set to undefined in an object
 * literal is dropped from JSON but is an error here. Null is valid and is
 * used throughout the order shape for "not filled in yet".
 */
function toDocument(order) {
  const clean = {};

  for (const [key, value] of Object.entries(order)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }

  return clean;
}

function fromSnapshot(snapshot) {
  if (!snapshot.exists) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * Every stored order, newest last. This is the whole collection, so it is
 * only used at startup to build the read mirror, never to render a screen.
 */
async function fetchAllOrders() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db.collection(COLLECTION).get();

  return snapshot.docs.map(fromSnapshot);
}

async function fetchOrder(orderId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const snapshot = await db.collection(COLLECTION).doc(orderId).get();

  return fromSnapshot(snapshot);
}

/**
 * Orders belonging to one customer. Sorted in memory because combining a
 * where with an orderBy needs a composite index, and a shop this size does
 * not justify asking the operator to create one.
 */
async function fetchUserOrders(userId) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const snapshot = await db
    .collection(COLLECTION)
    .where("userId", "==", userId)
    .get();

  return snapshot.docs
    .map(fromSnapshot)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Orders sitting in one of the given states.
 */
async function fetchOrdersByStatus(statuses) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const list = Array.isArray(statuses) ? statuses : [statuses];

  const snapshot = await db
    .collection(COLLECTION)
    .where("status", "in", list)
    .get();

  return snapshot.docs.map(fromSnapshot);
}

/**
 * Count orders per state without loading the records.
 */
async function fetchStatusCounts() {
  const db = await getDb();

  const counts = {};

  if (!db) {
    return counts;
  }

  // Only the status field is pulled back. select() with no argument loads
  // whole documents, which is the opposite of counting cheaply, and a bare
  // projection would come back without the field being grouped on.
  const snapshot = await db
    .collection(COLLECTION)
    .select("status")
    .get();

  for (const doc of snapshot.docs) {
    const status = doc.data().status || "unknown";

    counts[status] = (counts[status] || 0) + 1;
  }

  return counts;
}

/**
 * Create an order.
 *
 * create() refuses to overwrite, so a retried submission cannot create a
 * second copy of the same order id and double it in the totals.
 */
async function createOrder(order) {
  const db = await getDb();

  if (!db) {
    return { ok: false, order: null, error: "Firestore is not available" };
  }

  try {
    await db.collection(COLLECTION).doc(order.id).create(toDocument(order));

    return { ok: true, order, error: null };
  } catch (error) {
    const alreadyExists = error.code === 6 || /already exists/i.test(error.message);

    return {
      ok: false,
      order: null,
      error: alreadyExists
        ? `Order ${order.id} already exists`
        : error.message,
      duplicate: alreadyExists,
    };
  }
}

/**
 * Change one order by id inside a transaction.
 *
 * The mutator receives the stored order and returns the record to persist,
 * or false to decline without writing. Decisions are reported through the
 * `decision` object so the stored document is never a wrapper.
 */
async function updateOrder(orderId, mutator, decision = {}) {
  const db = await getDb();

  if (!db) {
    decision.ok = false;
    return { ok: false, order: null, error: "Firestore is not available" };
  }

  let result = null;

  try {
    await db.runTransaction(async (tx) => {
      const ref = db.collection(COLLECTION).doc(orderId);
      const snapshot = await tx.get(ref);

      if (!snapshot.exists) {
        decision.ok = true;
        decision.found = false;
        result = null;
        return;
      }

      const current = fromSnapshot(snapshot);
      const updated = mutator(current, decision);

      if (updated === false) {
        // The mutator declined, so nothing is written.
        decision.ok = true;
        decision.found = true;
        result = current;
        return;
      }

      tx.set(ref, toDocument(updated));

      decision.ok = true;
      decision.found = true;
      result = updated;
    });

    return { ok: true, order: result, error: null };
  } catch (error) {
    decision.ok = false;

    return { ok: false, order: null, error: error.message };
  }
}

module.exports = {
  COLLECTION,
  fetchAllOrders,
  fetchOrder,
  fetchUserOrders,
  fetchOrdersByStatus,
  fetchStatusCounts,
  createOrder,
  updateOrder,
};