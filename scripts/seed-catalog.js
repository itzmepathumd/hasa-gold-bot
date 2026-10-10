#!/usr/bin/env node
/*
|--------------------------------------------------------------------------
| LOAD THE CATALOGUE INTO THE DATABASE
|--------------------------------------------------------------------------
| Copies catalog.json into the games, products and payment_methods tables.
|
| This is the one place old JSON data is read on purpose. It exists so an
| operator who already has a catalogue file can move it into the new
| database in one command. It is not run at startup, and nothing else in the
| bot reads catalog.json once PostgreSQL is configured.
|
|   node scripts/seed-catalog.js --dry-run   show what would be written
|   node scripts/seed-catalog.js             write it
|
| Safe to run more than once: every row is written by its natural key, so a
| second run updates the same rows instead of duplicating them.
*/

require("../loadenv");

const fs = require("fs");
const path = require("path");

const products = require("../src/database/products");

const CATALOG_FILE = path.join(__dirname, "..", "catalog.json");

const apply = process.argv.includes("--apply");

function main() {
  if (!products.shouldUseDatabase()) {
    console.error(
      "❌ SUPABASE_DB_URL is not set, so there is nowhere to load the catalogue.\n" +
        "   Set it in .env and make sure database/schema.sql has been run."
    );
    process.exit(1);
  }

  if (!fs.existsSync(CATALOG_FILE)) {
    console.error(`❌ ${CATALOG_FILE} does not exist.`);
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  const games = Array.isArray(parsed.games) ? parsed.games : [];
  const payments = Array.isArray(parsed.payments) ? parsed.payments : [];

  const packages = games.reduce(
    (total, game) => total + (Array.isArray(game.packages) ? game.packages.length : 0),
    0
  );

  console.log(
    `\nCatalog file: ${games.length} game(s), ${packages} package(s), ` +
      `${payments.length} payment method(s)\n`
  );

  for (const game of games) {
    console.log(`  🎮 ${game.id} — ${game.name}`);

    for (const pkg of game.packages || []) {
      const subCategory =
        pkg.sub_category_id ? ` · provider id ${pkg.sub_category_id}` : "";

      console.log(
        `      ${String(pkg.name).padEnd(28)} LKR ${Number(pkg.price).toLocaleString()}${subCategory}`
      );
    }
  }

  if (!apply) {
    console.log(
      "\nDry run only. Nothing was written. Re-run with --apply to load this\n" +
        "into the database. Rows already there are updated, not duplicated."
    );
    return;
  }

  products
    .syncCatalog({ version: 1, games, payments })
    .then((result) => {
      if (!result.ok) {
        console.error(`\n❌ Could not write the catalogue: ${result.error}`);
        process.exit(1);
      }

      console.log("\n✅ Catalogue loaded into PostgreSQL.");
    })
    .catch((error) => {
      console.error(`\n❌ Could not write the catalogue: ${error.message}`);
      process.exit(1);
    });
}

main();
