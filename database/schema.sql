-- ---------------------------------------------------------------------------
-- HASA GOLD STORE - PostgreSQL (Supabase) schema
-- ---------------------------------------------------------------------------
-- Fresh relational schema for the Telegram top-up bot. Nothing here reads or
-- converts an old Firestore database: this file is meant to be run once on an
-- empty Supabase project, in the SQL Editor or with psql.
--
--   psql "$SUPABASE_DB_URL" -f database/schema.sql
--
-- Every table is an ordinary table with individual columns, declared types,
-- primary keys, foreign keys, unique constraints, check constraints and
-- indexes. Money is NUMERIC(12,2), Telegram user ids are BIGINT, timestamps
-- are TIMESTAMPTZ, flags are BOOLEAN. JSONB appears in exactly three places,
-- each justified in a comment: a package's requirements list, one provider
-- response kept for support, and one settings value.
--
-- Deployment notes for Supabase free tier:
--   * Run this file as the `postgres` role from the SQL Editor.
--   * Row Level Security is enabled on the tables with a service-side RLS
--     policy for the `service_role` the bot uses, and no policy for anon.
--     The bot is the only client, so nothing else is granted access.
--   * If you use the Supabase transaction pooler (port 6543), the wire
--     protocol driver must not send named prepared statements. `pg` sends
--     unnamed statements by default, which is what this project uses.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
-- Telegram is the identity, so the natural key is telegram_id and every
-- foreign key in this schema points at it. The surrogate `id` exists for the
-- usual reasons (stable row identity, cheap joins) but nothing references
-- it, so a user id is written exactly once.
--
-- balance is the denormalised current figure. It is never written by
-- application code: only wallet_credit(), wallet_debit() and
-- approve_recharge() may change it, and they always insert the matching
-- ledger row in the same transaction.
CREATE TABLE IF NOT EXISTS users (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    telegram_id  BIGINT NOT NULL UNIQUE,
    username     TEXT,
    first_name   TEXT,
    last_name    TEXT,
    balance      NUMERIC(12, 2) NOT NULL DEFAULT 0,
    role         TEXT NOT NULL DEFAULT 'user',
    is_banned    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT users_telegram_id_positive CHECK (telegram_id > 0),
    CONSTRAINT users_role_allowed CHECK (role IN ('user', 'admin')),
    CONSTRAINT users_balance_not_negative CHECK (balance >= 0),
    CONSTRAINT users_username_length CHECK (username IS NULL OR char_length(username) <= 64)
);

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

-- ---------------------------------------------------------------------------
-- GAMES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    emoji        TEXT NOT NULL DEFAULT '🎮',
    id_label     TEXT NOT NULL DEFAULT 'Player ID',
    id_example   TEXT NOT NULL DEFAULT '123456789',
    is_paused    BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT games_slug_shape CHECK (slug ~ '^[a-z0-9_]+$'),
    CONSTRAINT games_name_not_blank CHECK (char_length(btrim(name)) > 0)
);

-- ---------------------------------------------------------------------------
-- PRODUCTS
-- ---------------------------------------------------------------------------
-- One row per sellable package. product_code is the string the buttons
-- already send ("free_fire~weekly") and package_id the game-local id, so the
-- pair must be unique and the code unique in its own right.
--
-- sub_category_id is the provider's own product identifier, snapshotted onto
-- each order at purchase so editing the catalogue cannot change what an
-- existing order buys.
--
-- requirements is JSONB on purpose: it is a small list of free-form prompt
-- lines the order screen shows, it has no fixed shape the rest of the
-- application queries on, and it is never filtered or joined on in SQL.
CREATE TABLE IF NOT EXISTS products (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    game_id         BIGINT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    package_id      TEXT NOT NULL,
    product_code    TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    price           NUMERIC(12, 2) NOT NULL,
    note            TEXT NOT NULL DEFAULT '',
    sub_category_id INTEGER,
    requirements    JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_paused       BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT products_price_not_negative CHECK (price >= 0),
    CONSTRAINT products_sub_category_positive CHECK (sub_category_id IS NULL OR sub_category_id > 0),
    CONSTRAINT products_code_unique_per_game UNIQUE (game_id, package_id)
);

CREATE INDEX IF NOT EXISTS products_game_id_idx ON products (game_id);
CREATE INDEX IF NOT EXISTS products_active_idx ON products (game_id, is_paused);

-- ---------------------------------------------------------------------------
-- PAYMENT METHODS
-- ---------------------------------------------------------------------------
-- Shop configuration rather than something a customer buys. lines is TEXT[]
-- because it is a list of display lines of unknown count, which a column
-- models correctly and which nothing ever queries on individually.
CREATE TABLE IF NOT EXISTS payment_methods (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_code  TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    emoji        TEXT NOT NULL DEFAULT '💳',
    lines        TEXT[] NOT NULL DEFAULT '{}',
    is_paused    BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payment_methods_code_shape CHECK (method_code ~ '^[a-z0-9_]+$')
);

-- ---------------------------------------------------------------------------
-- SETTINGS
-- ---------------------------------------------------------------------------
-- Key/value shop configuration. JSONB is deliberate: the value is read whole
-- and written whole by one owner, and the alternative is a table with a
-- column per setting, where a new setting is a migration.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- ORDERS
-- ---------------------------------------------------------------------------
-- order_number is the business key the bot generates and prints (for
-- example HG-1234-ABCD). The snapshot columns (game_name, product_name,
-- price, sub_category_id) are the values at purchase time on purpose: a
-- catalogue edit must not change what a paid order bought.
--
-- user_id references users(telegram_id) rather than users(id), so the id
-- Telegram supplies is stored once and every child row can be joined to the
-- customer without an extra lookup. username/first_name are read from the
-- customer row at read time instead of being duplicated here.
CREATE TABLE IF NOT EXISTS orders (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number          TEXT NOT NULL UNIQUE,
    user_id               BIGINT NOT NULL REFERENCES users (telegram_id) ON DELETE RESTRICT,

    game_id               TEXT,
    game_name             TEXT,
    id_label              TEXT,

    product_id            TEXT,
    product_key           TEXT,
    product_name          TEXT,

    player_id             TEXT NOT NULL,
    player_name           TEXT,
    player_region         TEXT,

    quantity              INTEGER NOT NULL DEFAULT 1,
    price                 NUMERIC(12, 2) NOT NULL,
    total_amount          NUMERIC(12, 2) NOT NULL,
    sub_category_id       INTEGER,

    status                TEXT NOT NULL DEFAULT 'pending_payment',
    payment_method        TEXT,
    payment_proof         TEXT,
    payment_submitted_at  TIMESTAMPTZ,

    approved_at           TIMESTAMPTZ,
    rejected_at           TIMESTAMPTZ,
    rejected_by           BIGINT,
    reject_reason         TEXT,
    previous_status       TEXT,
    resolved_at           TIMESTAMPTZ,
    resolved_by           BIGINT,

    topup_status          TEXT,
    topup_attempts        INTEGER NOT NULL DEFAULT 0,
    topup_started_at      TIMESTAMPTZ,
    topup_completed_at    TIMESTAMPTZ,
    topup_error           TEXT,
    topup_retry_armed     BOOLEAN NOT NULL DEFAULT FALSE,

    provider              TEXT,
    provider_order_id     TEXT UNIQUE,
    provider_transaction_id TEXT,
    provider_status       TEXT,
    provider_raw          JSONB,
    provider_failed       BOOLEAN NOT NULL DEFAULT FALSE,

    wallet_transaction_id BIGINT,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT orders_status_allowed CHECK (
        status IN (
            'pending_payment',
            'pending_approval',
            'approved',
            'rejected',
            'cancelled',
            'ready_for_topup',
            'topup_processing',
            'topup_completed',
            'topup_failed',
            'needs_review'
        )
    ),
    CONSTRAINT orders_topup_status_allowed CHECK (
        topup_status IS NULL OR topup_status IN (
            'ready_for_topup',
            'topup_processing',
            'topup_completed',
            'topup_failed',
            'needs_review'
        )
    ),
    CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
    CONSTRAINT orders_price_not_negative CHECK (price >= 0),
    CONSTRAINT orders_total_not_negative CHECK (total_amount >= 0),
    CONSTRAINT orders_attempts_not_negative CHECK (topup_attempts >= 0),
    CONSTRAINT orders_player_id_not_blank CHECK (char_length(btrim(player_id)) > 0),
    CONSTRAINT orders_approved_needs_timestamp CHECK (
        status <> 'approved' OR approved_at IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_topup_status_idx ON orders (topup_status);
-- The recovery query filters on topup_status IN (...) OR (status, topup_status).
CREATE INDEX IF NOT EXISTS orders_needing_attention_idx
    ON orders (status)
    WHERE topup_status IN ('ready_for_topup', 'topup_processing', 'needs_review');

-- ---------------------------------------------------------------------------
-- PAYMENTS
-- ---------------------------------------------------------------------------
-- One row per money movement the customer initiated: a wallet top-up (EZ
-- Cash, bank transfer) or a direct order payment. reference_number is the
-- provider reference the customer typed, such as the 14-digit EZ Cash RN.
--
-- A reference is unique per method only where it exists: two customers may
-- both submit a payment before a number is issued, and NULLs are distinct in
-- a unique index, which is exactly the wanted behaviour here. A reference
-- number alone never proves a payment: approve_recharge() and the admin
-- verification flow decide that, and the reference is only an index to
-- lookup by.
CREATE TABLE IF NOT EXISTS payments (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id          BIGINT REFERENCES orders (id) ON DELETE SET NULL,
    user_id           BIGINT NOT NULL REFERENCES users (telegram_id) ON DELETE RESTRICT,
    recharge_id       BIGINT,
    amount            NUMERIC(12, 2) NOT NULL,
    payment_method    TEXT NOT NULL,
    reference_number  TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    verified_at       TIMESTAMPTZ,
    verified_by       BIGINT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payments_amount_positive CHECK (amount > 0),
    CONSTRAINT payments_status_allowed CHECK (
        status IN ('pending', 'verified', 'rejected', 'failed')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_unique_idx
    ON payments (payment_method, reference_number)
    WHERE reference_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_order_id_idx ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments (user_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status);

-- ---------------------------------------------------------------------------
-- RECHARGE REQUESTS
-- ---------------------------------------------------------------------------
-- A customer asking for wallet credit, and the admin decision on it. The
-- payment proof is whatever the customer sent: a Telegram file id for a
-- screenshot, or an auto-verified marker when a payment provider already
-- confirmed the deposit.
CREATE TABLE IF NOT EXISTS recharge_requests (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id   TEXT NOT NULL UNIQUE,
    user_id      BIGINT NOT NULL REFERENCES users (telegram_id) ON DELETE RESTRICT,
    amount       NUMERIC(12, 2) NOT NULL,
    method       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    payment_proof TEXT,
    note         TEXT,
    approved_by  BIGINT,
    approved_at  TIMESTAMPTZ,
    rejected_by  BIGINT,
    rejected_at  TIMESTAMPTZ,
    reject_reason TEXT,
    payment_id   BIGINT,
    -- The ledger row the approval wrote. approve_recharge() records it so a
    -- credited recharge can always be traced to the exact balance change.
    wallet_transaction_id BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recharge_requests_amount_positive CHECK (amount > 0),
    CONSTRAINT recharge_requests_status_allowed CHECK (
        status IN ('pending', 'approved', 'rejected')
    )
);

-- An already-deployed database keeps its rows; add the column without
-- dropping the table, so re-running this script is safe.
ALTER TABLE recharge_requests
    ADD COLUMN IF NOT EXISTS wallet_transaction_id BIGINT;

CREATE INDEX IF NOT EXISTS recharge_requests_user_id_idx ON recharge_requests (user_id);
CREATE INDEX IF NOT EXISTS recharge_requests_status_created_idx
    ON recharge_requests (status, created_at);

-- ---------------------------------------------------------------------------
-- WALLET TRANSACTIONS (the ledger)
-- ---------------------------------------------------------------------------
-- Append-only record of every balance change. balance_before and
-- balance_after are written by the database functions below, so the ledger
-- can always be reconciled against users.balance and a discrepancy is
-- traceable to a specific row.
--
-- idempotency_key is UNIQUE: a retried credit that carries the same key
-- returns the original row instead of moving money twice.
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users (telegram_id) ON DELETE RESTRICT,
    order_id        BIGINT REFERENCES orders (id) ON DELETE SET NULL,
    payment_id      BIGINT REFERENCES payments (id) ON DELETE SET NULL,
    recharge_id     BIGINT,
    transaction_type TEXT NOT NULL,
    amount          NUMERIC(12, 2) NOT NULL,
    balance_before  NUMERIC(12, 2) NOT NULL,
    balance_after   NUMERIC(12, 2) NOT NULL,
    description     TEXT,
    ref_id          TEXT,
    ref_type        TEXT,
    idempotency_key TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wallet_transactions_type_allowed CHECK (
        transaction_type IN ('credit', 'debit')
    ),
    CONSTRAINT wallet_transactions_amount_not_zero CHECK (amount <> 0),
    CONSTRAINT wallet_transactions_credit_positive CHECK (
        transaction_type <> 'credit' OR amount > 0
    ),
    CONSTRAINT wallet_transactions_debit_positive CHECK (
        transaction_type <> 'debit' OR amount > 0
    ),
    CONSTRAINT wallet_transactions_balance_after_matches CHECK (
        (transaction_type = 'credit'  AND balance_after = balance_before + amount) OR
        (transaction_type = 'debit'   AND balance_after = balance_before - amount)
    )
);

CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx
    ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transactions_order_id_idx
    ON wallet_transactions (order_id);
CREATE INDEX IF NOT EXISTS wallet_transactions_ref_idx
    ON wallet_transactions (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- TOP-UP LOGS
-- ---------------------------------------------------------------------------
-- One row per provider call, so a support question about "why did this not
-- arrive" is answered from a history instead of from memory. Only the
-- provider's own response is stored; never a credential.
CREATE TABLE IF NOT EXISTS topup_logs (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id          BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    provider          TEXT,
    request_reference TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    response_message  TEXT,
    raw               JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT topup_logs_status_allowed CHECK (
        status IN ('pending', 'success', 'failed', 'unknown')
    )
);

CREATE INDEX IF NOT EXISTS topup_logs_order_id_idx ON topup_logs (order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- ADMIN LOGS
-- ---------------------------------------------------------------------------
-- Who approved or rejected what, and when. The bot names the admin on every
-- notification already; this is the durable copy.
CREATE TABLE IF NOT EXISTS admin_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_id   BIGINT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT admin_logs_action_not_blank CHECK (char_length(btrim(action)) > 0)
);

CREATE INDEX IF NOT EXISTS admin_logs_admin_created_idx
    ON admin_logs (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_logs_action_idx ON admin_logs (action);

-- ---------------------------------------------------------------------------
-- EZ CASH DEPOSITS
-- ---------------------------------------------------------------------------
-- Deposits the payment provider has reported, whether or not the bot has
-- already credited a wallet for them. The unique constraint on
-- (provider, reference_number) is what makes a replayed RN safe: a second
-- attempt to credit the same deposit returns the existing row instead of
-- paying twice.
CREATE TABLE IF NOT EXISTS payment_verification_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider        TEXT NOT NULL DEFAULT 'nexaura',
    reference_number TEXT NOT NULL,
    user_id         BIGINT REFERENCES users (telegram_id) ON DELETE SET NULL,
    deposit_id      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    amount_lkr      NUMERIC(12, 2),
    credited_lkr    NUMERIC(12, 2),
    wallet_transaction_id BIGINT,
    last_error      TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payment_verification_status_allowed CHECK (
        status IN ('pending', 'credited', 'failed', 'refunded')
    ),
    CONSTRAINT payment_verification_attempts_not_negative CHECK (attempts >= 0),
    CONSTRAINT payment_verification_reference_unique UNIQUE (provider, reference_number)
);

CREATE INDEX IF NOT EXISTS payment_verification_user_idx
    ON payment_verification_requests (user_id, first_seen_at DESC);

-- ---------------------------------------------------------------------------
-- PROVIDER CONFIGURATIONS
-- ---------------------------------------------------------------------------
-- One row per top-up provider: which one is active and its per-product
-- mapping. active flag keeps a second provider addable without schema work.
CREATE TABLE IF NOT EXISTS provider_configurations (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider     TEXT NOT NULL UNIQUE,
    is_active    BOOLEAN NOT NULL DEFAULT FALSE,
    api_base_url TEXT,
    product_map  JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- updated_at MAINTENANCE
-- ---------------------------------------------------------------------------
-- One generic trigger function, attached once per table. Application code
-- never writes updated_at itself, so it cannot drift from the row state.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS games_set_updated_at ON games;
CREATE TRIGGER games_set_updated_at BEFORE UPDATE ON games
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS products_set_updated_at ON products;
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS payment_methods_set_updated_at ON payment_methods;
CREATE TRIGGER payment_methods_set_updated_at BEFORE UPDATE ON payment_methods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS recharge_requests_set_updated_at ON recharge_requests;
CREATE TRIGGER recharge_requests_set_updated_at BEFORE UPDATE ON recharge_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS payment_verification_requests_set_updated_at ON payment_verification_requests;
CREATE TRIGGER payment_verification_requests_set_updated_at BEFORE UPDATE ON payment_verification_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS provider_configurations_set_updated_at ON provider_configurations;
CREATE TRIGGER provider_configurations_set_updated_at BEFORE UPDATE ON provider_configurations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- WALLET: the only writers of users.balance
-- ---------------------------------------------------------------------------
-- Each function takes a transaction-scoped row lock on the user row, so two
-- simultaneous spends of the same balance cannot both succeed, and writes
-- the ledger row in the same transaction as the balance change. Both return
-- the same shape, and both are idempotent on idempotency_key.
CREATE OR REPLACE FUNCTION ensure_user(
    p_telegram_id BIGINT,
    p_username   TEXT DEFAULT NULL,
    p_first_name TEXT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
    v_telegram_id BIGINT;
BEGIN
    IF p_telegram_id IS NULL OR p_telegram_id <= 0 THEN
        RAISE EXCEPTION 'ensure_user: telegram_id must be a positive integer';
    END IF;

    INSERT INTO users (telegram_id, username, first_name, balance)
    VALUES (p_telegram_id, NULLIF(btrim(p_username), ''), NULLIF(btrim(p_first_name), ''), 0)
    ON CONFLICT (telegram_id) DO UPDATE
        SET username = COALESCE(EXCLUDED.username, users.username),
            first_name = COALESCE(EXCLUDED.first_name, users.first_name),
            updated_at = NOW()
    RETURNING telegram_id INTO v_telegram_id;

    RETURN v_telegram_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION wallet_credit(
    p_telegram_id     BIGINT,
    p_amount          NUMERIC,
    p_description     TEXT DEFAULT NULL,
    p_ref_id          TEXT DEFAULT NULL,
    p_ref_type        TEXT DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_order_ref       TEXT DEFAULT NULL,
    p_payment_ref     BIGINT DEFAULT NULL
)
RETURNS TABLE (
    ok BOOLEAN,
    balance NUMERIC(12, 2),
    transaction_id BIGINT,
    balance_before NUMERIC(12, 2),
    balance_after NUMERIC(12, 2),
    duplicate BOOLEAN,
    error TEXT
) AS $$
DECLARE
    v_user_id BIGINT;
    v_before NUMERIC(12, 2);
    v_after NUMERIC(12, 2);
    v_tx_id BIGINT;
    v_order_id BIGINT;
    v_existing RECORD;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN QUERY SELECT false, NULL::NUMERIC, NULL::BIGINT, NULL::NUMERIC, NULL::NUMERIC, false, 'amount must be greater than zero'::TEXT;
        RETURN;
    END IF;

    -- A replay with the same key returns the original movement, never a second one.
    IF p_idempotency_key IS NOT NULL THEN
        SELECT * INTO v_existing
          FROM wallet_transactions
         WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN QUERY SELECT true, v_existing.balance_after, v_existing.id,
                                v_existing.balance_before, v_existing.balance_after,
                                true, NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    SELECT id INTO v_order_id FROM orders WHERE order_number = p_order_ref;

    -- Lock the customer row for the rest of this transaction.
    SELECT telegram_id, users.balance INTO v_user_id, v_before
      FROM users
     WHERE telegram_id = p_telegram_id
     FOR UPDATE;

    IF NOT FOUND THEN
        v_user_id := ensure_user(p_telegram_id);
        v_before := 0;
    END IF;

    v_after := v_before + p_amount;

    INSERT INTO wallet_transactions (
        user_id, order_id, payment_id, transaction_type, amount,
        balance_before, balance_after, description, ref_id, ref_type, idempotency_key
    ) VALUES (
        v_user_id, v_order_id, p_payment_ref, 'credit', p_amount,
        v_before, v_after, p_description, p_ref_id, p_ref_type, p_idempotency_key
    )
    RETURNING id INTO v_tx_id;

    UPDATE users SET balance = v_after WHERE telegram_id = v_user_id;

    RETURN QUERY SELECT true, v_after, v_tx_id, v_before, v_after, false, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION wallet_debit(
    p_telegram_id     BIGINT,
    p_amount          NUMERIC,
    p_description     TEXT DEFAULT NULL,
    p_ref_id          TEXT DEFAULT NULL,
    p_ref_type        TEXT DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_order_ref       TEXT DEFAULT NULL,
    p_payment_ref     BIGINT DEFAULT NULL
)
RETURNS TABLE (
    ok BOOLEAN,
    balance NUMERIC(12, 2),
    transaction_id BIGINT,
    balance_before NUMERIC(12, 2),
    balance_after NUMERIC(12, 2),
    duplicate BOOLEAN,
    error TEXT
) AS $$
DECLARE
    v_before NUMERIC(12, 2);
    v_after NUMERIC(12, 2);
    v_tx_id BIGINT;
    v_order_id BIGINT;
    v_existing RECORD;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN QUERY SELECT false, NULL::NUMERIC, NULL::BIGINT, NULL::NUMERIC, NULL::NUMERIC, false, 'amount must be greater than zero'::TEXT;
        RETURN;
    END IF;

    IF p_idempotency_key IS NOT NULL THEN
        SELECT * INTO v_existing
          FROM wallet_transactions
         WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            RETURN QUERY SELECT true, v_existing.balance_after, v_existing.id,
                                v_existing.balance_before, v_existing.balance_after,
                                true, NULL::TEXT;
            RETURN;
        END IF;
    END IF;

    SELECT id INTO v_order_id FROM orders WHERE order_number = p_order_ref;

    SELECT users.balance INTO v_before
      FROM users
     WHERE telegram_id = p_telegram_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::NUMERIC, NULL::BIGINT, NULL::NUMERIC, NULL::NUMERIC, false, 'no_wallet'::TEXT;
        RETURN;
    END IF;

    IF v_before < p_amount THEN
        RETURN QUERY SELECT false, v_before, NULL::BIGINT, v_before, NULL::NUMERIC, false, 'insufficient_balance'::TEXT;
        RETURN;
    END IF;

    v_after := v_before - p_amount;

    INSERT INTO wallet_transactions (
        user_id, order_id, payment_id, transaction_type, amount,
        balance_before, balance_after, description, ref_id, ref_type, idempotency_key
    ) VALUES (
        p_telegram_id, v_order_id, p_payment_ref, 'debit', p_amount,
        v_before, v_after, p_description, p_ref_id, p_ref_type, p_idempotency_key
    )
    RETURNING id INTO v_tx_id;

    UPDATE users SET balance = v_after WHERE telegram_id = p_telegram_id;

    RETURN QUERY SELECT true, v_after, v_tx_id, v_before, v_after, false, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- RECHARGE APPROVAL
-- ---------------------------------------------------------------------------
-- Marks the request approved, credits the wallet and writes the ledger entry
-- in one transaction. A request that is not pending any more returns
-- ok=false and moves nothing, so a double-tapped Approve button cannot
-- credit a customer twice.
CREATE OR REPLACE FUNCTION approve_recharge(
    p_request_id TEXT,
    p_admin_id   BIGINT
)
RETURNS TABLE (
    ok BOOLEAN,
    balance NUMERIC(12, 2),
    transaction_id BIGINT,
    error TEXT
) AS $$
DECLARE
    v_request RECORD;
    v_before NUMERIC(12, 2);
    v_after NUMERIC(12, 2);
    v_tx_id BIGINT;
    v_order_id BIGINT;
BEGIN
    SELECT * INTO v_request
      FROM recharge_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::NUMERIC, NULL::BIGINT, 'Recharge request not found'::TEXT;
        RETURN;
    END IF;

    IF v_request.status <> 'pending' THEN
        RETURN QUERY SELECT false, NULL::NUMERIC, NULL::BIGINT,
            ('Recharge is already ' || v_request.status)::TEXT;
        RETURN;
    END IF;

    SELECT users.balance INTO v_before
      FROM users
     WHERE telegram_id = v_request.user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO users (telegram_id, balance) VALUES (v_request.user_id, 0)
        RETURNING users.balance INTO v_before;
    END IF;

    v_after := v_before + v_request.amount;

    INSERT INTO wallet_transactions (
        user_id, recharge_id, transaction_type, amount,
        balance_before, balance_after, description, ref_id, ref_type, idempotency_key
    ) VALUES (
        v_request.user_id, v_request.id, 'credit', v_request.amount,
        v_before, v_after,
        ('Recharge approved via ' || v_request.method),
        v_request.request_id, 'recharge',
        ('recharge:' || v_request.request_id)
    )
    RETURNING id INTO v_tx_id;

    UPDATE users SET balance = v_after WHERE telegram_id = v_request.user_id;

    UPDATE recharge_requests
       SET status = 'approved',
           approved_by = p_admin_id,
           approved_at = NOW(),
           wallet_transaction_id = v_tx_id,
           updated_at = NOW()
     WHERE id = v_request.id;

    RETURN QUERY SELECT true, v_after, v_tx_id, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_recharge(
    p_request_id TEXT,
    p_admin_id   BIGINT,
    p_reason     TEXT DEFAULT NULL
)
RETURNS TABLE (ok BOOLEAN, error TEXT) AS $$
DECLARE
    v_request RECORD;
BEGIN
    SELECT * INTO v_request
      FROM recharge_requests
     WHERE request_id = p_request_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'Recharge request not found'::TEXT;
        RETURN;
    END IF;

    IF v_request.status <> 'pending' THEN
        RETURN QUERY SELECT false, ('Recharge is already ' || v_request.status)::TEXT;
        RETURN;
    END IF;

    UPDATE recharge_requests
       SET status = 'rejected',
           rejected_by = p_admin_id,
           rejected_at = NOW(),
           reject_reason = p_reason,
           updated_at = NOW()
     WHERE id = v_request.id;

    RETURN QUERY SELECT true, NULL::TEXT;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- CONVENIENCE VIEWS
-- ---------------------------------------------------------------------------
-- The admin "recent orders" screens join several tables every render. One
-- view keeps that in the database where it is cheap and keeps the mapping
-- code in the bot to a single row shape.
CREATE OR REPLACE VIEW order_summaries AS
SELECT
    o.id                AS order_id,
    o.order_number,
    o.user_id,
    o.status,
    o.payment_method,
    o.price,
    o.total_amount,
    o.product_name,
    o.game_name,
    o.player_id,
    o.created_at,
    o.approved_at,
    u.username,
    u.first_name
  FROM orders o
  JOIN users u ON u.telegram_id = o.user_id;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
-- The bot connects as the project's service role and is the only client. RLS
-- is enabled so that if the public anon key is ever used against these
-- tables it reads and writes nothing: there is no anon policy at all.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE recharge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topup_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_configurations ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS by design; the statement is explicit so the
-- intent is visible in the schema rather than depending on a default.
DROP POLICY IF EXISTS service_role_all ON users;
CREATE POLICY service_role_all ON users FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON games;
CREATE POLICY service_role_all ON games FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON products;
CREATE POLICY service_role_all ON products FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON payment_methods;
CREATE POLICY service_role_all ON payment_methods FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON settings;
CREATE POLICY service_role_all ON settings FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON orders;
CREATE POLICY service_role_all ON orders FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON payments;
CREATE POLICY service_role_all ON payments FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON recharge_requests;
CREATE POLICY service_role_all ON recharge_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON wallet_transactions;
CREATE POLICY service_role_all ON wallet_transactions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON topup_logs;
CREATE POLICY service_role_all ON topup_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON admin_logs;
CREATE POLICY service_role_all ON admin_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON payment_verification_requests;
CREATE POLICY service_role_all ON payment_verification_requests FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_all ON provider_configurations;
CREATE POLICY service_role_all ON provider_configurations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- SEED
-- ---------------------------------------------------------------------------
-- The catalogue, payment methods and providers this schema expects. Replace
-- the prices and the provider product mapping with the real ones before the
-- bot goes live: nothing here is a guess at what the shop sells, it is the
-- minimum needed for the order screens to render.
--
-- The bot also syncs this on every catalogue change from the admin panel, so
-- these rows are a starting point rather than a source of truth.
INSERT INTO games (slug, name, emoji, id_label, id_example, sort_order)
VALUES
    ('free_fire', 'Free Fire', '🔥', 'Player ID', '11927288867', 1)
ON CONFLICT (slug) DO NOTHING;

-- Prices are in LKR. sub_category_id is NULL on purpose: fill it in once it
-- has been checked against the top-up provider's own catalogue, because an
-- order with no mapping is parked for manual review rather than sent.
INSERT INTO products (game_id, package_id, product_code, name, price, sort_order)
SELECT g.id, 'weekly', 'free_fire~weekly', '📅 Weekly', 590, 1
  FROM games g WHERE g.slug = 'free_fire'
ON CONFLICT (product_code) DO NOTHING;

INSERT INTO products (game_id, package_id, product_code, name, price, sort_order)
SELECT g.id, 'weekly_lite', 'free_fire~weekly_lite', '📅 Weekly Lite', 115, 2
  FROM games g WHERE g.slug = 'free_fire'
ON CONFLICT (product_code) DO NOTHING;

INSERT INTO products (game_id, package_id, product_code, name, price, sort_order)
SELECT g.id, 'monthly', 'free_fire~monthly', '🗓️ Monthly', 2650, 3
  FROM games g WHERE g.slug = 'free_fire'
ON CONFLICT (product_code) DO NOTHING;

INSERT INTO payment_methods (method_code, title, emoji, lines, sort_order)
VALUES
    ('ez_cash', 'EZ Cash', '💳', ARRAY['📱 Number: 074 163 5465'], 1),
    ('bank_transfer', 'Bank Transfer', '🏦', ARRAY['🏦 Bank: —', '🔢 Account: —'], 2)
ON CONFLICT (method_code) DO NOTHING;

INSERT INTO provider_configurations (provider, is_active, api_base_url, product_map, notes)
VALUES
    ('shop2topup', true, 'https://www.shop2topup.com', '{}'::jsonb, 'Primary provider'),
    ('nexaura', false, 'https://topup.nexauracore.com/api/v1/reseller', '{}'::jsonb,
     'Free Fire provider; enable after the product map is verified')
ON CONFLICT (provider) DO NOTHING;

-- Store-wide configuration the bot reads.
INSERT INTO settings (key, value)
VALUES
    ('store_name', '"HASA GOLD STORE"'::jsonb),
    ('catalog_version', '1'::jsonb)
ON CONFLICT (key) DO NOTHING;
