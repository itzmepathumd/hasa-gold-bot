/*
|--------------------------------------------------------------------------
| USER RECORDS
|--------------------------------------------------------------------------
| One document per Telegram user, keyed by the numeric user id.
|
| Only what the store actually needs is kept: enough to address the customer
| and to recognise them again. No payment details, no message history and
| nothing the shop does not use.
|
| The document id is the Telegram id, which keeps the ids stable across a
| migration and means an upsert can never create a second record for the
| same person.
|
| Wallet fields are stored on the user document for convenience:
|
|   walletBalance     current balance, kept in sync by creditWallet/debitWallet
|   walletLastUpdated ISO timestamp of the last wallet change
*/

const { getDb } = require("./firestore");

const COLLECTION = "users";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Record a customer.
 *
 * Called on every order so the admin list and search keep working. Only the
 * id is required; the rest fills in as it becomes known.
 */
async function upsertUser({ userId, username, firstName, lastName, walletBalance }) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Firestore is not available" };
  }

  if (!userId) {
    return { ok: false, error: "userId is required" };
  }

  const ref = db.collection(COLLECTION).doc(String(userId));
  const fields = { updatedAt: nowIso() };

  // Only overwrite a name when a real one was supplied, so a message with no
  // signature cannot blank out what we already know.
  if (username !== undefined && username !== null && username !== "") {
    fields.username = username;
  }

  if (firstName) {
    fields.firstName = firstName;
  }

  if (lastName !== undefined) {
    fields.lastName = lastName || null;
  }

  if (walletBalance !== undefined) {
    fields.walletBalance = Number(walletBalance);
    fields.walletLastUpdated = nowIso();
  }

  try {
    // createdAt must survive every later visit, so it is only written the
    // first time. data() is undefined for a document that does not exist,
    // which is the normal case on a customer's first order.
    const existing = await ref.get();
    const createdAt =
      existing.exists && existing.data() && existing.data().createdAt
        ? existing.data().createdAt
        : nowIso();

    await ref.set(
      {
        telegramUserId: Number(userId),
        ...fields,
        createdAt,
      },
      { merge: true }
    );

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Derive a user record from an order, so migrating old orders also brings
 * the customer list across.
 */
async function upsertUserFromOrder(order) {
  if (!order || !order.userId) {
    return { ok: false, error: "order has no userId" };
  }

  return upsertUser({
    userId: order.userId,
    username: order.username,
    firstName: order.firstName,
  });
}

async function getUser(userId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  try {
    const snapshot = await db.collection(COLLECTION).doc(String(userId)).get();

    if (!snapshot.exists) {
      return null;
    }

    return { id: snapshot.id, ...snapshot.data() };
  } catch (error) {
    console.error(`[USERS] Read failed: ${error.message}`);

    return null;
  }
}

async function listUsers(limit = 500) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const snapshot = await db.collection(COLLECTION).limit(limit).get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error(`[USERS] List failed: ${error.message}`);

    return [];
  }
}

async function countUsers() {
  const db = await getDb();

  if (!db) {
    return 0;
  }

  try {
    const snapshot = await db.collection(COLLECTION).select().get();

    return snapshot.size;
  } catch (error) {
    console.error(`[USERS] Count failed: ${error.message}`);

    return 0;
  }
}

module.exports = {
  COLLECTION,
  upsertUser,
  upsertUserFromOrder,
  getUser,
  listUsers,
  countUsers,
};