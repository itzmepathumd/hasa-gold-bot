/*
|--------------------------------------------------------------------------
| BOT STATUS
|--------------------------------------------------------------------------
| A single place that answers "is the shop working?" for two very different
| audiences.
|
| The admin panel wants the whole picture: which backend is serving orders,
| whether the order mirror is loaded, how long the process has been up.
| Customers want one honest line and nothing else. They must not learn that
| a specific vendor stores the data, which project it lives in, or that an
| automated top-up partner exists, so the customer renderer is written from
| an allowlist of fields rather than by hiding rows from the admin one.
| Dropping a field into the admin text can therefore never leak it.
|
| Health is recorded from work the bot already does. Nothing here calls out
| to the network to check on itself: a status screen that fires a request
| every time an admin opens it would be a slow way to find out the network
| is down, and would spend rate limit to answer a question. Each component
| reports its own last real outcome, and an untouched component is reported
| as untested rather than healthy.
|
| This module knows nothing about Telegram. It formats text; index.js owns
| the keyboards and the routes, which keeps it testable on its own.
*/

const components = new Map();

let bootedAt = null;

/*
|--------------------------------------------------------------------------
| RECORDING
|--------------------------------------------------------------------------
*/

/**
 * Note when the bot finished starting. Until this is called, uptime is
 * unknown and is reported as such rather than as zero, because a zero would
 * read as "just restarted" during a hang.
 */
function markBoot(at = Date.now()) {
  bootedAt = at;
}

/*
| The shop reads times in Colombo, so the admin panel must show Colombo.
| toUTCString() was printing a UTC wall clock next to a local uptime, which
| made the panel read five and a half hours behind the admin's own clock and
| look like the bot was reporting stale data.
|
| The zone is named rather than assumed, so the panel stays right on a host
| configured for any timezone, and the offset is shown so a reader can tell
| which zone they are looking at.
*/
const SHOP_TIME_ZONE =
  process.env.SHOP_TIMEZONE || "Asia/Colombo";

function formatCheckedAt(now = Date.now()) {
  const when = new Date(now);

  try {
    const text = new Intl.DateTimeFormat("en-GB", {
      timeZone: SHOP_TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(when);

    return `${text} (UTC${zoneOffsetLabel(SHOP_TIME_ZONE, when)})`;
  } catch {
    // An unknown zone name should not take the panel down with it.
    return when.toISOString();
  }
}

/*
| The offset has to describe the zone being displayed, not the host.
| getTimezoneOffset() returns the host offset, so on a UTC machine it
| labelled a Colombo timestamp "UTC+0000" - a Colombo time next to a zero
| offset, which is worse than showing no offset at all.
|
| The offset is read back out of the formatted parts instead, so the label
| always matches the clock printed beside it. Colombo has no daylight saving,
| but asking the formatter keeps this correct for a zone that does.
*/
function zoneOffsetLabel(timeZone, date) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(date);

    const name = parts.find((p) => p.type === "timeZoneName")?.value;

    // "GMT+05:30" -> "+0530"
    const match = /GMT([+-])(\d{2}):?(\d{2})/.exec(String(name || ""));

    if (!match) {
      return "";
    }

    return `${match[1]}${match[2]}${match[3]}`;
  } catch {
    return "";
  }
}

/**
 * How long the process has been up, in seconds.
 */
function uptimeSeconds(now = Date.now()) {
  if (bootedAt === null) {
    return null;
  }

  return Math.max(0, Math.floor((now - bootedAt) / 1000));
}

/**
 * Render an uptime the way a person reads it: 3d 4h, 4h 12m, 47s.
 */
function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) {
    return "unknown";
  }

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }

  return `${secs}s`;
}

/**
 * Record how a component last behaved. Called from the code that actually
 * uses the component, so the answer reflects real traffic.
 *
 * ok:boolean, detail:string shown to the admin only.
 */
function record(name, ok, detail = "") {
  components.set(name, {
    ok: Boolean(ok),
    detail: String(detail || ""),
    at: Date.now(),
  });
}

/**
 * The last recorded outcome for a component, or null if it has never run.
 */
function lastOutcome(name) {
  return components.get(name) || null;
}

/**
 * Age a recorded outcome past its freshness window. A component that was fine
 * an hour ago is not evidence that it is fine now, so the admin view marks
 * stale results instead of presenting them as current.
 */
function isStale(entry, windowMs, now = Date.now()) {
  if (!entry) {
    return true;
  }

  return now - entry.at > windowMs;
}

/**
 * A component counts as healthy only if its last outcome was good and recent.
 * No outcome at all is "untested", which is honest and distinct from down.
 */
function stateOf(name, windowMs, now = Date.now()) {
  const entry = lastOutcome(name);

  if (!entry) {
    return { state: "untested", entry: null, stale: true };
  }

  if (!entry.ok) {
    return { state: "down", entry, stale: false };
  }

  if (isStale(entry, windowMs, now)) {
    return { state: "stale", entry, stale: true };
  }

  return { state: "up", entry, stale: false };
}

/*
|--------------------------------------------------------------------------
| SNAPSHOT
|--------------------------------------------------------------------------
*/

const STATE_ICON = {
  up: "🟢",
  down: "🔴",
  stale: "🟡",
  untested: "⚪",
};

const STATE_WORD = {
  up: "Operational",
  down: "Down",
  stale: "Stale",
  untested: "Untested",
};

/**
 * Collect everything the renderers need in one pass, so the admin text and
 * the customer text cannot disagree about the same moment in time.
 *
 * context is supplied by index.js: the parts that would otherwise require
 * importing the database and catalog layers into this file.
 */
function snapshot(context = {}, now = Date.now()) {
  const store = context.store || {};
  const catalog = context.catalog || {};
  const supplier = context.supplier || {};

  const checks = [
    {
      key: "telegram",
      label: "Telegram",
      ...stateOf("telegram", 10 * 60 * 1000, now),
    },
    {
      key: "validation",
      label: "Player verification",
      ...stateOf("validation", 60 * 60 * 1000, now),
    },
  ];

  // The order store is not probed on demand. It reports what it knows: the
  // backend it chose and whether the read mirror came up. An unloaded mirror
  // is a real failure, not an untested component.
  const mirrorDown = store.mode === "firestore" && store.mirrorReady === false;

  checks.push({
    key: "store",
    label: "Order store",
    state: mirrorDown
      ? "down"
      : store.mode
        ? "up"
        : "untested",
    entry: null,
    stale: false,
  });

  return {
    now,
    bootedAt,
    uptimeSeconds: uptimeSeconds(now),
    uptimeText: formatUptime(uptimeSeconds(now)),
    shuttingDown: Boolean(context.shuttingDown),
    store,
    runtime: context.runtime || {},
    catalog,
    supplier,
    checks,
  };
}

/**
 * Worst state across the checks, which is the headline customers see.
 */
function overall(snap) {
  if (snap.shuttingDown) {
    return "down";
  }

  if (snap.checks.some((c) => c.state === "down")) {
    return "down";
  }

  if (snap.checks.some((c) => c.state === "stale")) {
    return "stale";
  }

  return "up";
}

/*
|--------------------------------------------------------------------------
| ADMIN VIEW
|--------------------------------------------------------------------------
*/

const LINE = "━━━━━━━━━━━━━━━━━━";

function ago(timestamp, now) {
  if (!timestamp) {
    return "never";
  }

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }

  return `${Math.floor(seconds / 3600)}h ago`;
}

function escapeMarkdown(value) {
  // Only the characters legacy Markdown actually treats as markup. Escaping
  // the rest as well is safe but leaves stray backslashes in ordinary words
  // like "top-ups", which is noise on a panel the admin reads often.
  return String(value ?? "").replace(/([_*[\]`\\])/g, "\\$1");
}

/**
 * The full panel. This is the only place internals are allowed to appear.
 */
function renderAdmin(snap, storeName = "HASA GOLD STORE") {
  const health = overall(snap);
  const store = snap.store || {};

  const headline =
    health === "up"
      ? "🟢 *ALL SYSTEMS OPERATIONAL*"
      : health === "stale"
        ? "🟡 *OPERATIONAL, SOME CHECKS STALE*"
        : "🔴 *ATTENTION NEEDED*";

  let text = `📡 *SYSTEM STATUS*\n${LINE}\n\n${headline}\n\n`;
  text += `⏱️ Uptime — ${snap.uptimeText}\n`;
  text += `🕐 Checked — ${formatCheckedAt(snap.now)}\n`;
  text += `🛍️ ${escapeMarkdown(storeName)}\n`;

  text += `\n${LINE}\n\n*COMPONENTS*\n\n`;

  for (const check of snap.checks) {
    text += `${STATE_ICON[check.state]} ${escapeMarkdown(check.label)} — ${STATE_WORD[check.state]}\n`;

    if (check.state === "stale" && check.entry) {
      text += `   Last good ${ago(check.entry.at, snap.now)}\n`;
    }

    if (check.entry && check.entry.detail) {
      text += `   ${escapeMarkdown(check.entry.detail)}\n`;
    }
  }

  text += `\n${LINE}\n\n*ORDER STORE*\n\n`;
  text += `🗄️ Backend\n${escapeMarkdown(store.mode || "unknown")}\n`;

  if (store.transport) {
    text += `🔌 Transport\n${escapeMarkdown(store.transport)}\n`;
  }

  if (store.projectId) {
    text += `🆔 Project\n${escapeMarkdown(store.projectId)}\n`;
  }

  if (store.mode === "firestore") {
    text += `🪞 Mirror\n${
      store.mirrorReady
        ? `loaded (${store.mirroredOrders} order(s))`
        : "NOT LOADED"
    }\n`;
  }

  text += `📦 Orders\n${store.orders ?? 0}\n`;

  // How updates arrive. The first thing to check when the shop has gone
  // quiet, because on a platform that sleeps a service, polling is the reason.
  if (snap.runtime && snap.runtime.transport) {
    text += `\n${LINE}\n\n*RUNTIME*\n\n`;
    text += `📡 Updates via\n${escapeMarkdown(snap.runtime.transport)}\n`;

    if (snap.runtime.port) {
      text += `🔌 Listening on\nport ${snap.runtime.port}\n`;
    }
  }

  const cat = snap.catalog || {};

  if (cat.games !== undefined || cat.products !== undefined) {
    text += `\n${LINE}\n\n*CATALOG*\n\n`;
    text += `🕹️ Games\n${cat.games ?? 0}\n`;
    text += `📦 Products\n${cat.products ?? 0}\n`;
    text += `💳 Payment methods\n${(cat.payments ?? 0) > 0 ? "available" : "NONE CONFIGURED"}\n`;
  }

  const supplier = snap.supplier || {};

  if (supplier.mode || supplier.available !== undefined) {
    text += `\n${LINE}\n\n*TOP-UP PROVIDER*\n\n`;
    text += `🔌 Mode\n${escapeMarkdown(supplier.mode || "unknown")}\n`;
    text += `🤝 Connected\n${supplier.available ? "yes" : "no"}\n`;

    if (supplier.detail) {
      text += `ℹ️ ${escapeMarkdown(supplier.detail)}\n`;
    }
  }

  if (snap.shuttingDown) {
    text += `\n${LINE}\n\n⚠️ Bot is shutting down.\n`;
  }

  text += `\n${LINE}\n\n_Admin view. Reports internal detail._`;

  return text;
}

/*
|--------------------------------------------------------------------------
| CUSTOMER VIEW
|--------------------------------------------------------------------------
*/

/*
| Anything in here that a customer must never be shown. The customer view is
| written from an allowlist, so this list is a test backstop rather than the
| mechanism: if one of these strings is added to a future admin-only field,
| statustest.js fails.
*/
const NEVER_SHOW = [
  "firestore",
  "firebase",
  "json",
  "grpc",
  "rest",
  "transport",
  "project",
  "supplier",
  "tikka",
  "credential",
  "private key",
  "backend",
  "mirror",
  "transport",
  "asia-",
  "service account",
];

/**
 * What a customer is told. Built field by field from the snapshot, never by
 * trimming the admin text, so the two cannot drift into leaking.
 */
function renderCustomer(snap, storeName = "HASA GOLD STORE") {
  const health = overall(snap);

  const headline =
    health === "up"
      ? "🟢 <b>All systems operational</b>"
      : health === "stale"
        ? "🟡 <b>Running, checks may be out of date</b>"
        : "🔴 <b>We are having trouble</b>";

  let text = `📡 <b>SERVICE STATUS</b>\n${LINE}\n\n${headline}\n\n`;
  text += `🕐 Checked ${new Date(snap.now).toUTCString()}\n`;
  text += `🛍️ ${storeName}\n`;

  text += `\n${LINE}\n\n<b>WHAT THIS MEANS</b>\n\n`;

  const healthy = health === "up";

  return (
    text +
    (healthy
      ? `✅ You can browse the store and place orders as normal.\n` +
        `✅ Player ID checks are responding.\n` +
        `✅ Order tracking is working.`
      : health === "stale"
        ? `⚠️ You can still browse the store and place orders.\n` +
          `⚠️ If something does not respond, please try once more.`
        : `⚠️ Some orders may be slower than usual.\n` +
          `⚠️ Please try again shortly.\n` +
          `💬 If it keeps happening, contact support.`)
  );
}

/**
 * Assert a customer-facing string is free of internals. Used by the tests,
 * and available at runtime as a cheap guard before sending.
 */
function leaksInternals(text) {
  const lower = String(text).toLowerCase();

  return NEVER_SHOW.filter((term) => lower.includes(term));
}

module.exports = {
  markBoot,
  uptimeSeconds,
  formatUptime,
  formatCheckedAt,
  record,
  lastOutcome,
  isStale,
  stateOf,
  snapshot,
  overall,
  renderAdmin,
  renderCustomer,
  leaksInternals,
  NEVER_SHOW,
};