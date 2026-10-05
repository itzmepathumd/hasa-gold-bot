/*
|--------------------------------------------------------------------------
| SHOP2TOPUP ORDER STATUS
|--------------------------------------------------------------------------
| The order API returns a status word, and the word decides whether a
| customer has been served. This maps that word onto the four answers the
| rest of the shop understands:
|
|   success     delivered
|   processing  the wallet was charged, delivery is still running
|   failed      the API refused or gave up; nothing was delivered
|   unknown     the word is not one we recognise, so we refuse to guess
|
| Two rules matter more than speed here:
|
|   1. "pending" is NOT success. The wallet is charged the moment the order
|      is created, so a charge is not a delivery, and telling a customer
|      their top-up arrived before the provider says so would be a lie.
|   2. An unrecognised word is unknown, never success.
*/

const SUCCESS_WORDS = new Set([
  "completed",
  "complete",
  "success",
  "successful",
  "succeeded",
  "fulfilled",
  "delivered",
  "done",
  "finished",
]);

const FAILED_WORDS = new Set([
  "failed",
  "failure",
  "rejected",
  "declined",
  "cancelled",
  "canceled",
  "expired",
  "error",
]);

const PROCESSING_WORDS = new Set([
  "pending",
  "processing",
  "queued",
  "in_progress",
  "submitted",
  "accepted",
  "paid",
  "waiting",
  "new",
]);

/*
| Rejections that mean the request never became an order. Nothing was
| charged, so they are terminal: retrying the same body would be rejected
| the same way.
*/
const REJECTION_WORDS = {
  insufficient_balance: "insufficient_balance",
  insufficient_funds: "insufficient_balance",
  wallet_empty: "insufficient_balance",
  invalid_parameter: "invalid_parameter",
  invalid_parameters: "invalid_parameter",
  invalid_request: "invalid_parameter",
  missing_required_field: "missing_requirement",
  required_field_missing: "missing_requirement",
  invalid_sub_category: "invalid_sub_category",
  sub_category_not_found: "invalid_sub_category",
  product_unavailable: "product_unavailable",
  product_not_found: "product_unavailable",
  player_not_found: "player_not_found",
  region_mismatch: "region_mismatch",
  account_not_eligible: "account_not_eligible",
  duplicate_order: "duplicate_order",
};

/*
| Anything that leaves the outcome unproven. The order may or may not have
| been charged, so it must never be treated as a delivery or as a refusal.
*/
const TRANSIENT_WORDS = {
  rate_limit_exceeded: "rate_limited",
  too_many_requests: "rate_limited",
  service_unavailable: "provider_unavailable",
  internal_error: "provider_unavailable",
  timeout: "provider_unreachable",
};

function normalise(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * The order object, whichever field the API put it in.
 */
function orderFrom(response) {
  const data = response?.data;

  return (
    data?.order ||
    data?.data?.order ||
    (data?.data && typeof data.data === "object" ? data.data : null) ||
    null
  );
}

/**
 * The error code, wherever the API put it. Their errors arrive as a nested
 * object, but flat shapes also occur, so both are read.
 */
function errorCodeFrom(response) {
  const data = response?.data;
  const nested = data?.error && typeof data.error === "object" ? data.error : null;

  return normalise(
    nested?.code ||
      data?.code ||
      data?.error_code ||
      (typeof data?.error === "string" ? data.error : "") ||
      ""
  );
}

function errorMessageFrom(response) {
  const data = response?.data;
  const nested = data?.error && typeof data.error === "object" ? data.error : null;

  return String(
    nested?.message || data?.message || data?.msg || "Order was not accepted"
  );
}

/**
 * Read an order object into the shape the shop works with.
 */
function parseOrder(order) {
  const providerStatus = normalise(order?.status);

  let status = "unknown";
  let statusDetail = "unrecognised_provider_status";

  if (SUCCESS_WORDS.has(providerStatus)) {
    status = "success";
    statusDetail = "provider_completed";
  } else if (FAILED_WORDS.has(providerStatus)) {
    status = "failed";
    statusDetail = `provider_${providerStatus}`;
  } else if (PROCESSING_WORDS.has(providerStatus)) {
    status = "processing";
    statusDetail = `provider_${providerStatus}`;
  } else if (!providerStatus) {
    statusDetail = "no_status_in_response";
  }

  const transactionId =
    order?.transaction_id ||
    order?.transactionId ||
    order?.provider_transaction_id ||
    order?.reference ||
    null;

  return {
    status,
    statusDetail,
    providerStatus: providerStatus || null,
    transactionId: transactionId ? String(transactionId) : null,
    chargedAmount: order?.charged_amount ?? null,
    currency: order?.currency ?? null,
  };
}

/**
 * Turn a create-order response into a result.
 *
 * `request` is echoed back so the caller can record the idempotency key it
 * used, whichever answer came back.
 */
function interpretCreateResponse(response, request = {}) {
  const orderId = request.orderId || null;

  // Transport-level trouble: the request may or may not have landed. The
  // wallet might already have been charged, so this is never a failure.
  if (!response) {
    return {
      success: false,
      status: "unknown",
      statusDetail: "no_response",
      orderId,
      transactionId: null,
      raw: null,
    };
  }

  const statusCode = Number(response.statusCode) || 0;

  if (statusCode === 429 || statusCode === 503) {
    return {
      success: false,
      status: "unknown",
      statusDetail: TRANSIENT_WORDS[
        statusCode === 429 ? "rate_limit_exceeded" : "service_unavailable"
      ],
      orderId,
      transactionId: null,
      raw: safeJson(response),
    };
  }

  if (statusCode >= 500) {
    return {
      success: false,
      status: "unknown",
      statusDetail: "provider_unavailable",
      orderId,
      transactionId: null,
      raw: safeJson(response),
    };
  }

  const code = errorCodeFrom(response);
  const message = errorMessageFrom(response);

  if (statusCode !== 200 || response?.data?.success !== true) {
    if (TRANSIENT_WORDS[code]) {
      return {
        success: false,
        status: "unknown",
        statusDetail: TRANSIENT_WORDS[code],
        orderId,
        transactionId: null,
        raw: safeJson(response),
        error: message,
      };
    }

    // A 4xx was refused outright, so nothing was charged. That is terminal
    // and retrying the identical body would be refused identically.
    return {
      success: false,
      status: "failed",
      statusDetail: REJECTION_WORDS[code] || code || `http_${statusCode}`,
      orderId,
      transactionId: null,
      raw: safeJson(response),
      error: message,
    };
  }

  const order = orderFrom(response);
  const parsed = parseOrder(order);

  return {
    success: parsed.status === "success",
    status: parsed.status,
    statusDetail: parsed.statusDetail,
    // The provider echoes the idempotency key; ours is the authority,
    // because it is what the order record already carries.
    orderId: (order && (order.order_id || order.orderId)) || orderId,
    transactionId: parsed.transactionId,
    providerStatus: parsed.providerStatus,
    chargedAmount: parsed.chargedAmount,
    currency: parsed.currency,
    raw: safeJson(response),
  };
}

/**
 * The same reading for a status lookup.
 */
function interpretLookupResponse(response, orderId) {
  if (!response) {
    return {
      status: "unknown",
      statusDetail: "no_response",
      orderId,
      transactionId: null,
      raw: null,
    };
  }

  const statusCode = Number(response.statusCode) || 0;

  if (statusCode === 404) {
    return {
      status: "unknown",
      statusDetail: "order_not_found",
      orderId,
      transactionId: null,
      raw: safeJson(response),
    };
  }

  if (statusCode === 429 || statusCode >= 500) {
    return {
      status: "unknown",
      statusDetail: statusCode === 429 ? "rate_limited" : "provider_unavailable",
      orderId,
      transactionId: null,
      raw: safeJson(response),
    };
  }

  if (statusCode !== 200 || response?.data?.success !== true) {
    const code = errorCodeFrom(response);

    return {
      status: "unknown",
      statusDetail: TRANSIENT_WORDS[code] || code || `http_${statusCode}`,
      orderId,
      transactionId: null,
      raw: safeJson(response),
    };
  }

  const order = orderFrom(response);
  const parsed = parseOrder(order);

  return {
    status: parsed.status,
    statusDetail: parsed.statusDetail,
    orderId: (order && (order.order_id || order.orderId)) || orderId,
    transactionId: parsed.transactionId,
    providerStatus: parsed.providerStatus,
    chargedAmount: parsed.chargedAmount,
    currency: parsed.currency,
    raw: safeJson(response),
  };
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value?.data ?? value);
    return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
  } catch {
    return null;
  }
}

module.exports = {
  parseOrder,
  interpretCreateResponse,
  interpretLookupResponse,
  orderFrom,
  errorCodeFrom,
  normalise,
  SUCCESS_WORDS,
  FAILED_WORDS,
  PROCESSING_WORDS,
};