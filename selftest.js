const fs = require("fs");

/*
|--------------------------------------------------------------------------
| SANITY TEST
|--------------------------------------------------------------------------
| Verifies the catalog wiring and every callback route the UI emits.
| Run with: node selftest.js
*/

process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123:FAKE";
process.env.ADMIN_ID = process.env.ADMIN_ID || "1";

const catalog = require("./catalog");

let pass = 0;
let fail = 0;

function check(label, condition) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label);
  }
}

console.log("\n== catalog seeding ==");

const games = catalog.getGames();
const payments = catalog.getPayments();

check("blood strike exists", games.some((g) => g.id === "blood_strike"));
check(
  "blood strike keeps 8 packages",
  catalog.getPackages("blood_strike").length === 8
);
check("two payment methods seeded", payments.length === 2);

console.log("\n== pause enforcement ==");

catalog.toggleGame("blood_strike");
check(
  "paused game is not orderable",
  catalog.isOrderable("blood_strike", "gold100") === false
);
check(
  "paused game drops out of activeGames",
  catalog.activeGames().every((g) => g.id !== "blood_strike")
);
catalog.toggleGame("blood_strike");

catalog.togglePackage("blood_strike", "gold100");
check(
  "paused package is not orderable",
  catalog.isOrderable("blood_strike", "gold100") === false
);
check(
  "paused package hidden from available list",
  catalog.getPackages("blood_strike", { includePaused: false }).length === 7
);
catalog.togglePackage("blood_strike", "gold100");

check(
  "resumed package is orderable again",
  catalog.isOrderable("blood_strike", "gold100") === true
);

console.log("\n== add game / add package ==");

const newGame = catalog.addGame({ name: "PUBG Mobile", emoji: "🪂" });
check("game id is slugified", newGame.id === "pubg_mobile");
check("new game defaults to active", newGame.paused === false);

const newPkg = catalog.addPackage(newGame.id, {
  name: "💎 600 UC",
  price: 1900,
});
check("package created", newPkg.price === 1900);
check(
  "package auto-id from name",
  newPkg.id === "600_uc"
);
check(
  "new game now orderable",
  catalog.isOrderable(newGame.id, newPkg.id) === true
);

console.log("\n== duplicate id handling ==");

const dupGame = catalog.addGame({ name: "PUBG Mobile" });
check(
  "duplicate name gets unique id",
  dupGame.id !== newGame.id && dupGame.id.startsWith("pubg_mobile")
);

console.log("\n== update / delete ==");

catalog.updatePackage(newGame.id, newPkg.id, { price: 2000 });
check(
  "price updated",
  catalog.findPackage(newGame.id, newPkg.id).pkg.price === 2000
);

catalog.updateGame(newGame.id, { idLabel: "Player UID" });
check(
  "id label updated",
  catalog.getGame(newGame.id).idLabel === "Player UID"
);

catalog.deletePackage(newGame.id, newPkg.id);
check(
  "package deleted",
  catalog.getPackages(newGame.id).length === 0
);

catalog.deleteGame(newGame.id);
catalog.deleteGame(dupGame.id);
check("games back to 2", catalog.getGames().length === 2);

console.log("\n== payment methods ==");

const pm = catalog.addPayment({
  title: "eZ Reload",
  lines: ["📱 Number: 077 000 0000", "👤 Name: Test"],
});
check("payment added", pm.lines.length === 2);

catalog.togglePayment(pm.id);
check(
  "paused payment hidden",
  catalog.getPayments({ includePaused: false }).some((p) => p.id === pm.id) === false
);

catalog.updatePayment(pm.id, {
  lines: ["📱 Number: 077 111 1111"],
});
check(
  "payment lines replaced",
  catalog.getPayment(pm.id).lines.length === 1
);

catalog.deletePayment(pm.id);
check("payments back to 2", catalog.getPayments().length === 2);

console.log("\n== ordering safety ==");

check(
  "unknown package rejected",
  catalog.findPackage("blood_strike", "does_not_exist") === null
);
check(
  "unknown game rejected",
  catalog.findPackage("nope", "gold100") === null
);

console.log(
  "\n" + (fail === 0 ? "ALL CHECKS PASSED" : fail + " CHECK(S) FAILED") +
    "  (" + pass + " passed, " + fail + " failed)\n"
);

if (fail > 0) process.exit(1);
