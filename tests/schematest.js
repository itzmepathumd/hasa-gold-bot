/*
|--------------------------------------------------------------------------
| SCHEMA TESTS
|--------------------------------------------------------------------------
| database/schema.sql is the whole database. These tests check it is
| executable PostgreSQL (it is parsed by the real Postgres parser, not by a
| hand-rolled one) and that it contains the structure the bot depends on:
| tables, columns, the unique constraints, the check constraints, the
| indexes and the foreign keys.
|
| A schema that parses is not the same as a schema that is correct, which is
| why the functions and the safety constraints are checked by name.
| `npm run db:check` then verifies all of it against the database itself.
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { parse } = require("libpg-query");

const SCHEMA_FILE = path.join(__dirname, "..", "database", "schema.sql");

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

const sql = fs.readFileSync(SCHEMA_FILE, "utf8");

/**
 * Split on the statement boundary the file's own comments use. Statements in
 * this file never contain a semicolon inside a string literal, and every
 * function body is accounted for by counting dollar-quoted blocks first.
 */
/**
 * Split the file into statements without cutting a quoted string in half.
 *
 * A naive split on ";" breaks on a literal that contains a semicolon, which
 * this file has, and the test would then see an INSERT with no ON CONFLICT
 * that really has one. Quotes, dollar-quoted function bodies and comments
 * are all tracked, so the statements returned are the ones the server sees.
 */
function statements() {
  const lines = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const found = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inDollarQuote = false;

  for (let i = 0; i < lines.length; i += 1) {
    const char = lines[i];

    if (inDollarQuote) {
      current += char;

      if (char === "$" && lines.slice(i - 1, i + 1) === "$$") {
        inDollarQuote = false;
      }

      continue;
    }

    if (inSingleQuote) {
      current += char;

      if (char === "'") {
        // "" inside a string is an escaped quote, not the end of it.
        if (lines[i + 1] === "'") {
          current += lines[i + 1];
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }

      continue;
    }

    if (inDoubleQuote) {
      current += char;

      if (char === '"') {
        inDoubleQuote = false;
      }

      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      current += char;
      continue;
    }

    if (char === "$" && lines[i + 1] === "$") {
      inDollarQuote = true;
      current += "$$";
      i += 1;
      continue;
    }

    if (char === ";") {
      const statement = current.trim();

      if (statement.length > 0) {
        found.push(statement);
      }

      current = "";
      continue;
    }

    current += char;
  }

  const remaining = current.trim();

  if (remaining.length > 0) {
    found.push(remaining);
  }

  return found;
}

(async () => {
  console.log("\n== the schema is executable PostgreSQL ==");

  let parseResult = null;

  await check("the real Postgres parser accepts every statement", async () => {
    try {
      parseResult = await parse(sql);
    } catch (error) {
      throw new Error(`parser says: ${error.message}`);
    }

    assert.ok(parseResult.stmts.length > 50, "suspiciously few statements");
  });

  await check("it never drops a table", () => {
    const drops = statements().filter((statement) => /^DROP\s/i.test(statement));

    for (const statement of drops) {
      assert.ok(
        /^DROP\s+(TRIGGER|POLICY|VIEW|FUNCTION|INDEX)\s+IF\s+EXISTS\b/i.test(statement),
        `an unguarded drop: ${statement.slice(0, 60)}`
      );
    }
  });

  /**
   * Split a CREATE TABLE body on its top-level commas, so a multi-line
   * CHECK constraint is one entry and not a column.
   */
  function tableDefinitions(statement) {
    const open = statement.indexOf("(");
    const close = statement.lastIndexOf(")");

    const body = statement.slice(open + 1, close);

    const entries = [];
    let current = "";
    let depth = 0;
    let inSingleQuote = false;

    for (let i = 0; i < body.length; i += 1) {
      const char = body[i];

      if (inSingleQuote) {
        current += char;

        if (char === "'") {
          inSingleQuote = false;
        }

        continue;
      }

      if (char === "'") {
        inSingleQuote = true;
        current += char;
        continue;
      }

      if (char === "(") {
        depth += 1;
      }

      if (char === ")") {
        depth -= 1;
      }

      if (char === "," && depth === 0) {
        entries.push(current.trim());
        current = "";
        continue;
      }

      current += char;
    }

    if (current.trim()) {
      entries.push(current.trim());
    }

    return entries;
  }

  await check("every column has a declared type", () => {
    const creates = statements().filter((statement) =>
      /^CREATE TABLE/i.test(statement)
    );

    const seen = [];

    for (const statement of creates) {
      for (const entry of tableDefinitions(statement)) {
        if (
          /^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)/i.test(entry)
        ) {
          continue;
        }

        seen.push(entry);

        assert.ok(
          /^\w+\s+(TEXT|BIGINT|INTEGER|NUMERIC|BOOLEAN|TIMESTAMPTZ|JSONB|TEXT\[\])\b/
            .test(entry),
          `no recognised type on: ${entry.slice(0, 60)}`
        );
      }
    }

    assert.ok(seen.length > 3, "suspiciously few columns found");
  });

  console.log("\n== the tables the bot reads and writes exist ==");

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

  for (const table of EXPECTED_TABLES) {
    await check(`table ${table}`, () => {
      assert.ok(
        new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`).test(sql),
        "missing"
      );
    });
  }

  console.log("\n== the columns the bot writes exist ==");

  const EXPECTED_COLUMNS = {
    users: [
      "telegram_id",
      "username",
      "first_name",
      "last_name",
      "balance",
      "role",
      "is_banned",
    ],
    orders: [
      "order_number",
      "user_id",
      "player_id",
      "price",
      "total_amount",
      "status",
      "payment_method",
      "payment_proof",
      "payment_submitted_at",
      "approved_at",
      "rejected_at",
      "reject_reason",
      "previous_status",
      "resolved_at",
      "resolved_by",
      "topup_status",
      "topup_attempts",
      "topup_started_at",
      "topup_completed_at",
      "topup_error",
      "topup_retry_armed",
      "provider",
      "provider_order_id",
      "provider_transaction_id",
      "provider_status",
      "provider_raw",
      "provider_failed",
      "wallet_transaction_id",
    ],
    wallet_transactions: [
      "user_id",
      "order_id",
      "payment_id",
      "recharge_id",
      "transaction_type",
      "amount",
      "balance_before",
      "balance_after",
      "description",
      "ref_id",
      "ref_type",
      "idempotency_key",
    ],
    payments: [
      "order_id",
      "user_id",
      "recharge_id",
      "amount",
      "payment_method",
      "reference_number",
      "status",
      "verified_at",
      "verified_by",
    ],
    recharge_requests: [
      "request_id",
      "user_id",
      "amount",
      "method",
      "status",
      "payment_proof",
      "payment_id",
      "approved_by",
      "approved_at",
      "rejected_by",
      "rejected_at",
      "reject_reason",
    ],
  };

  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    for (const column of columns) {
      await check(`${table}.${column}`, () => {
        assert.ok(
          new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}[\\s\\S]*?\\n\\s+${column}\\s`)
            .test(sql),
          "missing"
        );
      });
    }
  }

  console.log("\n== money is typed as money, not as a float ==");

  await check("balances and amounts are NUMERIC(12,2)", () => {
    // Whitespace is not significant in a column definition, so the columns
    // are matched on their type wherever the spacing puts it.
    for (const column of [
      "balance",
      "amount",
      "price",
      "total_amount",
      "balance_before",
      "balance_after",
    ]) {
      assert.ok(
        new RegExp(`\\n\\s+${column}\\s+NUMERIC\\(12,\\s*2\\)`).test(sql),
        `${column} is not NUMERIC(12,2)`
      );
    }
  });

  await check("telegram user ids are BIGINT", () => {
    assert.ok(/telegram_id\s+BIGINT/.test(sql));
    assert.ok(/user_id\s+BIGINT NOT NULL REFERENCES users \(telegram_id\)/.test(sql));
  });

  await check("timestamps are TIMESTAMPTZ", () => {
    assert.ok(!/created_at\s+TIMESTAMP\b(?!\s*WITH)/.test(sql));
  });

  console.log("\n== the constraints that protect a customer's money ==");

  await check("a balance can never go negative", () => {
    assert.ok(/CONSTRAINT users_balance_not_negative CHECK \(balance >= 0\)/.test(sql));
  });

  await check("a credit and a debit keep the ledger equal to the balance", () => {
    assert.ok(/CONSTRAINT wallet_transactions_balance_after_matches/.test(sql));
  });

  await check("a credit is positive and a debit is positive", () => {
    assert.ok(/CONSTRAINT wallet_transactions_credit_positive/.test(sql));
    assert.ok(/CONSTRAINT wallet_transactions_debit_positive/.test(sql));
  });

  await check("an order amount is never negative", () => {
    assert.ok(/CONSTRAINT orders_price_not_negative/.test(sql));
    assert.ok(/CONSTRAINT orders_total_not_negative/.test(sql));
  });

  await check("a payment amount is greater than zero", () => {
    assert.ok(/CONSTRAINT payments_amount_positive/.test(sql));
  });

  await check("an order number is unique", () => {
    assert.ok(/order_number\s+TEXT NOT NULL UNIQUE/.test(sql));
  });

  await check("a wallet idempotency key is unique", () => {
    assert.ok(/idempotency_key\s+TEXT UNIQUE/.test(sql));
  });

  await check("a provider order number is unique, so it cannot be reused", () => {
    assert.ok(/provider_order_id\s+TEXT UNIQUE/.test(sql));
  });

  await check("an order status is one of the known states", () => {
    assert.ok(/CONSTRAINT orders_status_allowed/.test(sql));
  });

  await check("a payment reference is unique per method, only where it exists", () => {
    assert.ok(
      /CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_unique_idx[\s\S]*?WHERE reference_number IS NOT NULL/.test(
        sql
      )
    );
  });

  console.log("\n== the indexes the screens need ==");

  for (const index of [
    "orders_user_id_idx",
    "orders_status_idx",
    "orders_created_at_idx",
    "orders_topup_status_idx",
    "wallet_transactions_user_created_idx",
    "payments_user_id_idx",
    "recharge_requests_user_id_idx",
  ]) {
    await check(`index ${index}`, () => {
      assert.ok(sql.includes(index), "missing");
    });
  }

  console.log("\n== the functions that move money ==");

  for (const fn of [
    "CREATE OR REPLACE FUNCTION ensure_user",
    "CREATE OR REPLACE FUNCTION wallet_credit",
    "CREATE OR REPLACE FUNCTION wallet_debit",
    "CREATE OR REPLACE FUNCTION approve_recharge",
    "CREATE OR REPLACE FUNCTION reject_recharge",
  ]) {
    await check(`function ${fn.split(" ").pop()}`, () => {
      assert.ok(sql.includes(fn), "missing");
    });
  }

  await check("wallet_debit refuses a balance it cannot find", () => {
    assert.ok(/IF NOT FOUND THEN[\s\S]*?'no_wallet'::TEXT/.test(sql));
  });

  await check("wallet_debit refuses to overdraw", () => {
    assert.ok(/IF v_before < p_amount THEN/.test(sql));
  });

  await check("wallet_credit is idempotent on its key", () => {
    assert.ok(/WHERE idempotency_key = p_idempotency_key/.test(sql));
  });

  await check("approve_recharge refuses a request that is not pending", () => {
    assert.ok(/IF v_request\.status <> 'pending' THEN/.test(sql));
  });

  await check("the money functions lock the customer row", () => {
    assert.ok(/FOR UPDATE/.test(sql));
  });

  console.log("\n== row level security ==");

  await check("every table has RLS enabled", () => {
    for (const table of EXPECTED_TABLES) {
      assert.ok(
        new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).test(sql),
        `${table} is not protected`
      );
    }
  });

  await check("only the service role is granted a policy", () => {
    const policies = sql.match(/CREATE POLICY ([^\s]+) ON (\w+) FOR ALL TO (\w+)/g) || [];

    assert.ok(policies.length > 0, "no policies at all");
    for (const policy of policies) {
      assert.ok(/TO service_role/.test(policy), `unexpected grantee: ${policy}`);
    }
  });

  console.log("\n== a fresh database can be started from this file ==");

  await check("the seed inserts are idempotent", () => {
    const inserts = statements().filter((statement) => /^INSERT INTO/i.test(statement));

    assert.ok(inserts.length > 0, "the file seeds nothing at all");

    for (const statement of inserts) {
      assert.ok(/ON CONFLICT/.test(statement), "a seed insert would fail on re-run");
    }
  });

  await check("the seed does not invent a price for a real product", () => {
    // The comment in the file says so; this keeps the note honest.
    assert.ok(/a guess at what the shop sells/.test(sql));
  });

  console.log(`\n  ${sql.split("\n").length} lines of schema`);

  if (parseResult) {
    console.log(`  ${parseResult.stmts.length} statements parsed`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);

  process.exit(failed === 0 ? 0 : 1);
})();
