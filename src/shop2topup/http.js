/*
|--------------------------------------------------------------------------
| SHOP2TOPUP HTTP
|--------------------------------------------------------------------------
| One transport for every call to the SHOP2TOPUP API:
|
|   - POST /api/endpoints/v1/orders/create
|   - GET  /api/endpoints/v1/orders/:orderId
|   - GET  /api/endpoints/v1/catalog/category/:id/requirements
|   - GET  /api/endpoints/v1/catalog/subcategories
|   - POST /api/endpoints/v1/player/validate
|
| Every path sits under /api/endpoints/v1. Authentication is
| Authorization: Bearer <API_KEY>.
|
| This module only moves bytes. It decides nothing: it returns the status
| code and whatever JSON arrived, and leaves every verdict to the caller,
| because a rejected order and an unreachable host need very different
| handling.
*/

const https = require("https");

const apilog = require("../apilog");

const DEFAULT_BASE = "https://www.shop2topup.com";
const DEFAULT_TIMEOUT = 15000;

let requestCounter = 0;

function request(method, path, options = {}) {
  const {
    baseUrl = DEFAULT_BASE,
    apiKey,
    body = null,
    timeout = DEFAULT_TIMEOUT,
    logBody = true,
  } = options;

  const requestId = `${Date.now()}-${++requestCounter}`;

  return new Promise((resolve, reject) => {
    if (!apiKey) {
      const error = new Error("SHOP2TOPUP_API_KEY not configured");
      error.code = "CONFIG_MISSING";
      apilog.recordResponse(
        apilog.recordRequest({ method, path, requestId, body }),
        { error }
      );
      return reject(error);
    }

    let url;

    try {
      url = new URL(path, baseUrl);
    } catch (parseError) {
      parseError.code = "BAD_BASE_URL";
      apilog.recordResponse(
        apilog.recordRequest({ method, path, requestId, body }),
        { error: parseError }
      );
      return reject(parseError);
    }

    const payload = body ? JSON.stringify(body) : null;

    const options2 = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "HASA-Gold-Bot/1.0",
      },
      timeout,
    };

    if (payload) {
      options2.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const logEntry = apilog.recordRequest({
      method,
      path: url.pathname + url.search,
      requestId,
      body: logBody ? body : null,
      headers: options2.headers,
    });

    const req = https.request(options2, (res) => {
      let data = "";

      res.on("data", (chunk) => { data += chunk; });

      res.on("end", () => {
        let parsed;

        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = data;
        }

        apilog.recordResponse(logEntry, {
          statusCode: res.statusCode,
          responseBody: parsed,
          responseHeaders: res.headers,
        });

        resolve({
          statusCode: res.statusCode,
          data: parsed,
          headers: res.headers,
        });
      });
    });

    req.on("error", (err) => {
      apilog.recordResponse(logEntry, { error: err.message || String(err) });
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      const error = new Error("Request timeout");
      error.code = "ETIMEDOUT";
      apilog.recordResponse(logEntry, { error });
      reject(error);
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

module.exports = {
  request,
  DEFAULT_BASE,
  DEFAULT_TIMEOUT,
};
