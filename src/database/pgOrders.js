/*
|--------------------------------------------------------------------------
| POSTGRESQL ORDER STORE
|--------------------------------------------------------------------------
| Orders live in the `orders` table with order_number as the business key,
| so the order id the customer sees is the same string the rest of the bot
| has always used.
|
| Concurrency: createOrder, and every mutateOrder, run inside one
| transaction that first takes a transaction-scoped advisory lock on the
| order number. Two writers touching the same order therefore run in series
| even if they arrive on two instances of the bot, and the row itself is
| additionally locked with FOR UPDATE. Mutators passed to mutateOrder() are
| pure: they only set fields on the record they are given, which is what
| makes re-running one safe.
|
| Nothing is written with a partial row. The full column set from mappers.js
| is written back on every update, so the row and the object can never
| disagree about which fields exist.
*/

const { getDb, withTransaction, orderLockKey } = require("./connection");
const {
  orderFromRow,
  orderToParams,
  ORDER_COLUMNS,
} = require("./mappers");

const COLLECTION = "orders";

const SELECT_ORDER = `
    SELECT
        o.order_number,
        o.user_id,
        o.game_id,
        o.game_name,
        o.id_label,
        o.product_id,
        o.product_key,
        o.product_name,
        o.player_id,
        o.player_name,
        o.player_region,
        o.quantity,
        o.price,
        o.total_amount,
        o.sub_category_id,
        o.status,
        o.payment_method,
        o.payment_proof,
        o.payment_submitted_at,
        o.approved_at,
        o.rejected_at,
        o.rejected_by,
        o.reject_reason,
        o.previous_status,
        o.resolved_at,
        o.resolved_by,
        o.topup_status,
        o.topup_attempts,
        o.topup_started_at,
        o.topup_completed_at,
        o.topup_error,
        o.topup_retry_armed,
        o.provider,
        o.provider_order_id,
        o.provider_transaction_id,
        o.provider_status,
        o.provider_raw,
        o.provider_failed,
        o.wallet_transaction_id,
        o.created_at,
        o.updated_at,
        u.username   AS user_username,
        u.first_name AS user_first_name
      FROM orders o
      JOIN users u ON u.telegram_id = o.user_id
`;

/*
| The column list and placeholders are built from the same constant
| mappers.js exports, so adding a column means changing one file.
*/
const INSERT_COLUMNS = ORDER_COLUMNS.join(", ");

function insertPlaceholders(count) {
  return ORDER_COLUMNS.map((_, index) => `$${index + 1}`).join(", ");
}

const UPDATE_ASSIGNMENTS = ORDER_COLUMNS.map(
  (column, index) => `${column} = $${index + 1}`
).join(", ");

/**
 * Every stored order, oldest first. Used at startup to build the read
 * mirror, never to render a screen.
 */
async function fetchAllOrders() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const { rows } = await db.query(
    `${SELECT_ORDER} ORDER BY o.created_at ASC, o.id ASC`
  );

  return rows.map(orderFromRow);
}

async function fetchOrder(orderId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const { rows } = await db.query(
    `${SELECT_ORDER} WHERE o.order_number = $1`,
    [orderId]
  );

  return rows.length ? orderFromRow(rows[0]) : null;
}

/**
 * Orders belonging to one customer, oldest first.
 */
async function fetchUserOrders(userId) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const { rows } = await db.query(
    `${SELECT_ORDER} WHERE o.user_id = $1 ORDER BY o.created_at ASC, o.id ASC`,
    [Number(userId)]
  );

  return rows.map(orderFromRow);
}

/**
 * Orders sitting in one of the given states.
 */
async function fetchOrdersByStatus(statuses) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const list = Array.isArray(statuses) ? statuses : [statuses];

  const { rows } = await db.query(
    `${SELECT_ORDER} WHERE o.status = ANY($1::text[]) ORDER BY o.created_at ASC, o.id ASC`,
    [list]
  );

  return rows.map(orderFromRow);
}

/**
 * Count orders per state without loading the records.
 */
async function fetchStatusCounts() {
  const db = await getDb();

  if (!db) {
    return {};
  }

  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS total FROM orders GROUP BY status`
  );

  const counts = {};

  for (const row of rows) {
    counts[row.status || "unknown"] = Number(row.total) || 0;
  }

  return counts;
}

/**
 * Create an order.
 *
 * The customer row is created first, because orders.user_id references it.
 * ON CONFLICT DO NOTHING makes a retried submission fail with a duplicate
 * instead of inserting a second copy of the same order number, which would
 * double every total.
 */
async function createOrder(order) {
  try {
    const result = await withTransaction(async (client) => {
      await client.query(
        `SELECT ensure_user($1, $2, $3)`,
        [
          Number(order.userId),
          order.username || null,
          order.firstName || null,
        ]
      );

      const params = orderToParams(order);

      const inserted = await client.query(
        `INSERT INTO orders (${INSERT_COLUMNS})
         VALUES (${insertPlaceholders(ORDER_COLUMNS.length)})
         ON CONFLICT (order_number) DO NOTHING
         RETURNING order_number`,
        params
      );

      if (inserted.rowCount === 0) {
        return { ok: false, order: null, duplicate: true, error: `Order ${order.id} already exists` };
      }

      return { ok: true, order, duplicate: false, error: null };
    });

    return result;
  } catch (error) {
    const duplicate = /duplicate key value|already exists/i.test(error.message);

    return {
      ok: false,
      order: null,
      duplicate,
      error: duplicate ? `Order ${order.id} already exists` : error.message,
    };
  }
}

/**
 * Change one order by id.
 *
 * The mutator receives the stored order and returns the record to persist,
 * or false to decline without writing. Decisions are reported through the
 * `decision` object so the stored row is never replaced by a wrapper.
 */
async function updateOrder(orderId, mutator, decision = {}) {
  let result = null;

  try {
    await withTransaction(async (client) => {
      // Serialise every writer for this order across the whole deployment.
      await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
        orderLockKey(orderId),
      ]);

      const { rows } = await client.query(
        `${SELECT_ORDER} WHERE o.order_number = $1 FOR UPDATE OF o`,
        [orderId]
      );

      if (rows.length === 0) {
        decision.ok = true;
        decision.found = false;
        result = null;
        return;
      }

      const current = orderFromRow(rows[0]);
      const updated = mutator(current, decision);

      if (updated === false) {
        // The mutator declined, so nothing is written.
        decision.ok = true;
        decision.found = true;
        result = current;
        return;
      }

      await client.query(
        `UPDATE orders SET ${UPDATE_ASSIGNMENTS} WHERE order_number = $${ORDER_COLUMNS.length + 1}`,
        [...orderToParams(updated), orderId]
      );

      decision.ok = true;
      decision.found = true;
      result = updated;
    });

    return { ok: true, order: result, error: null };
  } catch (error) {
    decision.ok = false;

    return { ok: false, order: null, error: error.message };
  }
}

/**
 * Write one provider attempt to the log, without letting a logging failure
 * break the order it belongs to.
 */
async function logTopupAttempt(orderNumber, entry) {
  const db = await getDb();

  if (!db) {
    return;
  }

  try {
    await db.query(
      `INSERT INTO topup_logs (order_id, provider, request_reference, status, response_message, raw)
       SELECT o.id, $2, $3, $4, $5, $6::jsonb FROM orders o WHERE o.order_number = $1`,
      [
        orderNumber,
        entry.provider || null,
        entry.requestReference || null,
        entry.status || "pending",
        entry.message || null,
        entry.raw ? JSON.stringify(entry.raw) : null,
      ]
    );
  } catch (error) {
    console.error(
      `[TOPUP-LOG] Could not record the attempt for ${orderNumber}: ${error.message}`
    );
  }
}

/**
 * Expire orders stuck in pending_payment beyond the configured timeout.
 * Only affects pending_payment status; pending_approval orders are left alone.
 *
 * @param {number} timeoutHours - Hours after which an order expires (default 24)
 * @returns {Promise<number>} Number of orders expired
 */
async function expirePendingPaymentOrders(timeoutHours = 24) {
  const db = await getDb();

  if (!db) {
    return 0;
  }

  const { rows } = await db.query(
    `UPDATE orders
     SET status = 'expired',
         updated_at = NOW()
     WHERE status = 'pending_payment'
       AND created_at < NOW() - INTERVAL '${timeoutHours} hours'
     RETURNING order_number`
  );

  if (rows.length > 0) {
    console.log(`[ORDER-EXPIRY] Expired ${rows.length} pending_payment order(s): ${rows.map(r => r.order_number).join(', ')}`);
  }

  return rows.length;
}

module.exports = {
  COLLECTION,
  fetchAllOrders,
  fetchOrder,
  fetchUserOrders,
  fetchOrdersByStatus,
  fetchStatusCounts,
  createOrder,
  updateOrder,
  logTopupAttempt,
  expirePendingPaymentOrders,
};
