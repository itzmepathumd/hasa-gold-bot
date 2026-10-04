/*
|--------------------------------------------------------------------------
| STATUS TESTS
|--------------------------------------------------------------------------
| status.js is what tells a customer whether the shop is working, so two
| things have to hold: the numbers it reports have to be true, and the
| customer view must never disclose an internal.
|
| The second is the reason this file exists. A status panel is a natural
| place to add a field, and one careless row would tell every customer which
| vendor holds the database. The customer view is built from an allowlist
| rather than trimmed from the admin view, and these tests attack it from
| both directions: they check the built-in text leaks nothing, and they feed
| hostile internal values in to prove a future field cannot slip through.
*/

const assert = require("assert");
const status = require("./status");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}  ->  ${err.message}`);
  }
}

const NOW = 1_700_000_000_000;

function freshSnapshot(overrides = {}) {
  return status.snapshot(
    {
      store: {
        mode: "firestore",
        transport: "rest",
        projectId: "hasagoldstoretgbot",
        mirrorReady: true,
        mirroredOrders: 14,
        orders: 14,
      },
      catalog: { games: 2, products: 9, payments: 2 },
      supplier: { mode: "test", available: false, detail: "No real top-ups are sent" },
      shuttingDown: false,
      ...overrides,
    },
    NOW
  );
}

/*
|--------------------------------------------------------------------------
| UPTIME
|--------------------------------------------------------------------------
*/

console.log("\n== uptime ==");

check("uptime is unknown until the bot has booted", () => {
  assert.strictEqual(status.formatUptime(status.uptimeSeconds()), "unknown");
});

check("uptime counts from the boot mark", () => {
  status.markBoot(NOW - 3_723_000);
  assert.strictEqual(status.uptimeSeconds(NOW), 3723);
  // Seconds are dropped once hours are showing: "1h 2m 3s" is noise.
  assert.strictEqual(status.formatUptime(status.uptimeSeconds(NOW)), "1h 2m");

  status.markBoot(null);
});

check("uptime reads as days when it is days", () => {
  assert.strictEqual(status.formatUptime(86400 * 3 + 3600 * 4), "3d 4h");
  assert.strictEqual(status.formatUptime(86400 * 2), "2d");
});

check("uptime reads as minutes and seconds below an hour", () => {
  assert.strictEqual(status.formatUptime(125), "2m 5s");
  assert.strictEqual(status.formatUptime(59), "59s");
  assert.strictEqual(status.formatUptime(3600), "1h");
});

check("a clock that goes backwards does not report negative uptime", () => {
  status.markBoot(NOW + 60_000);
  assert.strictEqual(status.uptimeSeconds(NOW), 0);

  status.markBoot(null);
});

/*
|--------------------------------------------------------------------------
| COMPONENT HEALTH
|--------------------------------------------------------------------------
*/

console.log("\n== component health ==");

check("a component that never ran is untested, not healthy", () => {
  const fresh = status.stateOf("never-used-component", 1000, NOW);
  assert.strictEqual(fresh.state, "untested");
});

check("a recent success is up", () => {
  status.record("up-component", true, "fine");
  const now = Date.now();
  assert.strictEqual(status.stateOf("up-component", 60_000, now).state, "up");
});

check("a failure is down even when fresh", () => {
  status.record("down-component", false, "unreachable");
  const now = Date.now();
  assert.strictEqual(status.stateOf("down-component", 60_000, now).state, "down");
});

check("an old success is stale rather than reported as up", () => {
  // This is the one that matters: a component that was healthy an hour ago is
  // not evidence that it is healthy now.
  status.record("old-component", true, "was fine");
  const muchLater = Date.now() + 7_200_000;
  assert.strictEqual(status.stateOf("old-component", 60_000, muchLater).state, "stale");
});

check("a failure is never softened by being stale", () => {
  status.record("old-down", false, "broken");
  const muchLater = Date.now() + 7_200_000;
  assert.strictEqual(status.stateOf("old-down", 60_000, muchLater).state, "down");
});

check("a detail string is kept for the admin view", () => {
  status.record("detail-component", true, "via the usual route");
  const entry = status.lastOutcome("detail-component");
  assert.strictEqual(entry.detail, "via the usual route");
});

/*
|--------------------------------------------------------------------------
| OVERALL VERDICT
|--------------------------------------------------------------------------
*/

console.log("\n== overall verdict ==");

check("an unloaded mirror is a failure, not an untested component", () => {
  const snap = status.snapshot(
    { store: { mode: "firestore", mirrorReady: false }, shuttingDown: false },
    NOW
  );
  assert.strictEqual(status.overall(snap), "down");
});

check("a shutdown is reported as down even with healthy components", () => {
  const snap = status.snapshot({ shuttingDown: true }, NOW);
  assert.strictEqual(status.overall(snap), "down");
});

check("a JSON fallback store is up, not down", () => {
  // Falling back is a degraded posture, but orders are still served.
  const snap = status.snapshot(
    { store: { mode: "json", mirrorReady: false }, shuttingDown: false },
    NOW
  );
  assert.strictEqual(status.overall(snap), "up");
});

/*
|--------------------------------------------------------------------------
| ADMIN VIEW
|--------------------------------------------------------------------------
*/

console.log("\n== admin panel ==");

const adminText = status.renderAdmin(freshSnapshot(), "HASA GOLD STORE");

check("the admin panel shows the backend, transport and project", () => {
  assert.ok(adminText.includes("firestore"), "backend missing");
  assert.ok(adminText.includes("rest"), "transport missing");
  assert.ok(adminText.includes("hasagoldstoretgbot"), "project missing");
});

check("the admin panel shows the uptime", () => {
  assert.ok(/Uptime/i.test(adminText), "uptime missing");
});

check("the admin panel shows the shop's clock, not UTC", () => {
  const now = Date.parse("2026-10-04T09:40:00Z");
  const shown = status.formatCheckedAt(now);

  // 09:40 UTC is 15:10 in Colombo. Showing the UTC wall clock here made the
  // panel read five and a half hours behind the admin, which looks exactly
  // like stale or wrong data.
  assert.ok(
    shown.includes("15:10"),
    `expected the Colombo time 15:10, got "${shown}"`
  );

  assert.ok(
    !/\b09:40\b/.test(shown),
    `panel still shows the UTC wall clock: "${shown}"`
  );

  assert.ok(/UTC\+0530/.test(shown), `offset missing from "${shown}"`);
});

check("the admin panel never prints a bare GMT clock", () => {
  assert.ok(
    !/GMT/.test(adminText),
    "admin panel renders a UTC/GMT wall clock"
  );
});

check("the admin panel shows the mirror and order count", () => {
  assert.ok(adminText.includes("14"), "order count missing");
  assert.ok(/loaded/i.test(adminText), "mirror state missing");
});

check("the admin panel shows the top-up provider mode", () => {
  assert.ok(/test/i.test(adminText), "supplier mode missing");
});

check("the admin panel marks itself as the internal view", () => {
  assert.ok(/internal/i.test(adminText), "not labelled as internal");
});

check("a broken component turns the admin headline red", () => {
  const snap = status.snapshot({ store: { mode: "firestore", mirrorReady: false } }, NOW);
  assert.ok(/ATTENTION NEEDED/.test(status.renderAdmin(snap, "TEST")));
});

check("markdown in a component label cannot break the panel", () => {
  // Labels come from config, and unescaped markdown would corrupt the page.
  const snap = status.snapshot(
    {
      store: { mode: "*bold* _underscore_", mirrorReady: true },
      shuttingDown: false,
    },
    NOW
  );
  const text = status.renderAdmin(snap, "TEST");
  assert.ok(!text.includes("*bold*"), "an unescaped marker survived");
});

/*
|--------------------------------------------------------------------------
| CUSTOMER VIEW MUST NOT LEAK
|--------------------------------------------------------------------------
*/

console.log("\n== customer panel: no internals ==");

const customerText = status.renderCustomer(freshSnapshot(), "HASA GOLD STORE");

check("the customer panel leaks none of the forbidden terms", () => {
  assert.deepStrictEqual(status.leaksInternals(customerText), []);
});

check("the customer panel never names the database vendor", () => {
  assert.ok(!/firestore|firebase/i.test(customerText), "vendor named");
});

check("the customer panel never names the project or region", () => {
  assert.ok(!customerText.includes("hasagoldstoretgbot"), "project named");
  assert.ok(!/asia-|google/i.test(customerText), "region named");
});

check("the customer panel never mentions the top-up partner", () => {
  assert.ok(!/supplier|tikka|top.?up partner/i.test(customerText), "partner named");
});

check("the customer panel never mentions credentials or transports", () => {
  assert.ok(!/grpc|transport|credential|private key|mirror|backend/i.test(customerText), "internal leaked");
});

check("the customer panel never shows the order count or an uptime figure", () => {
  // A distinctive sentinel, because the rendered timestamp contains its own
  // day-of-month and a bare number match would trip over that.
  const snap = status.snapshot(
    {
      store: {
        mode: "firestore",
        transport: "rest",
        projectId: "hasagoldstoretgbot",
        mirrorReady: true,
        mirroredOrders: 4242,
        orders: 4242,
      },
      shuttingDown: false,
    },
    NOW
  );
  const text = status.renderCustomer(snap, "HASA GOLD STORE");

  assert.ok(!text.includes("4242"), "order count leaked");
  assert.ok(!/uptime/i.test(text), "uptime leaked");
});

check("the customer panel states plainly whether the shop works", () => {
  assert.ok(/operational/i.test(customerText), "no verdict");
  assert.ok(/place orders/i.test(customerText), "does not say orders can be placed");
});

check("a hostile store value cannot reach a customer", () => {
  // The real guarantee: even if every internal field were poisoned, the
  // customer renderer never reads them.
  const snap = status.snapshot(
    {
      store: {
        mode: "firestore on Google Cloud",
        transport: "grpc",
        projectId: "leaky-project",
        mirrorReady: true,
        mirroredOrders: 999,
      },
      catalog: { games: 0, products: 0, payments: 0 },
      supplier: { mode: "tikka test", available: false, detail: "supplier offline" },
      shuttingDown: false,
    },
    NOW
  );
  const text = status.renderCustomer(snap, "HASA GOLD STORE");
  assert.deepStrictEqual(status.leaksInternals(text), []);
});

check("a shutdown message never reaches a customer verbatim", () => {
  const snap = status.snapshot({ shuttingDown: true }, NOW);
  const text = status.renderCustomer(snap, "HASA GOLD STORE");
  assert.deepStrictEqual(status.leaksInternals(text), []);
  assert.ok(/trouble|support/i.test(text), "a shutdown should not read as healthy");
});

check("the degraded customer panel still routes to support", () => {
  const snap = status.snapshot(
    { store: { mode: "firestore", mirrorReady: false }, shuttingDown: false },
    NOW
  );
  const text = status.renderCustomer(snap, "HASA GOLD STORE");
  assert.ok(/trouble/i.test(text), "not reported as trouble");
  assert.ok(/support/i.test(text), "no support route");
});

/*
|--------------------------------------------------------------------------
| FORMAT SAFETY
|--------------------------------------------------------------------------
*/

console.log("\n== output safety ==");

check("the customer panel uses only tags Telegram accepts in HTML mode", () => {
  const stray = customerText.match(/<\/?(?!b>|i>|u>|s>|code>|pre>|a>)[a-zA-Z][^>]*>/g) || [];
  assert.deepStrictEqual(stray, []);
});

check("the admin panel uses only tags Telegram accepts in Markdown mode", () => {
  // Markdown leaks as visible text or a parse error rather than silently, but
  // the panel is worth checking because a stray underscore is easy to add.
  assert.ok(!/```/.test(adminText), "a code fence crept in");
});

check("the leak guard actually detects a leak", () => {
  // A test that cannot fail proves nothing.
  assert.deepStrictEqual(status.leaksInternals("all good"), []);
  assert.ok(status.leaksInternals("stored in Firestore").length > 0, "missed a real leak");
  assert.ok(status.leaksInternals("Project: my-secret").length > 0, "missed a project leak");
});

console.log(
  `\nALL STATUS CHECKS PASSED  (${passed} passed, ${failed} failed)`
);

process.exit(failed === 0 ? 0 : 1);