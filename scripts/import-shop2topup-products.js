require("../loadenv");

const { request } = require("../src/shop2topup/http");
const catalog = require("../catalog");

/*
|--------------------------------------------------------------------------
| IMPORT SHOP2TOPUP PRODUCTS
|--------------------------------------------------------------------------
| Copies a game's real product list out of the SHOP2TOPUP catalog and into
| this shop's catalog, so every product has a sub_category_id and can be
| ordered automatically.
|
| Where the game name comes from matters. The products endpoint
| (/catalog/subcategories) has no game field at all, and product names are
| not unique across games: "100 Diamonds" is a Free Fire product and a Mobile
| Legends product and a PUBG product. Matching on names would mix them up and
| charge a customer for the wrong game.
|
| So the game is read from /catalog/categories, where each category carries a
| big_category_name, and only the categories under that game are imported.
|
|   node scripts/import-shop2topup-products.js
|   node scripts/import-shop2topup-products.js --game="Free Fire" --game=free_fire
|   node scripts/import-shop2topup-products.js --apply --price=0
|
| Flags:
|   --apply         write the packages. Without it this only prints a plan.
|   --game=NAME     a big_category_name from the provider, or a local game id.
|                   Repeatable. Defaults to every game already in this shop.
|   --category=ID   only this provider category id. Repeatable.
|   --country=CODE  only categories serving this ISO country code. Repeatable.
|   --region=NAME   only categories in this region name. Repeatable.
|   --price=N       LKR price to give each package. Default 0.
|   --live          add packages unpaused. Default is paused, so a package
|                   with no price set cannot be ordered by mistake.
|
| Nothing here places an order. It only reads the provider's catalog.
*/

const API_BASE = "/api/endpoints/v1/catalog";

/*
| The provider refuses GET /catalog/category/:id/products with this key (401),
| so the product list is read from /catalog/subcategories in one call and
| filtered by category_id instead. Same data, one request.
*/

function parseArgs(argv) {
  const args = { games: [], categories: [], countries: [], regions: [], price: 0, live: false, apply: false };

  for (const raw of argv) {
    const [flag, ...rest] = raw.split("=");
    const value = rest.join("=");

    if (flag === "--apply") args.apply = true;
    else if (flag === "--live") args.live = true;
    else if (flag === "--game") args.games.push(value);
    else if (flag === "--category") args.categories.push(Number(value));
    else if (flag === "--country") args.countries.push(value.trim().toUpperCase());
    else if (flag === "--region") args.regions.push(value.trim().toUpperCase());
    else if (flag === "--price") args.price = Number(value);
  }

  return args;
}

async function api(path) {
  const response = await request("GET", path, {
    apiKey: process.env.SHOP2TOPUP_API_KEY,
    logBody: false,
  });

  if (response.statusCode !== 200 || response.data?.success !== true) {
    const code = response.data?.error?.code || response.statusCode;

    throw new Error(`SHOP2TOPUP refused ${path} (${code})`);
  }

  return response.data.data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const onlyTheseGames = args.games.length > 0;

  if (!process.env.SHOP2TOPUP_API_KEY) {
    throw new Error("SHOP2TOPUP_API_KEY is not set");
  }

  const localGames = catalog.getGames();

  const wanted = args.games.length
    ? args.games
    : [...new Set(localGames.map((g) => g.name))];

  console.log("SHOP2TOPUP PRODUCT IMPORT");
  console.log("=========================");
  console.log(`mode      : ${args.apply ? "WRITE" : "plan only"}`);
  console.log(`price     : LKR ${args.price}`);
  console.log(`new pkgs  : ${args.live ? "unpaused (orderable)" : "paused"}`);

  const categories = await api(`${API_BASE}/categories`);
  const products = await api(`${API_BASE}/subcategories`);

  const productsByCategory = new Map();

  for (const product of products) {
    const id = Number(product.category_id);

    if (!productsByCategory.has(id)) productsByCategory.set(id, []);

    productsByCategory.get(id).push(product);
  }

  const byGame = new Map();

  for (const category of categories) {
    const big = category.big_category_name;

    if (!big) continue;

    if (!byGame.has(big)) byGame.set(big, []);

    byGame.get(big).push(category);
  }

  const targetIds = new Set(wanted.map((w) => w.toLowerCase()));

  let added = 0;
  let skipped = 0;

  const categoryFilters = args.categories.length
    ? new Set(args.categories)
    : null;

  const countryFilters = args.countries.length
    ? new Set(args.countries)
    : null;

  const regionFilters = args.regions.length
    ? new Set(args.regions)
    : null;

  for (const local of localGames) {
    if (
      onlyTheseGames &&
      !targetIds.has(local.id.toLowerCase()) &&
      !targetIds.has(local.name.toLowerCase())
    ) {
      continue;
    }

    const match = byGame.get(local.name);

    if (!match) {
      console.log(`\n${local.id}: no provider category named "${local.name}"`);
      continue;
    }

    const filtered = match.filter((c) => {
      if (categoryFilters && !categoryFilters.has(Number(c.id))) return false;
      if (countryFilters) {
        const codes = new Set(
          (c.country_ids || [])
            .map((co) => String(co.code || "").trim().toUpperCase())
            .filter(Boolean)
        );
        if (![...countryFilters].some((f) => codes.has(f))) return false;
      }
      if (regionFilters) {
        const names = new Set(
          (c.region_ids || [])
            .map((r) => String(r.name || "").trim().toUpperCase())
            .filter(Boolean)
        );
        if (![...regionFilters].some((f) => names.has(f))) return false;
      }
      return true;
    });

    console.log(
      `\n${local.name} (${local.id}) -> ${match.length} provider categor${
        match.length === 1 ? "y" : "ies"
      }${args.categories.length ? `, ${filtered.length} selected` : ""}`
    );

    const held = new Set(
      local.packages
        .map((p) => p.sub_category_id)
        .filter(Boolean)
    );

    for (const category of filtered) {
      const inCategory = productsByCategory.get(Number(category.id)) || [];

      console.log(
        `  ${category.name} (${category.id}) - ${inCategory.length} product(s)`
      );

      for (const product of inCategory) {
        const subCategoryId = Number(product.id);

        if (held.has(subCategoryId)) {
          skipped++;
          console.log(
            `    = ${subCategoryId} ${product.name} - already in this shop`
          );
          continue;
        }

        held.add(subCategoryId);
        added++;

        const priceNote = `Provider USD ${product.price}`;

        console.log(
          `    + ${subCategoryId} ${product.name} - LKR ${args.price}` +
            (args.live ? " (live)" : " (paused)") +
            ` [${priceNote}]`
        );

        if (!args.apply) continue;

        const created = catalog.addPackage(local.id, {
          name: product.name,
          price: args.price,
          note: priceNote,
          sub_category_id: subCategoryId,
        });

        if (!created) {
          console.log(`    ! could not add ${product.name}`);
          continue;
        }

        if (!args.live) {
          catalog.updatePackage(local.id, created.id, { paused: true });
        }
      }
    }
  }

  console.log(
    `\n${added} package(s) to add, ${skipped} already present.` +
      (args.apply ? "" : " Nothing was written: add --apply.")
  );
}

main().catch((error) => {
  console.error("\nIMPORT FAILED:", error.message);
  process.exit(1);
});
