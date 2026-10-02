/*
|--------------------------------------------------------------------------
| PLAYER VALIDATION — External API integration
|--------------------------------------------------------------------------
| Calls POST /api/endpoints/v1/player/validate to verify player IDs
| before order placement.
*/

const https = require("https");

const API_BASE = process.env.PLAYER_API_BASE || "https://api.example.com";
const API_KEY = process.env.PLAYER_API_KEY;

/*
|--------------------------------------------------------------------------
| VALIDATE PLAYER
|--------------------------------------------------------------------------
| Returns:
|   { valid: true, player: { player_id, player_name, region } }
|   { valid: false, error: "PLAYER_NOT_FOUND" | "PLAYER_CHECK_UNAVAILABLE" | "INVALID_RESPONSE" | "CONFIG_MISSING", message }
*/
async function validatePlayer(subCategoryId, playerId, extraFields = {}) {
  if (!API_KEY) {
    return { valid: false, error: "CONFIG_MISSING", message: "Player validation API key not configured" };
  }

  const body = {
    sub_category_id: Number(subCategoryId),
    player_id: String(playerId),
    ...extraFields,
  };

  const url = new URL("/api/endpoints/v1/player/validate", API_BASE);
  const options = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    timeout: 10000,
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);

          if (res.statusCode === 200 && parsed.success && parsed.player) {
            resolve({
              valid: true,
              player: {
                player_id: parsed.player.player_id,
                player_name: parsed.player.player_name,
                region: parsed.player.region || null,
              },
            });
            return;
          }

          // Handle specific error codes
          const errorCode = parsed.error_code || parsed.error || "UNKNOWN";
          if (errorCode === "PLAYER_NOT_FOUND" || res.statusCode === 404) {
            resolve({ valid: false, error: "PLAYER_NOT_FOUND", message: "Player ID not found in the game" });
          } else if (errorCode === "PLAYER_CHECK_UNAVAILABLE" || res.statusCode === 503) {
            resolve({ valid: false, error: "PLAYER_CHECK_UNAVAILABLE", message: "Validation service temporarily unavailable, please try again" });
          } else {
            resolve({ valid: false, error: "INVALID_RESPONSE", message: parsed.message || `Validation failed: ${errorCode}` });
          }
        } catch {
          resolve({ valid: false, error: "INVALID_RESPONSE", message: "Invalid response from validation service" });
        }
      });
    });

    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        resolve({ valid: false, error: "PLAYER_CHECK_UNAVAILABLE", message: "Validation service unreachable, please try again" });
      } else {
        resolve({ valid: false, error: "INVALID_RESPONSE", message: `Network error: ${err.message}` });
      }
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ valid: false, error: "PLAYER_CHECK_UNAVAILABLE", message: "Validation request timed out, please try again" });
    });

    req.write(JSON.stringify(body));
    req.end();
  });
}

module.exports = { validatePlayer };