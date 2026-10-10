/*
|--------------------------------------------------------------------------
| SUPABASE (POSTGRESQL) CONNECTION
|--------------------------------------------------------------------------
| The only place a database handle is created. Nothing else requires `pg`,
| so credentials are read in exactly one file and there is one file to audit.
|
| Supabase is managed PostgreSQL. The bot talks to it through the
| PostgreSQL wire protocol rather than through a REST client, because every
| write that touches money has to be a real transaction: a wallet balance and
| its ledger entry move together or not at all. A REST client would make a
| row lock and an insert two separate HTTP calls.
|
| Configuration comes from the environment:
|
|   SUPABASE_DB_URL    postgresql://user:password@host:5432/postgres
|   DATABASE_URL       accepted as a fallback, because some hosts inject it
|   SUPABASE_DB_POOL_MAX   maximum clients in the pool (default 10)
|   SUPABASE_DB_SSL     "false" disables TLS; leave it on in production
|   DATABASE_DISABLED   "true" forces the JSON store back on, for local work
|
| When the URL is absent the project stays on its JSON files instead of
| failing to boot, so a missing credential can never take the shop offline.
*/

const { Pool } = require("pg");

const CONNECT_TIMEOUT_MS = 10000;
const LOAD_TIMEOUT_MS = 15000;

let pool = null;
let connecting = null;
let initError = null;
let forcedDisabled = false;

function isConfigured() {
  return Boolean(
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  );
}

function shouldUseDisabledFlag() {
  return process.env.DATABASE_DISABLED === "true";
}

/**
 * Whether the bot should use PostgreSQL rather than the JSON files.
 */
function shouldUseDatabase() {
  if (shouldUseDisabledFlag()) {
    return false;
  }

  return isConfigured();
}

function connectionString() {
  const raw = String(
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || ""
  ).trim();

  return raw || null;
}

function sslSetting() {
  if (String(process.env.SUPABASE_DB_SSL || "").toLowerCase() === "false") {
    return false;
  }

  // Supabase serves a publicly trusted certificate, so verification stays on.
  // SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=false exists only for a corporate
  // proxy that re-signs TLS, which must never be the default.
  if (
    String(process.env.SUPABASE_DB_SSL_REJECT_UNAUTHORIZED || "").toLowerCase() ===
    "false"
  ) {
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

function poolMax() {
  const requested = Number(process.env.SUPABASE_DB_POOL_MAX);

  return Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), 20)
    : 10;
}

/**
 * The pool, created on first use. Returns null when PostgreSQL is not
 * configured so callers can fall back to the JSON store instead of throwing
 * during startup.
 */
async function getDb() {
  if (forcedDisabled) {
    return null;
  }

  if (pool) {
    return pool;
  }

  if (!shouldUseDatabase()) {
    return null;
  }

  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    try {
      const client = new Pool({
        connectionString: connectionString(),
        ssl: sslSetting(),
        max: poolMax(),
        min: 0,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        application_name: "hasa-gold-bot",
      });

      // A pool constructs lazily; prove the credentials and the reachability
      // of the host once here so a bad URL is a log line at boot rather than
      // a hang on the first order.
      const probe = await client.connect();
      try {
        await probe.query("SELECT 1");
      } finally {
        probe.release();
      }

      pool = client;
      transport = "postgresql";

      return client;
    } catch (error) {
      initError = error;
      forcedDisabled = true;

      console.error(
        "[DB] Supabase initialisation failed, falling back to JSON files:",
        error.message
      );

      return null;
    }
  })();

  const ready = await connecting;
  connecting = null;

  return ready;
}

let transport = null;

/**
 * Reject if a statement takes longer than ms, so an unreachable database is
 * a warning rather than a bot that sits silent.
 */
function withTimeout(promise, ms, label) {
  let timer;

  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });

  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * One round trip against the pool. Throws when the database is not
 * available, which the stores turn into ok:false.
 */
async function query(text, params = []) {
  const db = await getDb();

  if (!db) {
    throw new Error("Supabase is not available");
  }

  return db.query(text, params);
}

/**
 * Run fn inside one transaction. fn receives a client whose queries share
 * the transaction; a throw rolls back.
 */
async function withTransaction(fn) {
  const db = await getDb();

  if (!db) {
    throw new Error("Supabase is not available");
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const result = await fn(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The transaction is already dead; nothing useful to do.
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Serialise an order across every writer. A safe integer derived from the
 * order number, so two instances of the bot cannot claim the same top-up
 * even if they are on different machines.
 */
function orderLockKey(orderNumber) {
  const text = String(orderNumber || "");
  let hash = 0;

  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  }

  return hash;
}

/**
 * Verify the connection actually works, not merely that it was constructed.
 * Returns { ok, error }. Never throws.
 */
async function healthCheck() {
  try {
    const db = await getDb();

    if (!db) {
      return {
        ok: false,
        error: initError ? initError.message : "Supabase is not configured",
      };
    }

    await withTimeout(db.query("SELECT 1"), 8000, "Supabase health check");

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Safe status for startup logs. Contains no credential material.
 *
 * Three modes, and the difference matters at boot:
 *
 *   json           no connection string, so nowhere to store anything
 *   postgres       connected
 *   unavailable    a connection string was given and the connection failed,
 *                  which is a broken deployment rather than a local one
 */
function describeStatus() {
  const url = connectionString();
  let host = null;

  if (url) {
    try {
      host = new URL(url).host;
    } catch (error) {
      host = null;
    }
  }

  let mode = "json";

  if (shouldUseDatabase()) {
    mode = pool ? "postgres" : "unavailable";
  }

  return {
    mode,
    transport,
    host,
    disabled: shouldUseDisabledFlag(),
    error: initError ? initError.message : null,
  };
}

/**
 * True once the pool is usable. A failed connection is not a usable one.
 */
function isAvailable() {
  return describeStatus().mode === "postgres";
}

/**
 * Close the pool. Used on shutdown so the process can exit.
 */
async function closeDb() {
  const client = pool;
  pool = null;
  transport = null;

  if (client) {
    try {
      await client.end();
    } catch (error) {
      // Nothing useful to do while shutting down.
    }
  }
}

/**
 * Put the module back on the JSON store. Used by the tests and by a
 * deployment that wants the files back without editing the environment.
 */
function __disable() {
  forcedDisabled = true;
  return closeDb();
}

module.exports = {
  getDb,
  query,
  withTransaction,
  withTimeout,
  orderLockKey,
  isConfigured,
  shouldUseDatabase,
  isAvailable,
  healthCheck,
  describeStatus,
  closeDb,
  CONNECT_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  __disable,
};
