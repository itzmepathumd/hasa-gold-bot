/*
|--------------------------------------------------------------------------
| ANALYTICS
|--------------------------------------------------------------------------
| Pure aggregation over orders.json. No Telegram or IO here so the maths
| can be unit tested; index.js only renders the results.
|
| Revenue is counted from approved orders only. Pending orders are shown
| separately as "in flight" so a dashboard never implies money that has
| not actually been delivered.
*/

const APPROVED = "approved";

function money(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/*
|--------------------------------------------------------------------------
| USER ROLL-UP
|--------------------------------------------------------------------------
| Groups orders by Telegram user id and derives spend, order counts,
| approval rate and favourite product.
*/
function buildUsers(orders) {
  const byUser = new Map();

  for (const order of orders || []) {
    const id = order.userId ?? "unknown";

    if (!byUser.has(id)) {
      byUser.set(id, {
        userId: id,
        username: order.username || null,
        firstName: order.firstName || "",
        orders: 0,
        approved: 0,
        pending: 0,
        rejected: 0,
        spend: 0,
        firstSeen: order.createdAt || null,
        lastSeen: order.createdAt || null,
        favourite: null,
        games: new Set(),
      });
    }

    const user = byUser.get(id);

    // Later orders may carry a handle the first one lacked.
    if (order.username) user.username = order.username;
    if (order.firstName) user.firstName = order.firstName;

    user.orders += 1;

    if (order.status === APPROVED) {
      user.approved += 1;
      user.spend += Number(order.price || 0);
    } else if (order.status === "pending_approval" || order.status === "pending_payment") {
      user.pending += 1;
    } else if (order.status === "rejected") {
      user.rejected += 1;
    }

    const stamp = order.createdAt || null;
    if (stamp) {
      if (!user.firstSeen || stamp < user.firstSeen) user.firstSeen = stamp;
      if (!user.lastSeen || stamp > user.lastSeen) user.lastSeen = stamp;
    }

    if (order.gameName) user.games.add(order.gameName);

    const key = order.productName || "Unknown";
    user.favourite = user.favourite || new Map();
    user.favourite.set(key, (user.favourite.get(key) || 0) + 1);
  }

  const users = [...byUser.values()].map((u) => {
    const fav = [...u.favourite.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      userId: u.userId,
      username: u.username,
      firstName: u.firstName,
      orders: u.orders,
      approved: u.approved,
      pending: u.pending,
      rejected: u.rejected,
      spend: u.spend,
      firstSeen: u.firstSeen,
      lastSeen: u.lastSeen,
      favourite: fav ? fav[0] : null,
      games: [...u.games],
    };
  });

  // Richest customers first.
  users.sort((a, b) => b.spend - a.spend || b.orders - a.orders);

  return users;
}

/*
|--------------------------------------------------------------------------
| DASHBOARD SUMMARY
|--------------------------------------------------------------------------
*/
function summarise(orders) {
  const list = orders || [];

  const approved = list.filter((o) => o.status === APPROVED);
  const inFlight = list.filter(
    (o) => o.status === "pending_approval" || o.status === "pending_payment"
  );
  const rejected = list.filter((o) => o.status === "rejected");

  const revenue = approved.reduce((t, o) => t + Number(o.price || 0), 0);
  const inFlightValue = inFlight.reduce((t, o) => t + Number(o.price || 0), 0);

  const users = buildUsers(list);

  const avgOrder = approved.length ? revenue / approved.length : 0;
  const approvalRate = list.length
    ? (approved.length / list.length) * 100
    : 0;

  return {
    totalOrders: list.length,
    approved: approved.length,
    inFlight: inFlight.length,
    rejected: rejected.length,
    revenue,
    inFlightValue,
    avgOrder,
    approvalRate,
    uniqueUsers: users.length,
    topSpender: users.find((u) => u.spend > 0) || null,
  };
}

/*
|--------------------------------------------------------------------------
| DAILY REVENUE (last N days)
|--------------------------------------------------------------------------
*/
function dailyRevenue(orders, days = 7) {
  const out = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = day.toISOString().slice(0, 10);

    out.push({ date: key, label: day.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }), orders: 0, revenue: 0 });
  }

  const index = new Map(out.map((d) => [d.date, d]));

  for (const order of orders || []) {
    if (order.status !== APPROVED || !order.approvedAt) continue;

    const dayKey = String(order.approvedAt).slice(0, 10);
    const bucket = index.get(dayKey);

    if (bucket) {
      bucket.orders += 1;
      bucket.revenue += Number(order.price || 0);
    }
  }

  return out;
}

/*
|--------------------------------------------------------------------------
| BREAKDOWNS
|--------------------------------------------------------------------------
*/
function byGame(orders) {
  const totals = new Map();

  for (const order of orders || []) {
    if (order.status !== APPROVED) continue;

    const key = order.gameName || "Unassigned";
    const row = totals.get(key) || { name: key, orders: 0, revenue: 0 };

    row.orders += 1;
    row.revenue += Number(order.price || 0);
    totals.set(key, row);
  }

  return [...totals.values()].sort((a, b) => b.revenue - a.revenue);
}

function byProduct(orders, limit = 8) {
  const totals = new Map();

  for (const order of orders || []) {
    if (order.status !== APPROVED) continue;

    const key = order.productName || "Unknown";
    const row = totals.get(key) || { name: key, orders: 0, revenue: 0 };

    row.orders += 1;
    row.revenue += Number(order.price || 0);
    totals.set(key, row);
  }

  return [...totals.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit);
}

/*
|--------------------------------------------------------------------------
| SEARCH
|--------------------------------------------------------------------------
| Matches a user by telegram id, @username, or display name.
*/
function findUsers(users, query) {
  const q = String(query || "").trim().toLowerCase().replace(/^@/, "");

  if (!q) return users;

  return users.filter(
    (u) =>
      String(u.userId) === q ||
      (u.username || "").toLowerCase().includes(q) ||
      (u.firstName || "").toLowerCase().includes(q)
  );
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
| Telegram caps a message at 4096 chars, so long lists are paged.
*/
function paginate(items, page = 0, perPage = 6) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(0, page), pages - 1);

  return {
    items: items.slice(current * perPage, current * perPage + perPage),
    page: current,
    pages,
    total,
  };
}

module.exports = {
  buildUsers,
  summarise,
  dailyRevenue,
  byGame,
  byProduct,
  findUsers,
  paginate,
  money,
  when,
};