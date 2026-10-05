/*
|--------------------------------------------------------------------------
| API LOG
|--------------------------------------------------------------------------
| A tiny in-memory circular buffer for SHOP2TOPUP API request/response
| logging. The admin panel can read from it to show recent API activity.
*/

const MAX_ENTRIES = 200;

const entries = [];

function logEntry(entry) {
  entries.push(entry);

  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

function recordRequest({
  method,
  path,
  requestId,
  body = null,
  headers = null,
}) {
  const entry = {
    requestId,
    at: Date.now(),
    method: String(method || "").toUpperCase(),
    path: String(path || ""),
    requestBody: body,
    requestHeaders: headers,
    statusCode: null,
    responseBody: null,
    responseHeaders: null,
    durationMs: null,
    error: null,
  };

  entry.startedAt = entry.at;

  logEntry(entry);

  return entry;
}

function recordResponse(entry, {
  statusCode,
  responseBody,
  responseHeaders = null,
  error = null,
}) {
  if (!entry) {
    return;
  }

  entry.finishedAt = Date.now();
  entry.durationMs = entry.finishedAt - entry.startedAt;
  entry.statusCode = statusCode;
  entry.responseBody = responseBody;
  entry.responseHeaders = responseHeaders;
  entry.error = error ? String(error) : null;
}

function recent(count = 50) {
  const slice = entries.slice(-Math.max(1, count));

  return slice.map((e) => ({
    requestId: e.requestId,
    at: e.at,
    method: e.method,
    path: e.path,
    statusCode: e.statusCode,
    durationMs: e.durationMs,
    error: e.error,
    requestBody: e.requestBody,
    responseBody: e.responseBody,
  }));
}

function clear() {
  entries.length = 0;
}

module.exports = {
  recordRequest,
  recordResponse,
  recent,
  clear,
  MAX_ENTRIES,
};
