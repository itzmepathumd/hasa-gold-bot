/*
|--------------------------------------------------------------------------
| MAINTENANCE MODE
|--------------------------------------------------------------------------
| A single shop-wide switch that pauses the bot for customers without
| stopping the process. While it is on, every update from a non-admin is
| answered with the maintenance screen instead of being served, so the pause
| is total rather than advisory.
|
| The flag is persisted in the settings table so it survives a restart, and
| mirrored in memory because a toggle has to take effect on the next update,
| not on the next boot. When PostgreSQL is absent the memory copy is the only
| one: the toggle still works until the process restarts, which is the honest
| degradation for a run without a database.
*/

const products = require("./src/database/products");

const SETTING_KEY = "maintenance_mode";

let enabled = false;
let hydrated = false;

/*
| The stored value is read as either a bare boolean or an object with an
| `enabled` field, so the shape can be extended later without a migration
| failing this function.
*/
async function hydrate() {
  hydrated = true;

  try {
    const stored = await products.readSetting(SETTING_KEY);

    if (typeof stored === "boolean") {
      enabled = stored;
    } else if (stored && typeof stored === "object") {
      if (typeof stored.enabled === "boolean") {
        enabled = stored.enabled;
      }
    }
  } catch (error) {
    // A failed read leaves the shop open: pausing by accident is worse than
    // a silent fallback to normal trading.
    console.error("[MAINTENANCE] Hydration failed:", error.message);
  }

  return { mode: enabled ? "on" : "off" };
}

function isEnabled() {
  return enabled === true;
}

function isHydrated() {
  return hydrated;
}

/*
| The memory copy is written first, so a toggle is live for the next update
| even when the database write is slow or unavailable. A persistence failure
| is logged but never undoes the toggle, and reports which state the shop is
| actually in.
*/
async function setEnabled(next) {
  const value = Boolean(next);
  const previous = enabled;
  let persisted = true;

  enabled = value;

  if (!products.shouldUseDatabase()) {
    persisted = false;
  } else {
    try {
      const result = await products.writeSetting(SETTING_KEY, value);

      if (!result || result.ok === false) {
        persisted = false;
        console.error(
          "[MAINTENANCE] Could not persist the flag:",
          result?.error || "unknown error"
        );
      }
    } catch (error) {
      persisted = false;
      console.error("[MAINTENANCE] Could not persist the flag:", error.message);
    }
  }

  return { previous, enabled, persisted };
}

async function toggle() {
  return setEnabled(!isEnabled());
}

module.exports = {
  SETTING_KEY,
  hydrate,
  isEnabled,
  isHydrated,
  setEnabled,
  toggle,
};