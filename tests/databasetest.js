/*
|--------------------------------------------------------------------------
| DATABASE TESTS
|--------------------------------------------------------------------------
| Exercises the Firestore code path against an in-memory double, because
| there is no project, no credentials and no Java emulator available here.
|
| These tests are the only reason the Firestore path can be trusted before
| it meets a real database: they drive the actual orders.js,
| ordersFirestore.js and products.js, not a re-implementation.
*/

const assert = require("assert");

const { FakeFirestore } = require("./fakeFirestore");
const firestoreConnection = require("../src/database/firestore");
const orders = require("../src/database/orders");
const products = require("../src/database/products");
const users = require("../src/database/users");

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

/**
 * Put the module into Firestore mode with a fresh double.
 */
function useFakeFirestore() {
  const fake = new FakeFirestore();

  process.env.FIRESTORE_ENABLED = "true";
  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_CLIENT_EMAIL = "test@example.iam.gserviceaccount.com";
  process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----\\n";

  firestoreConnection.__setDbForTests(fake);

  return fake;
}

function makeOrder(overrides = {}) {
  return {
    id: "HG-000000-AAAAAA",
    userId: 555,
    username: "customer",
    firstName: "Cus",
    playerId: "8595647532",
    gameId: "free_fire",
    gameName: "Free Fire",
    productKey: "weekly",
    productName: "📅 Weekly",
    price: 590,
    status: "pending_payment",
    paymentProof: null,
    approvedAt: null,
    rejectedAt: null,
    topupStatus: null,
    topupAttempts: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

(async () => {
  section("the store switches to Firestore when it is configured");

  await check("describeStatus never exposes key material", () => {
    // Configure first, so the check covers the state the bot runs in.
    useFakeFirestore();

    const status = firestoreConnection.describeStatus();
    const dump = JSON.stringify(status);

    assert.ok(!dump.includes("BEGIN PRIVATE KEY"), "private key leaked");
    assert.ok(!dump.includes("test@example"), "client email leaked");
    assert.ok(!dump.includes("not-a-real-key"), "key body leaked");
    assert.strictEqual(status.projectId, "test-project");
    assert.strictEqual(status.explicitServiceAccount, true);
  });

  await check("a configured environment selects Firestore", () => {
    useFakeFirestore();

    assert.strictEqual(firestoreConnection.shouldUseFirestore(), true);
  });

  await check("FIRESTORE_ENABLED=false keeps the bot on JSON", () => {
    const fake = useFakeFirestore();

    fake.connected = true;
    process.env.FIRESTORE_ENABLED = "false";

    assert.strictEqual(firestoreConnection.shouldUseFirestore(), false);

    process.env.FIRESTORE_ENABLED = "true";
  });

  await check("the health check passes against a reachable store", async () => {
    useFakeFirestore();

    const health = await firestoreConnection.healthCheck();

    assert.strictEqual(health.ok, true, health.error);
  });

  section("orders survive the move with their ids and fields");

  await check("hydrate loads the mirror from Firestore", async () => {
    const fake = useFakeFirestore();

    await fake.collection("orders").doc("HG-1").set(makeOrder({ id: "HG-1" }));
    await fake.collection("orders").doc("HG-2").set(makeOrder({ id: "HG-2", createdAt: "2026-10-02T00:00:00.000Z" }));

    const result = await orders.hydrate();

    assert.strictEqual(result.mode, "firestore");
    assert.strictEqual(result.orders, 2);
    assert.strictEqual(orders.usingFirestore(), true);
  });

  await check("every field of an order is preserved", async () => {
    const fake = useFakeFirestore();
    const original = makeOrder({ id: "HG-FULL", topupError: "x", providerOrderId: "order-uuid-1" });

    await fake.collection("orders").doc(original.id).set(original);
    await orders.hydrate();

    const stored = orders.getOrders().find((o) => o.id === "HG-FULL");

    assert.strictEqual(stored.id, "HG-FULL");
    assert.strictEqual(stored.playerId, "8595647532");
    assert.strictEqual(stored.productName, "📅 Weekly");
    assert.strictEqual(stored.price, 590);
    assert.strictEqual(stored.status, "pending_payment");
    assert.strictEqual(stored.providerOrderId, "order-uuid-1");
    assert.strictEqual(stored.topupError, "x");
  });

  await check("create writes a document keyed by the order id", async () => {
    useFakeFirestore();
    await orders.hydrate();

    const created = await orders.appendOrder(makeOrder({ id: "HG-NEW" }));

    assert.ok(created, "appendOrder returned nothing");
    assert.strictEqual(orders.getOrders().length, 1);
  });

  await check("create refuses a duplicate order id", async () => {
    const fake = useFakeFirestore();
    await orders.hydrate();

    await orders.appendOrder(makeOrder({ id: "HG-DUP" }));

    const again = await orders.appendOrder(makeOrder({ id: "HG-DUP" }));

    assert.strictEqual(again, null, "a duplicate order was accepted");
    assert.strictEqual(orders.getOrders().length, 1, "duplicate reached the mirror");
    assert.strictEqual(
      [...fake.data.keys()].filter((k) => k.startsWith("orders/")).length,
      1,
      "duplicate reached the store"
    );
  });

  await check("update changes the stored order", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-U").set(makeOrder({ id: "HG-U" }));
    await orders.hydrate();

    const updated = await orders.mutateOrder("HG-U", (current) => {
      current.status = "approved";
      current.approvedAt = "2026-10-03T00:00:00.000Z";

      return current;
    });

    assert.strictEqual(updated.status, "approved");

    const persisted = await fake.collection("orders").doc("HG-U").get();

    assert.strictEqual(persisted.data().status, "approved");
  });

  await check("update of a missing order reports not found", async () => {
    useFakeFirestore();
    await orders.hydrate();

    const decision = {};
    const result = await orders.mutateOrder("HG-NOPE", (current) => current, decision);

    assert.strictEqual(result, null);
    assert.strictEqual(decision.found, false);
    assert.strictEqual(decision.ok, true);
  });

  await check("a mutator that declines writes nothing", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-K").set(makeOrder({ id: "HG-K", status: "pending_approval" }));
    await orders.hydrate();

    let called = 0;

    const result = await orders.mutateOrder("HG-K", (current) => {
      called++;

      if (current.status !== "pending_approval") {
        return current;
      }

      return false;
    });

    assert.strictEqual(called, 1, "declining mutator ran more than once");
    assert.strictEqual(result.status, "pending_approval");
    assert.strictEqual(
      (await fake.collection("orders").doc("HG-K").get()).data().status,
      "pending_approval",
      "a declined update was written anyway"
    );
  });

  section("concurrent activity cannot process an order twice");

  await check("two approvals at once leave exactly one approval", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-R").set(makeOrder({ id: "HG-R", status: "pending_approval" }));
    await orders.hydrate();

    const decisions = [];
    let approvals = 0;

    // The real approval guard: only the first caller may flip the status.
    const approve = async () => {
      const decision = {};

      await orders.mutateOrder(
        "HG-R",
        (current) => {
          if (current.status !== "pending_approval") {
            return false;
          }

          approvals++;

          current.status = "approved";
          current.topupStatus = "ready_for_topup";

          return current;
        },
        decision
      );

      decisions.push(decision);
    };

    await Promise.all([approve(), approve()]);

    assert.strictEqual(approvals, 1, `approved ${approvals} times`);
    assert.strictEqual(
      (await fake.collection("orders").doc("HG-R").get()).data().topupStatus,
      "ready_for_topup"
    );
    assert.ok(
      decisions.some((d) => d.found === true),
      "no caller reported success"
    );
  });

  await check("concurrent appends all survive", async () => {
    useFakeFirestore();
    await orders.hydrate();

    await Promise.all(
      Array.from({ length: 10 }, (unused, i) =>
        orders.appendOrder(
          makeOrder({
            id: `HG-C${i}`,
            createdAt: `2026-10-01T00:00:0${i}.000Z`,
          })
        )
      )
    );

    assert.strictEqual(orders.getOrders().length, 10);
  });

  await check("a failed write is reported, not assumed", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-DOWN").set(makeOrder({ id: "HG-DOWN" }));
    await orders.hydrate();

    fake.connected = false;

    const result = await orders.mutateOrder("HG-DOWN", (current) => {
      current.status = "approved";

      return current;
    });

    fake.connected = true;

    assert.strictEqual(result, null, "a failed write reported success");
    assert.strictEqual(
      (await fake.collection("orders").doc("HG-DOWN").get()).data().status,
      "pending_payment",
      "the mirror was updated even though the write failed"
    );
  });

  section("queries do not need the whole order book");

  await check("getOrder reads a single document", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-Q1").set(makeOrder({ id: "HG-Q1" }));
    await orders.hydrate();

    const found = await orders.getOrder("HG-Q1");

    assert.strictEqual(found.id, "HG-Q1");
    assert.strictEqual(await orders.getOrder("HG-MISSING"), null);
  });

  await check("getUserOrders filters by customer", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("A").set(makeOrder({ id: "A", userId: 1 }));
    await fake.collection("orders").doc("B").set(makeOrder({ id: "B", userId: 1, createdAt: "2026-10-05T00:00:00.000Z" }));
    await fake.collection("orders").doc("C").set(makeOrder({ id: "C", userId: 2 }));
    await orders.hydrate();

    const mine = await orders.getUserOrders(1);

    assert.strictEqual(mine.length, 2);
    assert.ok(mine.every((o) => o.userId === 1));
    // Sorted oldest first, like the JSON file was.
    assert.strictEqual(mine[0].id, "A");
    assert.strictEqual(mine[1].id, "B");
  });

  await check("getOrdersByStatus filters by state", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("S1").set(makeOrder({ id: "S1", status: "approved" }));
    await fake.collection("orders").doc("S2").set(makeOrder({ id: "S2", status: "pending_approval" }));
    await fake.collection("orders").doc("S3").set(makeOrder({ id: "S3", status: "approved" }));
    await orders.hydrate();

    const approved = await orders.getOrdersByStatus("approved");

    assert.strictEqual(approved.length, 2);

    const pending = await orders.getPendingOrders();

    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].id, "S2");
  });

  await check("getOrderStats counts states without loading records", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("T1").set(makeOrder({ id: "T1", status: "approved" }));
    await fake.collection("orders").doc("T2").set(makeOrder({ id: "T2", status: "approved", price: 410 }));
    await fake.collection("orders").doc("T3").set(makeOrder({ id: "T3", status: "rejected", price: 999 }));
    await orders.hydrate();

    const stats = await orders.getOrderStats();

    assert.strictEqual(stats.counts.approved, 2);
    assert.strictEqual(stats.counts.rejected, 1);
    assert.strictEqual(stats.total, 3);
    // Only paid orders count as revenue.
    assert.strictEqual(stats.revenue, 1000);
  });

  section("the catalogue keeps its ids and callback strings");

  await check("a product keeps the id the buttons send", async () => {
    const fake = useFakeFirestore();

    const game = { id: "blood_strike", name: "Blood Strike", emoji: "🎮", paused: false, idLabel: "Player ID", idExample: "586019939994" };
    const pkg = { id: "elite", name: "🎫 Strike Pass Elite", price: 1100, paused: false, note: "", sub_category_id: 1649, requirements: [] };

    const document = products.toDocument(game, pkg);

    await fake.collection("products").doc(document.productId).set(document);
    await products.refresh();

    assert.strictEqual(document.productId, "blood_strike~elite");
    assert.strictEqual(document.subCategoryId, 1649);

    const found = await products.getProduct("blood_strike", "elite");

    assert.ok(found, "product lookup failed");
    assert.strictEqual(found.pkg.price, 1100);
    assert.strictEqual(found.pkg.sub_category_id, 1649);
    assert.strictEqual(found.game.idExample, "586019939994");
  });

  await check("a whole catalogue round-trips into the nested shape", async () => {
    const fake = useFakeFirestore();

    const catalog = JSON.parse(
      require("fs").readFileSync(require("path").join(__dirname, "..", "catalog.json"), "utf8")
    );

    for (const game of catalog.games) {
      for (const pkg of game.packages) {
        const document = products.toDocument(game, pkg);

        await fake.collection("products").doc(document.productId).set(document);
      }
    }

    await products.refresh();

    const loaded = products.getCached();

    assert.strictEqual(loaded.games.length, catalog.games.length);

    const total = catalog.games.reduce((sum, g) => sum + g.packages.length, 0);
    const loadedTotal = loaded.games.reduce((sum, g) => sum + g.packages.length, 0);

    assert.strictEqual(loadedTotal, total);

    // Every sub_category_id has to survive, or player validation breaks.
    for (const game of catalog.games) {
      for (const pkg of game.packages) {
        const found = await products.getProduct(game.id, pkg.id);

        assert.strictEqual(
          found.pkg.sub_category_id,
          pkg.sub_category_id,
          `sub_category_id changed for ${game.id}~${pkg.id}`
        );
      }
    }
  });

  section("customer records");

  await check("a user is created and read back", async () => {
    const fake = useFakeFirestore();

    const created = await users.upsertUser({
      userId: 555,
      username: "methsarap",
      firstName: "Methsara",
    });

    assert.strictEqual(created.ok, true, created.error);

    const found = await users.getUser(555);

    assert.strictEqual(found.telegramUserId, 555);
    assert.strictEqual(found.username, "methsarap");
    assert.ok(found.createdAt, "createdAt was not set");
  });

  await check("a later visit does not blank the stored name", async () => {
    const fake = useFakeFirestore();

    await users.upsertUser({ userId: 556, username: "real", firstName: "Real" });
    await users.upsertUser({ userId: 556 });

    const found = await users.getUser(556);

    assert.strictEqual(found.username, "real");
    assert.strictEqual(found.firstName, "Real");
  });

  await check("a user is derived from an order for migration", async () => {
    const fake = useFakeFirestore();

    const result = await users.upsertUserFromOrder(
      makeOrder({ id: "HG-U1", userId: 777, username: "fromorder", firstName: "From" })
    );

    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual((await users.getUser(777)).username, "fromorder");
  });

  await check("an order with no user is refused rather than stored blank", async () => {
    const result = await users.upsertUserFromOrder({ id: "x" });

    assert.strictEqual(result.ok, false);
  });

  section("cleanup");

  await check("the JSON files were not written to", () => {
    const fake = useFakeFirestore();
    const fs = require("fs");
    const path = require("path");

    const raw = fs.readFileSync(path.join(__dirname, "..", "orders.json"), "utf8");

    assert.ok(Array.isArray(JSON.parse(raw)), "orders.json is not a list");
    assert.ok(
      ![...fake.data.keys()].some((k) => k.endsWith(".json")),
      "a file path leaked into Firestore"
    );
  });

  await check("an unreachable Firestore falls back instead of stalling", async () => {
    const fake = useFakeFirestore();

    // Never resolves, the way an unreachable host behaves.
    fake.hang = true;

    const started = Date.now();
    const result = await orders.hydrate();
    const elapsed = Date.now() - started;

    fake.hang = false;

    assert.strictEqual(result.mode, "json", "did not fall back to JSON");
    assert.ok(
      elapsed < 30000,
      `startup waited ${elapsed}ms before giving up`
    );
    // The fallback must report the orders it actually loaded, not zero.
    assert.strictEqual(
      result.orders,
      JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "..", "orders.json"), "utf8")).length,
      "fallback reported the wrong order count"
    );
  });

  await check("orders.describe reports the mode and counts", async () => {
    const fake = useFakeFirestore();
    await fake.collection("orders").doc("HG-D").set(makeOrder({ id: "HG-D" }));
    await orders.hydrate();

    const info = orders.describe();

    assert.strictEqual(info.mode, "firestore");
    assert.strictEqual(info.mirroredOrders, 1);
    assert.strictEqual(info.mirrorReady, true);
    assert.ok(!JSON.stringify(info).includes("BEGIN PRIVATE KEY"));
  });

  await check("REST transport survives every value an order carries", async () => {
    const { encodeFields, decodeFields } = require("../src/database/firestoreRest");

    // The orders these encode hold strings, numbers, nulls, arrays and nested
    // maps, so a mistake here would quietly corrupt real order data.
    const order = makeOrder({ id: "HG-REST" });

    const round = decodeFields(encodeFields(order));

    assert.deepStrictEqual(
      round,
      order,
      "an order did not survive a REST encode/decode round trip"
    );

    assert.strictEqual(
      decodeFields(encodeFields({ big: 9007199254740991 })).big,
      9007199254740991,
      "a large integer lost precision"
    );

    assert.strictEqual(
      decodeFields(encodeFields({ half: 0.1 })).half,
      0.1,
      "a non-integer number changed value"
    );

    assert.strictEqual(
      decodeFields(encodeFields({ text: "λ රු 充值 🎮" })).text,
      "λ රු 充值 🎮",
      "non-ASCII text did not survive"
    );

    // undefined is not a Firestore value; it must be dropped rather than sent.
    assert.ok(
      !("gone" in encodeFields({ gone: undefined, kept: 1 })),
      "an undefined value reached the wire"
    );

    assert.strictEqual(
      decodeFields(encodeFields({ nothing: null })).nothing,
      null,
      "null did not survive"
    );
  });

  console.log(
    `\nALL DATABASE CHECKS PASSED  (${passed} passed, ${failed} failed)`
  );

  // Leave the environment as it was found.
  delete process.env.FIREBASE_PRIVATE_KEY;

  process.exit(failed === 0 ? 0 : 1);
})();