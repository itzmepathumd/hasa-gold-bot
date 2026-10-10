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

const APPROVED = "topup_completed";
const REVENUE_STATUSES = new Set(["approved", "topup_completed"]);

/*
| A store day is a Colombo day. Timestamps are stored as UTC ISO strings,
| so slicing one to "2026-10-04" gives the UTC date, which is a different
| day for anything after 18:30 UTC. Reading the UTC date off a timestamp and
| comparing it with a locally built midnight puts orders in the wrong bucket:
| a sale at 22:00 Colombo time lands on the previous day, and every chart
| heading is a day early.
|
| Both sides of that comparison now go through this function, so the bucket
| an order is counted into is the day the shop actually saw the sale. It
| formats the local calendar fields rather than shifting by a fixed offset,
| which keeps it correct without assuming anything about daylight saving.
*/
function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function money(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Sri Lanka timezone UTC+5:30
  const slTime = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return slTime.toISOString().slice(0, 16).replace("T", " ") + " (SLT)";
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

    if (REVENUE_STATUSES.has(order.status)) {
      user.approved += 1;
      user.spend += Number(order.price || 0);
    } else if (order.status === "pending_approval" || order.status === "pending_payment") {
      user.pending += 1;
    } else if (order.status === "rejected" || order.status === "topup_failed") {
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

  const approved = list.filter((o) => REVENUE_STATUSES.has(o.status));
  const inFlight = list.filter(
    (o) => o.status === "pending_approval" || o.status === "pending_payment"
  );
  const rejected = list.filter(
    (o) => o.status === "rejected" || o.status === "topup_failed"
  );

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
    const key = localDayKey(day);

    out.push({ date: key, label: day.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }), orders: 0, revenue: 0 });
  }

  const index = new Map(out.map((d) => [d.date, d]));

  for (const order of orders || []) {
    if (!REVENUE_STATUSES.has(order.status)) continue;

    const timestamp = order.status === "topup_completed"
      ? order.topupCompletedAt
      : order.approvedAt;

    if (!timestamp) continue;

    const bucket = index.get(localDayKey(new Date(timestamp)));

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
    if (!REVENUE_STATUSES.has(order.status)) continue;

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
    if (!REVENUE_STATUSES.has(order.status)) continue;

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