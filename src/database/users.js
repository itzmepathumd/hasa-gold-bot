/*
|--------------------------------------------------------------------------
| USER RECORDS
|--------------------------------------------------------------------------
| One row per Telegram user, with telegram_id as the primary business key.
|
| Only what the store actually needs is kept: enough to address the customer
| and to recognise them again. No payment details, no message history and
| nothing the shop does not use.
|
| The customer row is created by the first write that needs it, which is why
| every write path calls ensure_user(): a wallet credit for a user the bot
| has never seen, an order, and a recharge all need the row to exist before
| a foreign key can point at it.
|
| The balance is stored here and is never written by application code. Only
| wallet_credit(), wallet_debit() and approve_recharge() in
| database/schema.sql may change it, and each of them writes the matching
| ledger row in the same transaction.
*/

const { getDb } = require("./connection");
const { walletFromRow } = require("./mappers");

const COLLECTION = "users";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Record a customer.
 *
 * Called on every order so the admin list and search keep working. Only the
 * id is required; the rest fills in as it becomes known.
 */
async function upsertUser({ userId, username, firstName, lastName, walletBalance }) {
  if (!userId) {
    return { ok: false, error: "userId is required" };
  }

  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  try {
    // A name already stored is never blanked by an update that carries no
    // name, so a message with no signature cannot erase what we know.
    await db.query(`SELECT ensure_user($1, $2, $3)`, [
      Number(userId),
      username || null,
      firstName || null,
    ]);

    if (lastName !== undefined) {
      await db.query(
        `UPDATE users SET last_name = $2 WHERE telegram_id = $1`,
        [Number(userId), lastName || null]
      );
    }

    if (walletBalance !== undefined) {
      // Balance is moved by wallet_credit/wallet_debit, which also record the
      // ledger entry; this path only exists so a test or an operator can set
      // an opening figure, and it writes a ledger row to keep the two in step.
      await db.query(
        `SELECT wallet_credit($1, GREATEST($2 - COALESCE((SELECT balance FROM users WHERE telegram_id = $1), 0), 0),
                'Opening balance adjustment', 'user', $1::text, 'balance_adjustment', $3)`,
        [
          Number(userId),
          Number(walletBalance),
          `adjust:${Number(userId)}:${nowIso()}`,
        ]
      );
    }

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function getUser(userId) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  try {
    const { rows } = await db.query(
      `SELECT telegram_id, username, first_name, last_name, balance, role,
              is_banned, created_at, updated_at
         FROM users
        WHERE telegram_id = $1`,
      [Number(userId)]
    );

    return rows.length ? walletFromRow({ ...rows[0], first_name: rows[0].first_name }) : null;
  } catch (error) {
    console.error(`[USERS] Read failed: ${error.message}`);

    return null;
  }
}

async function listUsers(limit = 500) {
  const db = await getDb();

  if (!db) {
    return [];
  }

  try {
    const { rows } = await db.query(
      `SELECT telegram_id, username, first_name, last_name, balance, role,
              is_banned, created_at, updated_at
         FROM users
        ORDER BY created_at DESC
        LIMIT $1`,
      [Number(limit)]
    );

    return rows.map((row) => walletFromRow(row));
  } catch (error) {
    console.error(`[USERS] List failed: ${error.message}`);

    return [];
  }
}

async function countUsers() {
  const db = await getDb();

  if (!db) {
    return 0;
  }

  try {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS total FROM users`);

    return Number(rows[0].total) || 0;
  } catch (error) {
    console.error(`[USERS] Count failed: ${error.message}`);

    return 0;
  }
}

async function setBanned(userId, banned) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  try {
    await db.query(`UPDATE users SET is_banned = $2 WHERE telegram_id = $1`, [
      Number(userId),
      Boolean(banned),
    ]);

    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target, detail)
       VALUES (NULL, $1, $2, $3::jsonb)`,
      [
        Boolean(banned) ? "user_banned" : "user_unbanned",
        String(userId),
        JSON.stringify({ telegram_id: Number(userId), banned: Boolean(banned) }),
      ]
    );

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function logAdminAction(adminId, action, target, detail) {
  const db = await getDb();

  if (!db) {
    return { ok: false };
  }

  try {
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        Number(adminId),
        String(action),
        target ? String(target) : null,
        detail ? JSON.stringify(detail) : null,
      ]
    );

    return { ok: true };
  } catch (error) {
    console.error(`[ADMIN-LOG] Could not record ${action}: ${error.message}`);

    return { ok: false };
  }
}

module.exports = {
  COLLECTION,
  upsertUser,
  getUser,
  listUsers,
  countUsers,
  setBanned,
  logAdminAction,
};
