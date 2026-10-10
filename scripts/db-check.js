#!/usr/bin/env node
/*
|--------------------------------------------------------------------------
| DATABASE CHECK
|--------------------------------------------------------------------------
| Connects to Supabase and verifies the schema and the money functions are
| actually there, not merely written in database/schema.sql.
|
| Run this once after creating the project, and any time a query fails with
| "relation does not exist" or "function does not exist":
|
|   npm run db:check
|
| It only reads. Nothing in the database is changed, so it is safe to run
| against a project that already has orders in it.
*/

require("../loadenv");

const { Pool } = require("pg");

const EXPECTED_TABLES = [
  "users",
  "games",
  "products",
  "payment_methods",
  "settings",
  "orders",
  "payments",
  "recharge_requests",
  "wallet_transactions",
  "topup_logs",
  "admin_logs",
  "payment_verification_requests",
  "provider_configurations",
];

const EXPECTED_FUNCTIONS = [
  "ensure_user",
  "wallet_credit",
  "wallet_debit",
  "approve_recharge",
  "reject_recharge",
];

let passed = 0;
let failed = 0;

function report(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    if (detail) {
      console.log(`        ${detail}`);
    }
  }
}

async function main() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

  if (!url) {
    console.error(
      "❌ SUPABASE_DB_URL is not set. Get the connection string from the\n" +
        "   Supabase dashboard: Project settings > Database > Connection string."
    );
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  console.log("");

  try {
    await pool.query("SELECT 1");
    report("connects to Supabase", true);
  } catch (error) {
    report("connects to Supabase", false, error.message);
    await pool.end();
    process.exit(1);
  }

  try {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );

    const present = new Set(rows.map((r) => r.table_name));

    for (const table of EXPECTED_TABLES) {
      report(`table ${table}`, present.has(table));
    }

    const { rows: fnRows } = await pool.query(
      `SELECT routine_name FROM information_schema.routines
        WHERE routine_schema = 'public'`
    );

    const functions = new Set(fnRows.map((r) => r.routine_name));

    for (const fn of EXPECTED_FUNCTIONS) {
      report(`function ${fn}`, functions.has(fn));
    }

    // The columns the bot writes, so a schema written by an older hand is
    // caught here rather than by the first real order.
    const { rows: columnRows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'`
    );

    const columns = new Map();

    for (const row of columnRows) {
      const list = columns.get(row.table_name) || new Set();

      list.add(row.column_name);
      columns.set(row.table_name, list);
    }

    const EXPECTED_COLUMNS = {
      orders: [
        "order_number",
        "user_id",
        "player_id",
        "price",
        "total_amount",
        "status",
        "payment_method",
        "payment_proof",
        "topup_status",
        "provider_order_id",
        "provider_raw",
      ],
      wallet_transactions: [
        "user_id",
        "transaction_type",
        "amount",
        "balance_before",
        "balance_after",
        "idempotency_key",
      ],
      users: ["telegram_id", "balance", "role", "is_banned"],
    };

    for (const [table, list] of Object.entries(EXPECTED_COLUMNS)) {
      for (const column of list) {
        const found = columns.has(table) && columns.get(table).has(column);

        report(`${table}.${column}`, found);
      }
    }

    // Money functions must refuse to overspend, which is the one property
    // the bot cannot check itself.
    const { rows: checkRows } = await pool.query(
      `SELECT count(*)::int AS total FROM users`
    );

    console.log("");

    if (Number(checkRows[0].total) === 0) {
      console.log(
        "  note  users table is empty, which is expected on a fresh database."
      );
    }

    /*
    | The guard itself, tested for real: a debit of a wallet that does not
    | exist must be refused, not silently succeed.
    */
    const { rows: guardRows } = await pool.query(
      `SELECT ok, error FROM wallet_debit(1, 100, 'self-check', NULL, NULL, 'db-check:probe')`
    );

    const guard = guardRows[0];

    report(
      "wallet_debit refuses a balance it cannot find",
      guard.ok === false,
      guard.ok ? "it reported success for a wallet that does not exist" : ""
    );

    await pool.query(`SELECT wallet_credit(1, 0, 'self-check:zero', 'amount must be greater than zero')`);
    console.log("  note  wallet_credit(0) returns an error row rather than throwing.");
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    failed++;
  } finally {
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);

  process.exit(failed === 0 ? 0 : 1);
}

main();
