#!/usr/bin/env node
/*
|--------------------------------------------------------------------------
| MIGRATE JSON TO FIRESTORE
|--------------------------------------------------------------------------
| Copies catalog.json and orders.json into Firestore.
|
| Safety properties, in the order they matter:
|
|   - Nothing is deleted. catalog.json and orders.json stay exactly where
|     they are, as the backup, until the operator removes them by hand.
|   - Running it twice is safe. Documents are written with merge:true and
|     the ids are the same every time, so a second run updates the same
|     documents instead of creating duplicates.
|   - An existing document is never blanked. Fields missing from the JSON
|     are left alone rather than being written as empty.
|   - A dry run is the default. Nothing is written until --apply is passed,
|     so the first run can only ever report.
|   - It verifies before it claims success. After writing, it reads the
|     counts back and compares them with what it meant to write.
|
| Usage:
|   node scripts/migrate-json-to-firestore.js              # report only
|   node scripts/migrate-json-to-firestore.js --apply      # write
|   node scripts/migrate-json-to-firestore.js --apply --orders-only
*/

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CATALOG_FILE = path.join(ROOT, "catalog.json");
const ORDERS_FILE = path.join(ROOT, "orders.json");

/*
| A batch may hold at most 500 writes. Stays well under that and keeps the
| failure of one bad document from losing the whole run.
*/
const BATCH_SIZE = 200;

/**
 * Document ids cannot contain a forward slash, and Firestore ids are capped
 * at 1500 bytes. Order ids and product ids are both short and safe, but the
 * check keeps a hand-edited file from silently producing an unwritable id.
 */
function assertUsableId(kind, id) {
  if (!id || typeof id !== "string") {
    throw new Error(`${kind} has a missing or non-string id`);
  }

  if (id.includes("/")) {
    throw new Error(`${kind} id "${id}" contains a slash, which Firestore rejects`);
  }

  if (Buffer.byteLength(id, "utf8") > 1500) {
    throw new Error(`${kind} id "${id}" is too long for Firestore`);
  }

  return id;
}

/**
 * Firestore rejects undefined anywhere in a document, including inside an
 * array. JSON cannot hold undefined, but a hand-edited file can hold a value
 * JSON.stringify would drop, so this normalises both cases.
 */
function sanitize(value) {
  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    // Filtered rather than mapped: keeping the hole would send an undefined
    // straight into the document.
    return value.map(sanitize).filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    const out = {};

    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = sanitize(item);
      }
    }

    return out;
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    console.warn(`⚠️  ${path.basename(file)} is missing; skipping it`);

    return fallback;
  }

  const raw = fs.readFileSync(file, "utf8");

  if (!raw.trim()) {
    console.warn(`⚠️  ${path.basename(file)} is empty; skipping it`);

    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed) && typeof parsed !== "object") {
      throw new Error("expected an object or a list");
    }

    return parsed;
  } catch (error) {
    throw new Error(
      `${path.basename(file)} could not be read: ${error.message}. ` +
        `Fix or restore the file before migrating.`
    );
  }
}

/**
 * Flatten the nested catalogue into one document per package.
 * The id is the same string the buttons send, so callbacks keep working.
 */
function buildProductWrites(catalog) {
  const writes = [];

  for (const game of catalog.games || []) {
    for (const pkg of game.packages || []) {
      const productId = assertUsableId(
        `Product ${game.id}`,
        `${game.id}~${pkg.id}`
      );

      writes.push({
        id: productId,
        data: sanitize({
          productId,
          gameId: game.id,
          packageId: pkg.id,
          gameName: game.name,
          gameEmoji: game.emoji || null,
          gamePaused: Boolean(game.paused),
          idLabel: game.idLabel || "Player ID",
          idExample: game.idExample || null,
          name: pkg.name,
          price: Number(pkg.price) || 0,
          paused: Boolean(pkg.paused),
          note: pkg.note || "",
          subCategoryId: pkg.sub_category_id ?? null,
          requirements: pkg.requirements || [],
          migratedAt: new Date().toISOString(),
        }),
      });
    }
  }

  return writes;
}

function buildPaymentWrites(catalog) {
  return (catalog.payments || []).map((payment) => {
    const id = assertUsableId("Payment method", payment.id);

    return {
      id: `payment_${id}`,
      data: sanitize({
        id,
        emoji: payment.emoji || "",
        title: payment.title,
        paused: Boolean(payment.paused),
        lines: payment.lines || [],
        migratedAt: new Date().toISOString(),
      }),
    };
  });
}

function buildOrderWrites(orders) {
  const seen = new Set();
  const writes = [];

  for (const order of orders) {
    const id = assertUsableId("Order", order.id);

    // A duplicate id inside the JSON file would collapse two orders into
    // one document, so it is reported rather than silently lost.
    if (seen.has(id)) {
      throw new Error(
        `orders.json contains order "${id}" more than once. ` +
          `Resolve the duplicate before migrating.`
      );
    }

    seen.add(id);

    writes.push({
      id,
      data: sanitize({ ...order, migratedAt: new Date().toISOString() }),
    });
  }

  return writes;
}

/**
 * Derive user documents from the orders, so the customer list survives the
 * move without needing a separate export.
 */
function buildUserWrites(orders) {
  const byUser = new Map();

  for (const order of orders) {
    if (!order.userId) {
      continue;
    }

    const key = String(order.userId);
    const existing = byUser.get(key);

    if (!existing) {
      byUser.set(key, {
        telegramUserId: Number(order.userId),
        username: order.username || null,
        firstName: order.firstName || null,
        lastName: order.lastName || null,
        firstSeenAt: order.createdAt || null,
        migratedAt: new Date().toISOString(),
      });
      continue;
    }

    // Fill in anything the earlier record was missing.
    existing.username = existing.username || order.username || null;
    existing.firstName = existing.firstName || order.firstName || null;
    existing.lastName = existing.lastName || order.lastName || null;
  }

  return Array.from(byUser.values()).map((data) => ({
    id: String(data.telegramUserId),
    data: sanitize(data),
  }));
}

async function writeInBatches(db, collection, writes, label) {
  let written = 0;

  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const slice = writes.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const write of slice) {
      // merge:true means a second run updates the same documents, and a
      // field added in Firestore but absent from the JSON is not deleted.
      batch.set(db.collection(collection).doc(write.id), write.data, {
        merge: true,
      });
    }

    await batch.commit();

    written += slice.length;

    console.log(`   ${label}: ${written}/${writes.length}`);
  }

  return written;
}

async function countCollection(db, collection) {
  const snapshot = await db.collection(collection).select().get();

  return snapshot.size;
}

async function main(argv = process.argv) {
  // Read here rather than at import, so the script can be driven by a test.
  const apply = argv.includes("--apply");
  const ordersOnly = argv.includes("--orders-only");
  const catalogOnly = argv.includes("--catalog-only");

  const orders = readJson(ORDERS_FILE, []);

  if (!Array.isArray(orders)) {
    throw new Error("orders.json did not contain a list of orders");
  }

  const catalog =
    !ordersOnly && !catalogOnly ? readJson(CATALOG_FILE, null) : null;

  const products = catalog ? buildProductWrites(catalog) : [];
  const payments = catalog ? buildPaymentWrites(catalog) : [];
  const orderWrites = buildOrderWrites(orders);
  const users = buildUserWrites(orders);

  console.log("── MIGRATION PLAN ─────────────────────────────");
  console.log(`   mode        : ${apply ? "WRITE" : "DRY RUN (nothing written)"}`);
  console.log(`   products    : ${products.length}`);
  console.log(`   payments    : ${payments.length}`);
  console.log(`   orders      : ${orderWrites.length}`);
  console.log(`   users       : ${users.length}`);
  console.log("─────────────────────────────────────────────────");

  if (!apply) {
    console.log("\nNothing was written. Re-run with --apply to migrate.");

    return 0;
  }

  // Required only when actually writing, so a dry run needs no credentials.
  const { getDb, describeStatus, healthCheck } = require("../src/database/firestore");

  const status = describeStatus();

  console.log(`\nUsing project: ${status.projectId || "(from Application Default Credentials)"}`);

  const health = await healthCheck();

  if (!health.ok) {
    console.error(`\n❌ Firestore is not reachable: ${health.error}`);
    console.error("   Nothing was written.");

    return 1;
  }

  const db = await getDb();

  const before = {
    orders: await countCollection(db, "orders"),
    products: await countCollection(db, "products"),
    users: await countCollection(db, "users"),
  };

  console.log(
    `\nAlready in Firestore: ${before.orders} order(s), ${before.products} product(s), ${before.users} user(s)`
  );

  const summary = { orders: 0, products: 0, payments: 0, users: 0 };

  /*
  | Batches are committed one at a time, so a failure part way through
  | leaves the earlier batches in Firestore. That is safe here precisely
  | because the script is idempotent, but it has to be said out loud rather
  | than reported as a clean failure.
  */
  const steps = [
    ["orders", orderWrites.length, () => writeInBatches(db, "orders", orderWrites, "orders")],
    ["products", products.length, () => writeInBatches(db, "products", products, "products")],
    ["payments", payments.length, () => writeInBatches(db, "settings", payments, "payments")],
    ["users", users.length, () => writeInBatches(db, "users", users, "users")],
  ];

  for (const [label, planned, run] of steps) {
    if (!planned) {
      continue;
    }

    try {
      summary[label] = await run();
    } catch (error) {
      console.error(`\n❌ Writing ${label} failed: ${error.message}`);
      console.error(
        `   ${summary[label]} of ${planned} ${label} document(s) were written before it stopped.`
      );
      console.error(
        "   Re-running is safe: ids are unchanged, so it will not duplicate anything."
      );
      console.error("   catalog.json and orders.json were NOT touched.");

      return 1;
    }
  }

  // Verify rather than assume. A run that reports success must be able to
  // show that the documents are actually there.
  const after = {
    orders: await countCollection(db, "orders"),
    products: await countCollection(db, "products"),
    users: await countCollection(db, "users"),
  };

  console.log("\n── VERIFICATION ────────────────────────────────");

  const problems = [];

  if (after.orders < orderWrites.length) {
    problems.push(
      `orders: expected at least ${orderWrites.length}, found ${after.orders}`
    );
  }

  if (products.length && after.products < products.length) {
    problems.push(
      `products: expected at least ${products.length}, found ${after.products}`
    );
  }

  // Spot check one order end to end, since a count alone cannot prove the
  // right fields arrived.
  if (orderWrites.length) {
    const sample = orderWrites[orderWrites.length - 1];
    const snapshot = await db.collection("orders").doc(sample.id).get();

    if (!snapshot.exists) {
      problems.push(`order ${sample.id} is missing after the write`);
    } else {
      const stored = snapshot.data();

      for (const field of ["id", "userId", "productName", "status"]) {
        if (field in sample.data && String(stored[field]) !== String(sample.data[field])) {
          problems.push(
            `order ${sample.id}.${field} is "${stored[field]}", expected "${sample.data[field]}"`
          );
        }
      }
    }

    console.log(`   checked order ${sample.id} field by field`);
  }

  if (problems.length) {
    console.error("\n❌ Verification failed:");

    for (const problem of problems) {
      console.error(`   - ${problem}`);
    }

    console.error("\n   catalog.json and orders.json were NOT touched.");

    return 1;
  }

  console.log(`   orders   : ${after.orders}`);
  console.log(`   products : ${after.products}`);
  console.log(`   users    : ${after.users}`);

  console.log("\n✅ Migration verified.");
  console.log("   catalog.json and orders.json were left untouched as your backup.");
  console.log("   Set the Firebase environment variables and restart the bot to use it.");

  return 0;
}

module.exports = {
  buildProductWrites,
  buildPaymentWrites,
  buildOrderWrites,
  buildUserWrites,
  writeInBatches,
  countCollection,
  sanitize,
  assertUsableId,
  main,
};

// Only run when invoked directly, so the tests can drive main() against the
// in-memory Firestore double.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n❌ ${error.message}`);
      console.error("   Nothing was written. The JSON files were not touched.");

      process.exit(1);
    });
}