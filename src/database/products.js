/*
|--------------------------------------------------------------------------
| PRODUCT CATALOGUE
|--------------------------------------------------------------------------
| Games, packages and payment methods as relational rows.
|
|   games            one row per game
|   products         one row per sellable package inside a game
|   payment_methods  shop configuration: how a customer may pay
|   settings         the rest of the configuration, key by key
|
| product_code is the string the bot's buttons have always sent, for example
| free_fire~weekly. It is the business key for a package, so an upsert can
| never create a second row for the same product, and a payment method keeps
| method_code as its key for the same reason.
|
| The catalogue is read far more often than it is written and it is small, so
| syncCatalog() writes the whole thing in one transaction. That is
| deliberate: a catalogue edit is one atomic act, and it removes any chance
| of a half-applied edit leaving a game with some of its packages.
*/

const { getDb, describeStatus, shouldUseDatabase: connShouldUseDatabase } = require("./connection");
const {
  gameFromRow,
  packageFromRow,
  paymentFromRow,
} = require("./mappers");

const PRODUCTS = "products";
const SETTINGS = "settings";
const PAYMENT_METHODS = "payment_methods";

function shouldUseDatabase() {
  return connShouldUseDatabase();
}

/**
 * Load the whole catalogue in the shape catalog.js exposes: games with their
 * packages nested, plus the payment methods.
 */
async function fetchCatalog() {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const [games, packages, payments] = await Promise.all([
    db.query(
      `SELECT id, slug, name, emoji, id_label, id_example, is_paused, sort_order
         FROM games
        ORDER BY sort_order ASC, name ASC`
    ),
    db.query(
      `SELECT id, game_id, package_id, product_code, name, price, note,
              sub_category_id, requirements, is_paused, sort_order
         FROM products
        ORDER BY sort_order ASC, name ASC`
    ),
    db.query(
      `SELECT method_code, title, emoji, lines, is_paused, sort_order
         FROM payment_methods
        ORDER BY sort_order ASC, title ASC`
    ),
  ]);

  const gameById = new Map();

  const grouped = games.rows.map((row) => {
    const game = { ...gameFromRow(row), packages: [] };

    gameById.set(Number(row.id), game);

    return game;
  });

  for (const row of packages.rows) {
    const game = gameById.get(Number(row.game_id));

    if (game) {
      game.packages.push(packageFromRow(row));
    }
  }

  return {
    version: 1,
    games: grouped,
    payments: payments.rows.map(paymentFromRow),
  };
}

async function fetchPaymentMethods() {
  const db = await getDb();

  if (!db) {
    return [];
  }

  const { rows } = await db.query(
    `SELECT method_code, title, emoji, lines, is_paused, sort_order
       FROM payment_methods
      ORDER BY sort_order ASC, title ASC`
  );

  return rows.map(paymentFromRow);
}

async function findGameId(slug) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const { rows } = await db.query(`SELECT id FROM games WHERE slug = $1`, [String(slug)]);

  return rows.length ? Number(rows[0].id) : null;
}

/**
 * Replace the stored catalogue with this one, in one transaction.
 *
 * The order matters: products are removed before games so a game that no
 * longer exists cannot leave orphaned packages behind, and games are then
 * removed before the surviving ones are written back.
 */
async function syncCatalog(catalog) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const wantedCodes = new Set();

    for (const game of catalog.games || []) {
      const gameRow = await client.query(
        `INSERT INTO games (slug, name, emoji, id_label, id_example, is_paused, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE
            SET name = EXCLUDED.name,
                emoji = EXCLUDED.emoji,
                id_label = EXCLUDED.id_label,
                id_example = EXCLUDED.id_example,
                is_paused = EXCLUDED.is_paused,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW()
         RETURNING id, slug`,
        [
          String(game.id),
          String(game.name),
          String(game.emoji || "🎮"),
          String(game.idLabel || "Player ID"),
          String(game.idExample || "123456789"),
          Boolean(game.paused),
          Number(game.sortOrder || 0),
        ]
      );

      const gameId = Number(gameRow.rows[0].id);

      for (const pkg of game.packages || []) {
        const code = `${game.id}~${pkg.id}`;
        wantedCodes.add(code);

        await client.query(
          `INSERT INTO products
              (game_id, package_id, product_code, name, price, note,
               sub_category_id, requirements, is_paused, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           ON CONFLICT (product_code) DO UPDATE
              SET game_id = EXCLUDED.game_id,
                  package_id = EXCLUDED.package_id,
                  name = EXCLUDED.name,
                  price = EXCLUDED.price,
                  note = EXCLUDED.note,
                  sub_category_id = EXCLUDED.sub_category_id,
                  requirements = EXCLUDED.requirements,
                  is_paused = EXCLUDED.is_paused,
                  sort_order = EXCLUDED.sort_order,
                  updated_at = NOW()`,
          [
            gameId,
            String(pkg.id),
            code,
            String(pkg.name),
            Number(pkg.price || 0),
            String(pkg.note || ""),
            pkg.sub_category_id === null || pkg.sub_category_id === undefined
              ? null
              : Number(pkg.sub_category_id),
            JSON.stringify(Array.isArray(pkg.requirements) ? pkg.requirements : []),
            Boolean(pkg.paused),
            Number(pkg.sortOrder || 0),
          ]
        );
      }
    }

    const wantedGames = (catalog.games || []).map((g) => String(g.id));

    await client.query(
      `DELETE FROM products
        WHERE product_code <> ALL($1::text[])`,
      [Array.from(wantedCodes)]
    );

    await client.query(
      `DELETE FROM games WHERE slug <> ALL($1::text[])`,
      [wantedGames]
    );

    const wantedMethods = new Set();

    for (const payment of catalog.payments || []) {
      const code = String(payment.id);
      wantedMethods.add(code);

      await client.query(
        `INSERT INTO payment_methods (method_code, title, emoji, lines, is_paused, sort_order)
         VALUES ($1, $2, $3, $4::text[], $5, $6)
         ON CONFLICT (method_code) DO UPDATE
            SET title = EXCLUDED.title,
                emoji = EXCLUDED.emoji,
                lines = EXCLUDED.lines,
                is_paused = EXCLUDED.is_paused,
                sort_order = EXCLUDED.sort_order,
                updated_at = NOW()`,
        [
          code,
          String(payment.title),
          String(payment.emoji || "💳"),
          Array.isArray(payment.lines) ? payment.lines.map(String) : [],
          Boolean(payment.paused),
          Number(payment.sortOrder || 0),
        ]
      );
    }

    await client.query(
      `DELETE FROM payment_methods WHERE method_code <> ALL($1::text[])`,
      [Array.from(wantedMethods)]
    );

    await client.query("COMMIT");

    return { ok: true, error: null };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The transaction is already dead.
    }

    return { ok: false, error: error.message };
  } finally {
    client.release();
  }
}

/**
 * Write one package on its own, for a path that knows exactly what changed
 * and does not want to re-send the whole catalogue.
 */
async function singleProductWrite(gameSlug, pkg) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  const gameId = await findGameId(gameSlug);

  if (!gameId) {
    return { ok: false, error: `Game ${gameSlug} does not exist` };
  }

  const code = `${gameSlug}~${pkg.id}`;

  try {
    await db.query(
      `INSERT INTO products
          (game_id, package_id, product_code, name, price, note,
           sub_category_id, requirements, is_paused, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (product_code) DO UPDATE
          SET name = EXCLUDED.name,
              price = EXCLUDED.price,
              note = EXCLUDED.note,
              sub_category_id = EXCLUDED.sub_category_id,
              requirements = EXCLUDED.requirements,
              is_paused = EXCLUDED.is_paused,
              sort_order = EXCLUDED.sort_order,
              updated_at = NOW()`,
      [
        gameId,
        String(pkg.id),
        code,
        String(pkg.name),
        Number(pkg.price || 0),
        String(pkg.note || ""),
        pkg.sub_category_id === null || pkg.sub_category_id === undefined
          ? null
          : Number(pkg.sub_category_id),
        JSON.stringify(Array.isArray(pkg.requirements) ? pkg.requirements : []),
        Boolean(pkg.paused),
        Number(pkg.sortOrder || 0),
      ]
    );

    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function deleteProduct(gameSlug, packageId) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(`DELETE FROM products WHERE product_code = $1`, [
    `${gameSlug}~${packageId}`,
  ]);

  return { ok: true, error: null };
}

async function writePaymentMethod(payment) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(
    `INSERT INTO payment_methods (method_code, title, emoji, lines, is_paused, sort_order)
     VALUES ($1, $2, $3, $4::text[], $5, $6)
     ON CONFLICT (method_code) DO UPDATE
        SET title = EXCLUDED.title,
            emoji = EXCLUDED.emoji,
            lines = EXCLUDED.lines,
            is_paused = EXCLUDED.is_paused,
            sort_order = EXCLUDED.sort_order,
            updated_at = NOW()`,
    [
      String(payment.id),
      String(payment.title),
      String(payment.emoji || "💳"),
      Array.isArray(payment.lines) ? payment.lines.map(String) : [],
      Boolean(payment.paused),
      Number(payment.sortOrder || 0),
    ]
  );

  return { ok: true, error: null };
}

async function deletePaymentMethod(methodCode) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(`DELETE FROM payment_methods WHERE method_code = $1`, [String(methodCode)]);

  return { ok: true, error: null };
}

async function readSetting(key) {
  const db = await getDb();

  if (!db) {
    return null;
  }

  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [String(key)]);

  return rows.length ? rows[0].value : null;
}

async function writeSetting(key, value) {
  const db = await getDb();

  if (!db) {
    return { ok: false, error: "Supabase is not available" };
  }

  await db.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(key), JSON.stringify(value === undefined ? null : value)]
  );

  return { ok: true, error: null };
}

async function readSettings(keys) {
  const db = await getDb();

  if (!db) {
    return {};
  }

  const list = Array.isArray(keys) ? keys : [];
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [list]
  );

  const settings = {};

  for (const row of rows) {
    settings[row.key] = row.value;
  }

  return settings;
}

module.exports = {
  PRODUCTS,
  SETTINGS,
  PAYMENT_METHODS,
  shouldUseDatabase,
  fetchCatalog,
  fetchPaymentMethods,
  findGameId,
  syncCatalog,
  singleProductWrite,
  deleteProduct,
  writePaymentMethod,
  deletePaymentMethod,
  readSetting,
  writeSetting,
  readSettings,
};
