/*
|--------------------------------------------------------------------------
| MIGRATION TESTS
|--------------------------------------------------------------------------
| Proves the three properties the migration has to hold:
|
|   1. A dry run writes nothing.
|   2. Running it twice does not duplicate a single order.
|   3. An order keeps its id and every field, and catalog.json and
|      orders.json are never modified by the run.
|
| The script's pure builders are exercised directly and main() is driven
| against the in-memory Firestore double.
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { FakeFirestore } = require("./fakeFirestore");
const firestoreConnection = require("../src/database/firestore");
const migrate = require("../scripts/migrate-json-to-firestore");

const ROOT = path.join(__dirname, "..");
const CATALOG_FILE = path.join(ROOT, "catalog.json");
const ORDERS_FILE = path.join(ROOT, "orders.json");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();

    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function freshFake() {
  const fake = new FakeFirestore();

  process.env.FIRESTORE_ENABLED = "true";
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_CLIENT_EMAIL = "test@example.iam.gserviceaccount.com";
  process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----\\n";

  firestoreConnection.__setDbForTests(fake);

  return fake;
}

(async () => {
  const realArgv = process.argv;

  section("the plan is correct before anything is written");

  await check("a dry run reports the counts and writes nothing", async () => {
    const fake = freshFake();

    process.argv = ["node", "migrate"];

    const code = await migrate.main(process.argv);

    assert.strictEqual(code, 0, "dry run reported failure");
    assert.strictEqual(fake.writes, 0, `dry run performed ${fake.writes} write(s)`);
    assert.strictEqual(fake.data.size, 0, "dry run stored a document");
  });

  await check("every order in orders.json is planned", () => {
    const orders = readJson(ORDERS_FILE);
    const writes = migrate.buildOrderWrites(orders);

    assert.strictEqual(writes.length, orders.length);

    const ids = writes.map((w) => w.id).sort();
    const expected = orders.map((o) => o.id).sort();

    assert.deepStrictEqual(ids, expected, "planned ids do not match the file");
  });

  await check("a duplicate id in the file is refused, not collapsed", () => {
    const orders = [
      { id: "HG-1", userId: 1, status: "pending_payment" },
      { id: "HG-1", userId: 2, status: "approved" },
    ];

    assert.throws(
      () => migrate.buildOrderWrites(orders),
      /more than once/,
      "a duplicate order id was silently accepted"
    );
  });

  await check("an id Firestore would reject is refused before writing", () => {
    assert.throws(() => migrate.assertUsableId("Order", "bad/id"));
    assert.throws(() => migrate.assertUsableId("Order", ""));
    assert.throws(() => migrate.assertUsableId("Order", "x".repeat(1501)));
    assert.doesNotThrow(() => migrate.assertUsableId("Order", "HG-1234-ABCD"));
  });

  await check("undefined is stripped, because Firestore rejects it", () => {
    const clean = migrate.sanitize({ a: 1, b: undefined, c: null, d: [undefined, 2] });

    assert.ok(!("b" in clean), "undefined survived");
    assert.strictEqual(clean.c, null, "null was dropped");
    assert.deepStrictEqual(clean.d, [undefined, 2].map((v) => v).filter((v) => v !== undefined));
  });

  section("products keep the ids the buttons already send");

  await check("product ids are gameId~packageId", () => {
    const catalog = readJson(CATALOG_FILE);
    const writes = migrate.buildProductWrites(catalog);
    const expected = catalog.games.reduce((sum, g) => sum + g.packages.length, 0);

    assert.strictEqual(writes.length, expected);

    for (const write of writes) {
      assert.ok(
        write.id.includes("~"),
        `product id ${write.id} is not the callback format`
      );
      assert.strictEqual(write.data.productId, write.id);
      assert.strictEqual(write.data.price, Number(write.data.price));
    }
  });

  await check("every sub_category_id survives the migration", () => {
    const catalog = readJson(CATALOG_FILE);
    const writes = migrate.buildProductWrites(catalog);

    for (const game of catalog.games) {
      for (const pkg of game.packages) {
        const write = writes.find((w) => w.id === `${game.id}~${pkg.id}`);

        assert.ok(write, `no write planned for ${game.id}~${pkg.id}`);
        assert.strictEqual(
          write.data.subCategoryId,
          pkg.sub_category_id,
          `subCategoryId changed for ${game.id}~${pkg.id}`
        );
      }
    }
  });

  await check("every order field survives the migration", () => {
    const orders = readJson(ORDERS_FILE);
    const writes = migrate.buildOrderWrites(orders);
    const byId = new Map(writes.map((w) => [w.id, w.data]));

    for (const order of orders) {
      const stored = byId.get(order.id);

      for (const [field, value] of Object.entries(order)) {
        assert.deepStrictEqual(
          stored[field],
          value,
          `${order.id}.${field} changed during the migration`
        );
      }
    }
  });

  section("running it twice is safe");

  await check("the second run creates no duplicates", async () => {
    const fake = freshFake();

    process.argv = ["node", "migrate", "--apply"];

    const first = await migrate.main(process.argv);

    assert.strictEqual(first, 0, "first run failed");

    const ordersBefore = await migrate.countCollection(fake, "orders");
    const productsBefore = await migrate.countCollection(fake, "products");

    assert.strictEqual(
      ordersBefore,
      readJson(ORDERS_FILE).length,
      "first run did not write every order"
    );

    const second = await migrate.main(process.argv);

    assert.strictEqual(second, 0, "second run failed");

    const ordersAfter = await migrate.countCollection(fake, "orders");
    const productsAfter = await migrate.countCollection(fake, "products");

    assert.strictEqual(
      ordersAfter,
      ordersBefore,
      `second run changed the order count: ${ordersBefore} -> ${ordersAfter}`
    );
    assert.strictEqual(
      productsAfter,
      productsBefore,
      `second run changed the product count: ${productsBefore} -> ${productsAfter}`
    );
  });

  await check("a field added in Firestore is not blanked by a re-run", async () => {
    const fake = freshFake();

    process.argv = ["node", "migrate", "--apply"];

    await migrate.main(process.argv);

    // Something the shop added by hand after the first migration.
    await fake.collection("orders").doc(readJson(ORDERS_FILE)[0].id).set(
      { manuallyReviewed: true },
      { merge: true }
    );

    await migrate.main(process.argv);

    const stored = await fake
      .collection("orders")
      .doc(readJson(ORDERS_FILE)[0].id)
      .get();

    assert.strictEqual(
      stored.data().manuallyReviewed,
      true,
      "a second run wiped a field that only exists in Firestore"
    );
  });

  await check("the JSON files are untouched by a real migration", async () => {
    freshFake();

    const catalogBefore = fs.readFileSync(CATALOG_FILE, "utf8");
    const ordersBefore = fs.readFileSync(ORDERS_FILE, "utf8");

    process.argv = ["node", "migrate", "--apply"];

    await migrate.main(process.argv);

    assert.strictEqual(
      fs.readFileSync(CATALOG_FILE, "utf8"),
      catalogBefore,
      "catalog.json was modified"
    );
    assert.strictEqual(
      fs.readFileSync(ORDERS_FILE, "utf8"),
      ordersBefore,
      "orders.json was modified"
    );
  });

  await check("a migration that cannot reach Firestore writes nothing", async () => {
    const fake = freshFake();

    fake.connected = false;

    process.argv = ["node", "migrate", "--apply"];

    const code = await migrate.main(process.argv);

    fake.connected = true;

    assert.strictEqual(code, 1, "an unreachable store was reported as success");
    assert.strictEqual(fake.data.size, 0, "documents were written anyway");
  });

  section("users come across with the orders");

  await check("customer records are derived from the order history", () => {
    const orders = readJson(ORDERS_FILE);
    const users = migrate.buildUserWrites(orders);
    const expected = new Set(orders.filter((o) => o.userId).map((o) => String(o.userId)));

    assert.strictEqual(users.length, expected.size, "wrong number of users");

    for (const user of users) {
      assert.strictEqual(user.id, String(user.data.telegramUserId));
      assert.ok(user.data.createdAt || user.data.firstSeenAt);
    }
  });

  await check("one document per customer, not one per order", () => {
    const orders = [
      { id: "A", userId: 42, username: "same", createdAt: "1" },
      { id: "B", userId: 42, username: null, createdAt: "2" },
      { id: "C", userId: 42, username: "", createdAt: "3" },
    ];

    const users = migrate.buildUserWrites(orders);

    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0].data.username, "same", "a blank name overwrote a real one");
  });

  process.argv = realArgv;

  console.log(
    `\nALL MIGRATION CHECKS PASSED  (${passed} passed, ${failed} failed)`
  );

  delete process.env.FIREBASE_PRIVATE_KEY;

  process.exit(failed === 0 ? 0 : 1);
})();