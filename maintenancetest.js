/*
|--------------------------------------------------------------------------
| MAINTENANCE MODE TEST
|--------------------------------------------------------------------------
| The gate is the whole feature, so what matters is that a non-admin update
| is refused while an admin's is served, that the flag actually persists, and
| that the toggle is reachable from the panel. All three are checked from the
| source: the module owns the state, the middleware owns the refusal, and the
| panel owns the switch. Booting the bot here would need a live Telegram and
| database, which is what this test exists to avoid.
*/

const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const moduleSource = fs.readFileSync(path.join(__dirname, "maintenance.js"), "utf8");
const schemaSource = fs.readFileSync(
  path.join(__dirname, "database", "schema.sql"),
  "utf8"
);

/*
| The body of the global middleware, from its async callback to next().
| The gate has to sit inside it: a separate middleware registered after the
| existing one would still run, but checking the source is what proves the
| refusal happens before a handler is reached.
*/
const middleware = indexSource.match(
  /bot\.use\(async \(ctx, next\) => \{[\s\S]*?\n  await next\(\);\n\}\)/
);

const maintenanceUi = indexSource.match(/maintenance: `[\s\S]*?`,\n/);
const maintenanceMenuFn = indexSource.match(
  /function maintenanceMenu\(\) \{[\s\S]*?\n\}/
);
const adminMenuFn = indexSource.match(/function adminMenu\(\) \{[\s\S]*?\n\}/);
const toggleAction = indexSource.match(
  /bot\.action\("admin_maintenance"[\s\S]*?\n\}\);/
);
const hydrateCall = indexSource.match(
  /const state = await maintenance\.hydrate\(\);[\s\S]*?\n  \}/
);

console.log("\n== the module owns the flag ==");

check("maintenance.js exists", moduleSource.length > 0);
check(
  "exports toggle()",
  /toggle,/.test(moduleSource.match(/module\.exports = \{[\s\S]*?\};/)?.[0])
);
check(
  "exports isEnabled()",
  /isEnabled,/.test(moduleSource.match(/module\.exports = \{[\s\S]*?\};/)?.[0])
);
check(
  "exports setEnabled()",
  /setEnabled,/.test(moduleSource.match(/module\.exports = \{[\s\S]*?\};/)?.[0])
);
check(
  "exports hydrate()",
  /hydrate,/.test(moduleSource.match(/module\.exports = \{[\s\S]*?\};/)?.[0])
);
check(
  "reads the setting from the database",
  /products\.readSetting\(SETTING_KEY\)/.test(moduleSource)
);
check(
  "writes the setting to the database",
  /products\.writeSetting\(SETTING_KEY, value\)/.test(moduleSource)
);
check(
  "the flag lives in memory as well as the database",
  /^let enabled = false;$/m.test(moduleSource)
);
check(
  "a failed read leaves the shop open, not paused by accident",
  /hydrate\(\) \{[\s\S]*?catch \(error\) \{[\s\S]*?console\.error\("\[MAINTENANCE\] Hydration failed:", error\.message\)/.test(
    moduleSource
  )
);
check(
  "the toggle is live before the database write, not after it",
  (() => {
    const body = moduleSource.match(
      /async function setEnabled\(next\) \{[\s\S]*?\n\}/
    )?.[0];

    return Boolean(
      body &&
        body.indexOf("enabled = value;") < body.indexOf("products.writeSetting(")
    );
  })()
);
check(
  "a failed write is logged, not swallowed",
  /catch \(error\) \{[\s\S]*?console\.error\("\[MAINTENANCE\] Could not persist the flag:", error\.message\)/.test(
    moduleSource
  )
);
check(
  "a failed write reports that the state was not persisted",
  /return \{ previous, enabled, persisted \};/.test(moduleSource)
);

console.log("\n== the gate refuses non-admins ==");

check("the global middleware is found", Boolean(middleware));

if (middleware) {
  const body = middleware[0];

  check(
    "the gate runs before next()",
    body.indexOf("maintenance.isEnabled()") < body.indexOf("await next()")
  );
  check(
    "the gate runs after the update is logged",
    body.indexOf("maintenance.isEnabled()") > body.indexOf("console.log(")
  );
  check(
    "the gate runs before the typing indicator",
    body.indexOf("maintenance.isEnabled()") < body.indexOf("anim.typing(")
  );
  check(
    "the admin is exempt",
    /ctx\.from\?\.id !== ADMIN_ID/.test(body)
  );
  check(
    "a callback query is answered so the spinner stops",
    /if \(ctx\.callbackQuery\) \{[\s\S]*?answerCbQuery\(\)/.test(body)
  );
  check(
    "the customer gets the maintenance screen",
    /ctx\s*\.reply\(UI\.maintenance/.test(body)
  );
  check(
    "next() is not reached when paused",
    /return;\s*\n  \}/.test(body.slice(body.indexOf("maintenance.isEnabled()")))
  );
}

console.log("\n== the customer-facing copy ==");

check("UI.maintenance is defined", Boolean(maintenanceUi));
check("maintenanceMenu() is defined", Boolean(maintenanceMenuFn));

if (maintenanceUi) {
  const message = maintenanceUi[0];

  check(
    "the copy says the bot is unavailable",
    /BOT UNAVAILABLE/.test(message)
  );
  check(
    "the copy mentions maintenance",
    /maintenance/i.test(message)
  );
  check(
    "the copy tells the customer to check back",
    /check back soon/i.test(message)
  );
  check(
    "the copy offers support",
    /support/i.test(message)
  );
  check(
    "no unbalanced Markdown emphasis",
    (message.match(/\*/g) || []).length % 2 === 0
  );
}

console.log("\n== the admin can switch it ==");

check("adminMenu() is found", Boolean(adminMenuFn));

if (adminMenuFn) {
  check(
    "the maintenance button is first in the panel",
    adminMenuFn[0].indexOf('"admin_maintenance"') <
      adminMenuFn[0].indexOf('"admin_pending"')
  );
  check(
    "the button label reflects the current state",
    /MAINTENANCE MODE — ON/.test(adminMenuFn[0]) &&
      /MAINTENANCE MODE — OFF/.test(adminMenuFn[0])
  );
}

check("the admin_maintenance action exists", Boolean(toggleAction));

if (toggleAction) {
  const handler = toggleAction[0];

  check(
    "it flips the flag",
    /maintenance\.toggle\(\)/.test(handler)
  );
  check(
    "it is admin-only",
    /ctx\.from\.id !== ADMIN_ID/.test(handler)
  );
  check(
    "it re-renders the panel so the label matches the state",
    /adminMenu\(\)/.test(handler) && /adminHomeText\(\)/.test(handler)
  );
  check(
    "the click is settled before anything is sent",
    handler.indexOf("answerCbQuery()") < handler.indexOf("maintenance.toggle()")
  );
}

check(
  "a /maintenance command exists with on/off args",
  /bot\.command\("maintenance", async \(ctx\) => \{[\s\S]*?maintenance\.(toggle|setEnabled)\(/.test(
    indexSource
  )
);
check(
  "/maintenance command parses on/off arguments",
  /const arg = String\(ctx\.message\.text \|\| ""\)\s*\.\s*split\(/.test(indexSource)
);
check(
  "/maintenance command handles explicit on/off",
  /arg === "on" \|\| arg === "off"/.test(indexSource)
);
check(
  "/maintenance command calls setEnabled for explicit arg",
  /maintenance\.setEnabled\(arg === "on"\)/.test(indexSource)
);

console.log("\n== it survives a restart ==");

check("hydrate() is called on boot", Boolean(hydrateCall));

if (hydrateCall) {
  check(
    "hydrate() is called before the provider init",
    indexSource.indexOf("await maintenance.hydrate()") <
      indexSource.indexOf("await topupProvider.initialize()")
  );
}

check(
  "the flag is seeded in the schema",
  /'maintenance_mode', 'false'::jsonb/.test(schemaSource)
);
check(
  "the seed is an upsert, so a live deployment is not reset",
  (() => {
    const settingsSeed = schemaSource.match(
      /INSERT INTO settings \(key, value\)[\s\S]*?ON CONFLICT \(key\) DO NOTHING;/
    );

    return Boolean(
      settingsSeed &&
        settingsSeed[0].indexOf("maintenance_mode") !== -1
    );
  })()
);
check(
  "the seed defaults to off, so a fresh deployment opens",
  /'maintenance_mode', 'false'::jsonb/.test(schemaSource)
);

console.log(
  "\n" +
    (fail === 0
      ? "ALL MAINTENANCE CHECKS PASSED"
      : fail + " CHECK(S) FAILED") +
    "  (" +
    pass +
    " passed, " +
    fail +
    " failed)"
);

process.exit(fail === 0 ? 0 : 1);