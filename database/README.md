# Supabase PostgreSQL setup

The bot's database is PostgreSQL, hosted on Supabase. This directory holds
the schema; everything else lives in `../src/database/`.

Nothing is migrated from Firebase. The schema below is meant to be run on an
empty project, and the bot refuses to start until it has a database to talk
to, so a fresh project plus this file is a complete setup.

---

## 1. Create the project

1. Sign in at <https://supabase.com/dashboard> and create a project.
2. Wait for the project to finish provisioning.
3. Open **Project settings → Database**.
4. Copy the **connection string** (URI). It looks like

   ```
   postgresql://postgres.<project-ref>:<password>@<host>:5432/postgres
   ```

   Keep the password out of git, out of screenshots and out of Telegram
   messages.

5. The free plan is enough. This project pools at most 10 connections by
   default (`SUPABASE_DB_POOL_MAX`) and indexes every column the screens
   filter on.

## 2. Run the schema

Either from the SQL Editor (paste the file and run it) or from a shell:

```bash
export SUPABASE_DB_URL='postgresql://...'
npm run db:schema
```

`database/schema.sql` is idempotent: every object is `IF NOT EXISTS` or
`OR REPLACE`, and every seed row is `ON CONFLICT DO NOTHING`, so running it
twice is safe.

## 3. Point the bot at it

```bash
cp .env.example .env
# then set SUPABASE_DB_URL, BOT_TOKEN and ADMIN_ID in .env
npm start
```

The bot prints the backend it selected on boot:

```
[DB] Order store: postgres (0 order(s))
[CATALOG] Using PostgreSQL, 1 game(s), 3 package(s), 2 payment method(s)
[WALLETS] Using PostgreSQL, 0 wallet(s) loaded
```

## 4. Verify it

```bash
npm run db:check
```

`scripts/db-check.js` connects and checks the tables, the columns the bot
writes, and the money functions, including that `wallet_debit` refuses a
balance it cannot find. It only reads.

## 5. Fill in the catalogue

The schema seeds one game, three packages and two payment methods as a
starting point, with placeholder prices and no provider product mapping.
Replace them before going live.

There are two ways:

- **From the admin panel.** The bot's games and payment screens write
  straight to these tables.
- **From an existing catalogue file.**

  ```bash
  npm run db:seed-catalog            # show what would be written
  node scripts/seed-catalog.js --apply
  ```

  This is the one place old JSON data is read on purpose. It is not run at
  startup, and nothing else in the bot reads `catalog.json` once Supabase is
  configured.

A package is only fulfilled automatically once its `sub_category_id` is the
provider's real product id. Until then an order is parked for manual review
rather than sent to the provider.

---

## Tables

```
users ──┬── orders ──┬── payments
        │             ├── topup_logs
        │             └── wallet_transactions
        ├── payments
        ├── recharge_requests
        ├── wallet_transactions
        └── payment_verification_requests

games ──── products

payment_methods          shop configuration
settings                 shop configuration
provider_configurations  one row per top-up provider
admin_logs               admin actions
```

- `users.telegram_id` is the business key. Every foreign key in the schema
  points at it, so a Telegram id is stored once.
- `orders` carries the catalogue snapshot at purchase time (game name,
  product name, price, `sub_category_id`). Editing a product later cannot
  change what an existing order bought.
- `wallet_transactions` is the ledger. `users.balance` is a denormalised
  total that only `wallet_credit`, `wallet_debit` and `approve_recharge` may
  change, and each of those writes the ledger entry in the same transaction.

## Money functions

| Function | What it does |
| --- | --- |
| `ensure_user(telegram_id)` | Creates the customer row if absent, returns the id |
| `wallet_credit(telegram_id, amount, ...)` | Credits the balance and writes the ledger row, atomically |
| `wallet_debit(telegram_id, amount, ...)` | Debits, refusing to overdraw, and writes the ledger row |
| `approve_recharge(request_id, admin_id)` | Approves a pending request and credits the wallet in one transaction |
| `reject_recharge(request_id, admin_id, reason)` | Rejects a pending request |

All of them:

- take a `FOR UPDATE` row lock on the customer, so two simultaneous spends
  cannot both succeed;
- are idempotent on `idempotency_key`, so a retried call moves nothing;
- return a row rather than raising, so the caller can report the reason.

## Security

- Row Level Security is enabled on every table. The only policy grants the
  `service_role`, which is what the bot uses. There is no `anon` policy, so
  the public key reads and writes nothing.
- The bot connects with the PostgreSQL connection string, not with the
  Supabase REST API, so no service-role key is used at all.
- Amounts are `NUMERIC(12,2)`, so a balance cannot drift the way a float
  does.

## Free-plan notes

- 10 pooled connections, tunable with `SUPABASE_DB_POOL_MAX`. Running several
  bot instances against one project means sharing that budget.
- The order book, the wallet mirror and the recent ledger are loaded once at
  startup and not re-queried per screen.
- Free plan projects are paused after a week of inactivity; a paused project
  answers no queries until it is restored, and the bot reports the connection
  error rather than trading.
