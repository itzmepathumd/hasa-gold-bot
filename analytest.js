const assert = require("assert");
const analytics = require("./analytics");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}  -> ${err.message}`);
  }
}

const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

const orders = [
  {
    id: "HG-1-A", userId: 10, username: "alpha", firstName: "Alpha",
    productName: "💎 100 Gold", gameName: "Blood Strike",
    price: 100, status: "approved", createdAt: iso(6), approvedAt: iso(6),
  },
  {
    id: "HG-2-A", userId: 10, username: "alpha", firstName: "Alpha",
    productName: "💎 100 Gold", gameName: "Blood Strike",
    price: 250, status: "approved", createdAt: iso(4), approvedAt: iso(4),
  },
  {
    id: "HG-3-A", userId: 10, username: "alpha", firstName: "Alpha",
    productName: "🎫 Pass", gameName: "Blood Strike",
    price: 999, status: "pending_approval", createdAt: iso(1),
  },
  {
    id: "HG-4-B", userId: 20, username: "beta", firstName: "Beta",
    productName: "📅 Weekly", gameName: "Free Fire",
    price: 590, status: "approved", createdAt: iso(2), approvedAt: iso(2),
  },
  {
    id: "HG-5-C", userId: 30, firstName: "Gamma",
    productName: "📅 Weekly", gameName: "Free Fire",
    price: 590, status: "rejected", createdAt: iso(3), rejectedAt: iso(3),
  },
];

console.log("\n== user roll-up ==");

check("groups by user id", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(users.length, 3);
});

check("spend counts approved only", () => {
  const alpha = analytics.buildUsers(orders).find((u) => u.userId === 10);
  assert.strictEqual(alpha.spend, 350);
});

check("pending is tracked separately from spend", () => {
  const alpha = analytics.buildUsers(orders).find((u) => u.userId === 10);
  assert.strictEqual(alpha.pending, 1);
  assert.strictEqual(alpha.approved, 2);
});

check("rejected counted and not spent", () => {
  const gamma = analytics.buildUsers(orders).find((u) => u.userId === 30);
  assert.strictEqual(gamma.rejected, 1);
  assert.strictEqual(gamma.spend, 0);
});

check("sorted by spend descending", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(users[0].userId, 20);
  assert.strictEqual(users[1].userId, 10);
});

check("username picked up when later order has one", () => {
  const users = analytics.buildUsers([
    { userId: 7, firstName: "NoName", productName: "x", price: 1, status: "approved", createdAt: iso(1) },
    { userId: 7, username: "late", firstName: "NoName", productName: "x", price: 1, status: "approved", createdAt: iso(2) },
  ]);
  assert.strictEqual(users[0].username, "late");
});

check("favourite product is most frequent", () => {
  const alpha = analytics.buildUsers(orders).find((u) => u.userId === 10);
  assert.strictEqual(alpha.favourite, "💎 100 Gold");
});

check("firstSeen is earliest, lastSeen is latest", () => {
  const alpha = analytics.buildUsers(orders).find((u) => u.userId === 10);
  assert.ok(alpha.firstSeen < alpha.lastSeen);
});

check("survives missing fields", () => {
  const users = analytics.buildUsers([
    { userId: 1, status: "approved", price: 10, createdAt: iso(1) },
  ]);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].spend, 10);
});

check("empty order list returns no users", () => {
  assert.deepStrictEqual(analytics.buildUsers([]), []);
  assert.deepStrictEqual(analytics.buildUsers(undefined), []);
});

console.log("\n== summary ==");

check("revenue is approved only", () => {
  assert.strictEqual(analytics.summarise(orders).revenue, 940);
});

check("in-flight value excludes pending from revenue", () => {
  assert.strictEqual(analytics.summarise(orders).inFlightValue, 999);
  assert.strictEqual(analytics.summarise(orders).revenue, 940);
});

check("counts unique users", () => {
  assert.strictEqual(analytics.summarise(orders).uniqueUsers, 3);
});

check("avg order uses approved only", () => {
  assert.strictEqual(analytics.summarise(orders).avgOrder, 940 / 3);
});

check("approval rate is percent of all orders", () => {
  const s = analytics.summarise(orders);
  assert.ok(Math.abs(s.approvalRate - 60) < 0.001);
});

check("empty input gives zeroes not NaN", () => {
  const s = analytics.summarise([]);
  assert.strictEqual(s.revenue, 0);
  assert.strictEqual(s.avgOrder, 0);
  assert.strictEqual(s.approvalRate, 0);
  assert.strictEqual(s.topSpender, null);
});

console.log("\n== daily revenue ==");

check("returns requested number of days", () => {
  assert.strictEqual(analytics.dailyRevenue(orders, 7).length, 7);
});

check("buckets approved orders by approval date", () => {
  const daily = analytics.dailyRevenue(orders, 7);
  const today = daily[daily.length - 1];
  assert.strictEqual(today.orders, 0);
  assert.ok(daily.some((d) => d.orders > 0));
});

check("excludes non-approved orders", () => {
  const total = analytics.dailyRevenue(orders, 30).reduce((t, d) => t + d.orders, 0);
  assert.strictEqual(total, 3);
});

console.log("\n== breakdowns ==");

check("by game only counts approved", () => {
  const games = analytics.byGame(orders);
  assert.strictEqual(games.find((g) => g.name === "Blood Strike").revenue, 350);
  assert.strictEqual(games.find((g) => g.name === "Free Fire").revenue, 590);
});

check("by product respects limit", () => {
  assert.strictEqual(analytics.byProduct(orders, 1).length, 1);
});

console.log("\n== search ==");

check("matches by exact id", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(analytics.findUsers(users, "20").length, 1);
});

check("matches by username without @", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(analytics.findUsers(users, "alpha").length, 1);
  assert.strictEqual(analytics.findUsers(users, "@alpha").length, 1);
});

check("matches by display name, case-insensitive", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(analytics.findUsers(users, "BETA").length, 1);
});

check("blank query returns everyone", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(analytics.findUsers(users, "").length, 3);
});

check("no match returns empty", () => {
  const users = analytics.buildUsers(orders);
  assert.strictEqual(analytics.findUsers(users, "zzz").length, 0);
});

console.log("\n== pagination ==");

check("pages are clamped to range", () => {
  const p = analytics.paginate([1, 2, 3], 99, 2);
  assert.strictEqual(p.page, 1);
  assert.strictEqual(p.pages, 2);
});

check("negative page clamps to first", () => {
  assert.strictEqual(analytics.paginate([1, 2, 3], -5, 2).page, 0);
});

check("empty input still yields one page", () => {
  const p = analytics.paginate([], 0, 6);
  assert.strictEqual(p.pages, 1);
  assert.deepStrictEqual(p.items, []);
});

console.log("\n== formatting ==");

check("money never throws on undefined", () => {
  assert.strictEqual(analytics.money(undefined), "0");
});

check("when returns dash for missing dates", () => {
  assert.strictEqual(analytics.when(null), "—");
  assert.strictEqual(analytics.when("garbage"), "—");
});

console.log(
  failed
    ? `${failed} CHECK(S) FAILED  (${passed} passed, ${failed} failed)`
    : `ALL ANALYTICS CHECKS PASSED  (${passed} passed, 0 failed)`
);

process.exit(failed ? 1 : 0);