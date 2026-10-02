/*
|--------------------------------------------------------------------------
| SHOP2TOPUP PLAYER VALIDATION
|--------------------------------------------------------------------------
| Implements validation against SHOP2TOPUP API:
| - GET /catalog/subcategories (to find Blood Strike subcategories)
| - GET /catalog/category/:categoryId/requirements (for dynamic fields)
| - POST /api/endpoints/v1/player/validate (actual validation)
|
| Authentication: Authorization: Bearer <KEY_ID>.<KEY_SECRET>
*/

const https = require("https");

const API_BASE = process.env.SHOP2TOPUP_API_BASE || "https://www.shop2topup.com";
const API_KEY = process.env.SHOP2TOPUP_API_KEY;

// In-memory cache for subcategories and requirements
let subcategoriesCache = null;
let subcategoriesCacheTime = 0;
let requirementsCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/*
|--------------------------------------------------------------------------
| HTTP HELPER
|--------------------------------------------------------------------------
*/
function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      return reject(new Error("SHOP2TOPUP_API_KEY not configured"));
    }

    const url = new URL(path, API_BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "HASA-Gold-Bot/1.0",
      },
      timeout: 15000,
    };

    console.log(`[SHOP2TOPUP] ${method} ${url.pathname}`);

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode, data: parsed, headers: res.headers });
        } catch {
          resolve({ statusCode: res.statusCode, data: data, headers: res.headers });
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (body) {
      console.log(`[SHOP2TOPUP] Request body:`, JSON.stringify(body));
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/*
|--------------------------------------------------------------------------
| SUBCATEGORIES FETCHING
|--------------------------------------------------------------------------
*/
async function fetchSubcategories() {
  const now = Date.now();
  if (subcategoriesCache && (now - subcategoriesCacheTime) < CACHE_TTL) {
    return subcategoriesCache;
  }

  const response = await httpRequest("GET", "/catalog/subcategories");

  if (response.statusCode !== 200) {
    throw new Error(`Failed to fetch subcategories: ${response.statusCode}`);
  }

  // Expected response: { success: true, data: [...] }
  const data = response.data?.data || response.data || [];
  subcategoriesCache = data;
  subcategoriesCacheTime = now;
  return data;
}

/*
|--------------------------------------------------------------------------
| REQUIREMENTS FETCHING
|--------------------------------------------------------------------------
*/
async function fetchRequirements(categoryId) {
  const cacheKey = String(categoryId);
  const now = Date.now();

  if (requirementsCache.has(cacheKey)) {
    const cached = requirementsCache.get(cacheKey);
    if ((now - cached.time) < CACHE_TTL) {
      return cached.data;
    }
  }

  const response = await httpRequest("GET", `/catalog/category/${categoryId}/requirements`);

  if (response.statusCode !== 200) {
    // No requirements is valid - return empty array
    return [];
  }

  const data = response.data?.data || response.data || [];
  requirementsCache.set(cacheKey, { data, time: now });
  return data;
}

/*
|--------------------------------------------------------------------------
| FIND BLOOD STRIKE SUBCATEGORY
|--------------------------------------------------------------------------
| Returns the subcategory object for Blood Strike, or null if not found.
*/
async function findBloodStrikeSubcategory(productId) {
  const subcategories = await fetchSubcategories();

  // Look for Blood Strike subcategories
  // SHOP2TOPUP typically has game names in the subcategory
  const bloodStrikeSubs = subcategories.filter((sub) => {
    const name = (sub.name || sub.title || "").toLowerCase();
    return name.includes("blood strike") || name.includes("bloodstrike");
  });

  if (bloodStrikeSubs.length === 0) {
    return null;
  }

  // If we have a specific product mapping, use it
  // Otherwise return the first Blood Strike subcategory
  // The productId from our catalog (elite, premium, gold100, etc.) needs to map
  // For now, return the first match - admin can override via catalog
  return bloodStrikeSubs[0];
}

/*
|--------------------------------------------------------------------------
| VALIDATE PLAYER - Main exported function
|--------------------------------------------------------------------------
| Returns:
|   { success: true, playerId, playerName, region }
|   { success: false, error, message, retryable }
*/
async function validateShop2TopupPlayer(playerId, product) {
  // product is our internal package object with sub_category_id and requirements
  const subCategoryId = product?.sub_category_id;
  const productRequirements = product?.requirements || [];

  if (!subCategoryId) {
    return { success: false, error: "CONFIG_MISSING", message: "Sub-category ID not configured for this product", retryable: false };
  }

  if (!API_KEY) {
    console.log("[SHOP2TOPUP] No API key configured");
    return { success: false, error: "CONFIG_MISSING", message: "SHOP2TOPUP API key not configured", retryable: false };
  }

  console.log(`[SHOP2TOPUP] Validating player ${playerId} for sub_category_id ${subCategoryId}`);

  // Fetch dynamic requirements for this subcategory if not already configured
  let requirements = productRequirements;
  if (requirements.length === 0) {
    try {
      const fetchedRequirements = await fetchRequirements(subCategoryId);
      if (fetchedRequirements && fetchedRequirements.length > 0) {
        console.log(`[SHOP2TOPUP] Fetched requirements for sub_category_id ${subCategoryId}:`, JSON.stringify(fetchedRequirements));
        // Convert to our format: [{ field_name: "...", value: "..." }]
        requirements = fetchedRequirements.map((req) => ({
          field_name: req.field_name || req.name || req.key,
          value: req.default_value || req.value || req.example || "",
        })).filter((r) => r.field_name);
      }
    } catch (reqErr) {
      console.warn(`[SHOP2TOPUP] Failed to fetch requirements for ${subCategoryId}:`, reqErr.message);
    }
  }

  // Build request body with all required fields
  const body = {
    sub_category_id: Number(subCategoryId),
    player_id: String(playerId),
  };

  // Add any dynamic requirement fields from product config or fetched requirements
  if (Array.isArray(requirements)) {
    for (const req of requirements) {
      if (req.field_name && req.value !== undefined && req.value !== "") {
        body[req.field_name] = req.value;
      }
    }
  }

  console.log(`[SHOP2TOPUP] Request body:`, JSON.stringify(body));

  try {
    const response = await httpRequest("POST", "/api/endpoints/v1/player/validate", body);

    const { statusCode, data } = response;

    // SHOP2TOPUP returns the player object under `data`, not `player`.
    // Accept both shapes so the contract is resilient.
    const player = data?.data?.player || data?.player || data?.data;

    // Successful validation
    if (statusCode === 200 && data?.success && player && (player.player_id || player.player_name)) {
      return {
        success: true,
        playerId: String(player.player_id ?? playerId),
        playerName: player.player_name ?? "Unknown",
        region: player.region || player.server || null,
      };
    }

    // SHOP2TOPUP returns errors as a nested object:
    //   { success:false, error: { code, message, action, retryable } }
    // but flat shapes also occur, so normalise to a string code + message.
    const errorObj =
      data?.error && typeof data.error === "object" ? data.error : null;

    const errorCode = String(
      errorObj?.code ||
        data?.code ||
        data?.error_code ||
        (typeof data?.error === "string" ? data.error : "") ||
        "UNKNOWN"
    ).toUpperCase();

    const errorMessage = String(
      errorObj?.message || data?.message || data?.msg || "Validation failed"
    );

    // The API tells us whether a retry is worthwhile; trust it when present.
    const apiRetryable =
      typeof errorObj?.retryable === "boolean"
        ? errorObj.retryable
        : typeof data?.retryable === "boolean"
          ? data.retryable
          : null;

    console.log(`[SHOP2TOPUP] Error code: ${errorCode}, message: ${errorMessage}`);

    // Retryable errors
    if (errorCode === "PLAYER_CHECK_UNAVAILABLE" || statusCode === 503) {
      return { success: false, error: "PLAYER_CHECK_UNAVAILABLE", message: "Verification service temporarily unavailable, please try again", retryable: true };
    }

    if (errorCode === "PLAYER_BUSY") {
      return { success: false, error: "PLAYER_BUSY", message: "Player is currently busy, please try again in a moment", retryable: true };
    }

    if (errorCode === "RATE_LIMIT_EXCEEDED" || statusCode === 429) {
      return { success: false, error: "RATE_LIMIT_EXCEEDED", message: "Too many requests, please wait before trying again", retryable: true };
    }

    // Non-retryable errors
    if (errorCode === "PLAYER_NOT_FOUND" || statusCode === 404) {
      return { success: false, error: "PLAYER_NOT_FOUND", message: errorMessage, retryable: false };
    }

    if (errorCode === "INVALID_PARAMETER") {
      return { success: false, error: "INVALID_PARAMETER", message: `Invalid parameter: ${errorMessage}`, retryable: false };
    }

    if (errorCode === "REGION_MISMATCH") {
      return { success: false, error: "REGION_MISMATCH", message: "Player region does not match product region", retryable: false };
    }

    // Handle other common error codes
    if (errorCode === "INVALID_SUB_CATEGORY" || errorCode === "SUB_CATEGORY_NOT_FOUND") {
      return { success: false, error: "INVALID_SUB_CATEGORY", message: "Invalid sub-category ID for this product", retryable: false };
    }

    if (errorCode === "MISSING_REQUIRED_FIELD" || errorCode === "REQUIRED_FIELD_MISSING") {
      return { success: false, error: "MISSING_REQUIRED_FIELD", message: `Missing required field: ${errorMessage}`, retryable: false };
    }

    // Other errors - keep the API code so the bot can react to it.
    return {
      success: false,
      error: errorCode,
      message: errorMessage,
      retryable: apiRetryable === null ? false : apiRetryable,
    };

  } catch (err) {
    // Network/timeout errors
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.message?.includes("timeout")) {
      return { success: false, error: "PLAYER_CHECK_UNAVAILABLE", message: "Verification service unreachable, please try again", retryable: true };
    }

    console.error("[SHOP2TOPUP] Network error:", err.message);
    return { success: false, error: "NETWORK_ERROR", message: "Network error during validation", retryable: true };
  }
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/
module.exports = {
  validateShop2TopupPlayer,
  fetchSubcategories,
  fetchRequirements,
  findBloodStrikeSubcategory,
  // For backwards compatibility with existing index.js calls
  validatePlayer: async (subCategoryId, playerId, extraFields) => {
    const result = await validateShop2TopupPlayer(playerId, { sub_category_id: subCategoryId, requirements: extraFields });
    if (result.success) {
      return { valid: true, player: { player_id: result.playerId, player_name: result.playerName, region: result.region } };
    }
    return { valid: false, error: result.error, message: result.message };
  },
};