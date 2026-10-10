/*
|--------------------------------------------------------------------------
| PAYMENTS
|--------------------------------------------------------------------------
| Every money movement a customer initiated: a wallet top-up, a direct
| order payment, and the provider reference they supplied.
|
| The rule this module exists to enforce is that a reference number is not
| proof. A row here records what the customer said and what the bot did; the
| verified flag is set by an admin action or by a payment provider that
| already confirmed the deposit, never by the customer's word.
|
| Uniqueness is per method and only where a reference exists, so two
| customers who both paid before a number was issued can both be recorded,
| while a replayed reference cannot create a second row.
*/

const { getDb } = require("./connection");

async function insertPayment(payment) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  const { rows } = await db.query(
    `INSERT INTO payments
        (order_id, user_id, recharge_id, amount, payment_method,
         reference_number, status, verified_at, verified_by)
     VALUES (
        (SELECT id FROM orders WHERE order_number = $1),
        (SELECT ensure_user($2)),
        $3, $4, $5, $6, $7,
        CASE WHEN $7 = 'verified' THEN $8::timestamptz ELSE NULL END,
        $9
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      payment.orderNumber || null,
      Number(payment.telegramId),
      payment.rechargeId || null,
      Number(payment.amount),
      String(payment.method || "").toLowerCase().replace(/\s+/g, "_"),
      payment.referenceNumber || null,
      payment.status || "pending",
      payment.verifiedAt ? new Date(payment.verifiedAt).toISOString() : null,
      payment.verifiedBy ? Number(payment.verifiedBy) : null,
    ]
  );

  if (rows.length === 0) {
    return { ok: false, duplicate: true, error: "Payment already recorded" };
  }

  return { ok: true, id: Number(rows[0].id) };
}

/**
 * A wallet payment for an order. Recorded verified immediately, because the
 * database function that moved the money only succeeds when the balance was
 * really there.
 */
async function recordOrderPayment(payment) {
  return insertPayment({ ...payment, status: "verified" });
}

/**
 * A recharge the customer is asking for. Pending until an admin or a
 * provider confirms it.
 */
async function recordRechargePayment(payment) {
  return insertPayment({ ...payment, status: payment.status || "pending" });
}

async function markStatus(paymentId, status, adminId = null) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(
    `UPDATE payments
        SET status = $2,
            verified_at = CASE WHEN $2 = 'verified' THEN NOW() ELSE NULL END,
            verified_by = $3
      WHERE id = $1`,
    [Number(paymentId), status, adminId ? Number(adminId) : null]
  );

  return { ok: true };
}

async function getPaymentsForUser(userId, limit = 50) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const { rows } = await db.query(
    `SELECT p.id, p.amount, p.payment_method, p.reference_number, p.status,
            p.verified_at, p.created_at, o.order_number
       FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC
      LIMIT $2`,
    [Number(userId), Number(limit)]
  );

  return rows.map((row) => ({
    id: String(row.id),
    amount: Number(row.amount),
    method: row.payment_method,
    referenceNumber: row.reference_number,
    status: row.status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    orderNumber: row.order_number || null,
  }));
}

async function findByReference(method, referenceNumber) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const { rows } = await db.query(
    `SELECT p.id, p.amount, p.payment_method, p.reference_number, p.status,
            p.user_id, p.created_at
       FROM payments p
      WHERE p.payment_method = $1 AND p.reference_number = $2`,
    [String(method || "").toLowerCase().replace(/\s+/g, "_"), String(referenceNumber)]
  );

  return rows.length
    ? {
        id: String(rows[0].id),
        amount: Number(rows[0].amount),
        method: rows[0].payment_method,
        referenceNumber: rows[0].reference_number,
        status: rows[0].status,
        userId: String(rows[0].user_id),
        createdAt: rows[0].created_at,
      }
    : null;
}

/**
 * One deposit the payment provider reported. The unique constraint on
 * (provider, reference_number) makes a replayed RN safe: the second attempt
 * finds the existing row and returns it instead of recording a second
 * deposit.
 */
async function recordProviderDeposit({
  provider = "nexaura",
  referenceNumber,
  telegramId = null,
  depositId = null,
  status = "pending",
  amountLkr = null,
  creditedLkr = null,
  error = null,
}) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  const { rows } = await db.query(
    `INSERT INTO payment_verification_requests
        (provider, reference_number, user_id, deposit_id, status,
         amount_lkr, credited_lkr, last_error, attempts)
     VALUES ($1, $2, (SELECT ensure_user($3)), $4, $5, $6, $7, $8, 1)
     ON CONFLICT (provider, reference_number) DO UPDATE
        SET status = EXCLUDED.status,
            deposit_id = COALESCE(EXCLUDED.deposit_id, payment_verification_requests.deposit_id),
            amount_lkr = COALESCE(EXCLUDED.amount_lkr, payment_verification_requests.amount_lkr),
            credited_lkr = COALESCE(EXCLUDED.credited_lkr, payment_verification_requests.credited_lkr),
            last_error = EXCLUDED.last_error,
            attempts = payment_verification_requests.attempts + 1,
            resolved_at = CASE WHEN EXCLUDED.status <> 'pending' THEN NOW() ELSE NULL END,
            updated_at = NOW()
     RETURNING id, status, attempts`,
    [
      provider,
      String(referenceNumber),
      telegramId ? Number(telegramId) : null,
      depositId,
      status,
      amountLkr,
      creditedLkr,
      error,
    ]
  );

  return {
    ok: true,
    id: Number(rows[0].id),
    status: rows[0].status,
    attempts: Number(rows[0].attempts),
  };
}

/**
 * Find a deposit by its provider reference. Used to decide whether a wallet
 * credit for this deposit already happened.
 */
async function findProviderDeposit(provider, referenceNumber) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const { rows } = await db.query(
    `SELECT id, user_id, deposit_id, status, amount_lkr, credited_lkr,
            wallet_transaction_id, attempts
       FROM payment_verification_requests
      WHERE provider = $1 AND reference_number = $2`,
    [provider, String(referenceNumber)]
  );

  return rows.length
    ? {
        id: Number(rows[0].id),
        userId: rows[0].user_id ? String(rows[0].user_id) : null,
        depositId: rows[0].deposit_id,
        status: rows[0].status,
        amountLkr: rows[0].amount_lkr ? Number(rows[0].amount_lkr) : null,
        creditedLkr: rows[0].credited_lkr ? Number(rows[0].credited_lkr) : null,
        walletTransactionId: rows[0].wallet_transaction_id
          ? Number(rows[0].wallet_transaction_id)
          : null,
        attempts: Number(rows[0].attempts),
      }
    : null;
}

/**
 * Link a wallet credit to the deposit that justified it, once.
 */
async function markDepositCredited(provider, referenceNumber, walletTransactionId, amountLkr) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(
    `UPDATE payment_verification_requests
        SET status = 'credited',
            wallet_transaction_id = $3,
            credited_lkr = COALESCE($4, credited_lkr),
            resolved_at = NOW(),
            updated_at = NOW()
      WHERE provider = $1 AND reference_number = $2`,
    [provider, String(referenceNumber), Number(walletTransactionId), amountLkr]
  );

  return { ok: true };
}

module.exports = {
  insertPayment,
  recordOrderPayment,
  recordRechargePayment,
  markStatus,
  getPaymentsForUser,
  findByReference,
  recordProviderDeposit,
  findProviderDeposit,
  markDepositCredited,
};
