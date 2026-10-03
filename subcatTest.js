require("dotenv").config();

const catalog = require("./catalog.js");

/*
|--------------------------------------------------------------------------
| SHOP2TOPUP SUB-CATEGORY TEST
|--------------------------------------------------------------------------
| Every Blood Strike package shipped with a fabricated sub_category_id
| (999-1006). Those numbers do not exist in the supplier catalog, so
| validation silently failed for all eight packages.
|
| These checks pin the real ids, which were confirmed live against player
| 586019939994 and cross-checked by discovering them back out of the
| supplier catalog. An id that drifts from its product name is the failure
| mode that matters: the API would validate one product while the store
| sells another.
*/

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log(
      "  FAIL  " + label + (detail ? "  -> " + detail : "")
    );
  }
}

// Confirmed against SHOP2TOPUP: category 491 "Direct Topup".
const BLOOD_STRIKE_SUB_IDS = {
  elite: 1649, // Strike Pass Elite
  premium: 1650, // Strike Pass Premium
  levelup: 1647, // Level Up Pass
  gold100: 1639, // 100 + 5 Gold
  gold300: 1640, // 300 + 20 Gold
  gold500: 1641, // 500 + 40 Gold
  gold1000: 1642, // 1,000 + 100 Gold
  gold2000: 1643, // 2,000 + 260 Gold
};

const FREE_FIRE_SUB_IDS = {
  weekly: 110, // Free Fire Weekly
};

console.log("\n== sub-category ids are real, not placeholders ==");

const games = catalog.DEFAULT_CATALOG.games;

const bloodStrike = games.find((g) => g.id === "blood_strike");
const freeFire = games.find((g) => g.id === "free_fire");

check("blood_strike is in the default catalog", Boolean(bloodStrike));
check("free_fire is in the default catalog", Boolean(freeFire));

for (const [pkgId, expected] of Object.entries(
  BLOOD_STRIKE_SUB_IDS
)) {
  const pkg = bloodStrike.packages.find((p) => p.id === pkgId);

  check(
    "blood_strike/" + pkgId + " uses " + expected,
    pkg && Number(pkg.sub_category_id) === expected,
    pkg ? String(pkg.sub_category_id) : "package missing"
  );
}

for (const [pkgId, expected] of Object.entries(
  FREE_FIRE_SUB_IDS
)) {
  const pkg = freeFire.packages.find((p) => p.id === pkgId);

  check(
    "free_fire/" + pkgId + " uses " + expected,
    pkg && Number(pkg.sub_category_id) === expected,
    pkg ? String(pkg.sub_category_id) : "package missing"
  );
}

console.log("\n== no placeholder ids remain ==");

// The old values were a 999..1006 run. Any id below 100 is a strong
// signal of an invented value, since real ids run much higher.
const allPkgs = games.flatMap((g) =>
  g.packages.map((p) => ({
    game: g.id,
    id: p.id,
    sub: Number(p.sub_category_id),
  }))
);

check(
  "no package has an id in the old 999-1006 placeholder block",
  allPkgs.every(
    (p) => p.sub < 999 || p.sub > 1006 || p.sub === 110
  ),
  JSON.stringify(
    allPkgs.filter((p) => p.sub >= 999 && p.sub <= 1006)
  )
);

check(
  "every package has a numeric sub_category_id",
  allPkgs.every((p) => Number.isFinite(p.sub) && p.sub > 0),
  JSON.stringify(allPkgs.filter((p) => !p.sub))
);

console.log("\n== Blood Strike IDs are 12 digits ==");

// The example shown to customers must match the real format. Blood Strike
// IDs are 12 digits, not the 9-digit placeholder that was there before.
check(
  "the Blood Strike example is a 12 digit id",
  /^\d{12}$/.test(bloodStrike.idExample),
  bloodStrike.idExample
);

check(
  "the example is not the old 9 digit placeholder",
  bloodStrike.idExample !== "123456789",
  bloodStrike.idExample
);

// A 12 digit example must pass the same guard the text handler uses.
const ID_PATTERN = /^[0-9]{5,20}$/;
check(
  "the example passes the player id guard",
  ID_PATTERN.test(bloodStrike.idExample),
  bloodStrike.idExample
);

console.log("\n== every Blood Strike package is covered ==");

check(
  "no Blood Strike package is left unmapped",
  bloodStrike.packages.every((p) =>
    Object.prototype.hasOwnProperty.call(
      BLOOD_STRIKE_SUB_IDS,
      p.id
    )
  ),
  bloodStrike.packages
    .filter(
      (p) =>
        !Object.prototype.hasOwnProperty.call(
          BLOOD_STRIKE_SUB_IDS,
          p.id
        )
    )
    .map((p) => p.id)
    .join(",")
);

check(
  "no verified id is unused",
  Object.keys(BLOOD_STRIKE_SUB_IDS).every((k) =>
    bloodStrike.packages.some((p) => p.id === k)
  )
);

console.log("\n== supplier product names the ids must resolve to ==");

// The mapping was chosen from the supplier's own names. A drift here means
// the store sells a different product than the one being validated.
const SUPPLIER_NAMES = {
  elite: "Strike Pass Elite",
  premium: "Strike Pass Premium",
  levelup: "Level Up Pass",
  gold100: "100 + 5 Gold",
  gold300: "300 + 20 Gold",
  gold500: "500 + 40 Gold",
  gold1000: "1,000 + 100 Gold",
  gold2000: "2,000 + 260 Gold",
};

const playerValidate = require("./playerValidate.js");

(async () => {
  const live =
    process.env.SKIP_LIVE !== "1" && process.env.SHOP2TOPUP_API_KEY;

  if (!live) {
    console.log(
      "\n  SKIP  live catalog check (no API key)"
    );
  } else {
    console.log("\n== live catalog check ==");

    let mismatches = 0;

    for (const [pkgId, name] of Object.entries(
      SUPPLIER_NAMES
    )) {
      const found =
        await playerValidate.findBloodStrikeSubcategory(pkgId);

      const expected = BLOOD_STRIKE_SUB_IDS[pkgId];

      const ok =
        found && Number(found.id) === expected;

      if (!ok) {
        mismatches++;
      }

      check(
        pkgId +
          " resolves to " +
          expected +
          " (" +
          name +
          ")",
        ok,
        found
          ? "found " + found.id + " " + found.category_name
          : "not found"
      );
    }

    check(
      "every Blood Strike id resolves from the supplier catalog",
      mismatches === 0,
      mismatches + " mismatch(es)"
    );

    // The regional variants share product names, so the search must land
    // on the global "Direct Topup" category, not a regional one.
    const sample =
      await playerValidate.findBloodStrikeSubcategory("gold500");

    check(
      "discovery picks the global category, not a regional one",
      sample &&
        String(sample.category_name).trim() === "Direct Topup",
      sample ? sample.category_name : "not found"
    );
  }

  console.log(
    "\n" +
      (fail === 0
        ? "ALL SUB-CATEGORY CHECKS PASSED"
        : fail + " CHECK(S) FAILED") +
      "  (" +
      pass +
      " passed, " +
      fail +
      " failed)"
  );

  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("TEST CRASH:", err);
  process.exit(1);
});