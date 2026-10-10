/*
|--------------------------------------------------------------------------
| ROW MAPPING
|--------------------------------------------------------------------------
| One place that turns a PostgreSQL row into the object the bot has always
| used, and back again. Nothing above this file needs to know which columns
| exist: the bot keeps its camelCase field names and the database keeps its
| snake_case ones.
|
| Two rules carry through every function here:
|
|   undefined is never sent to PostgreSQL. A column that has not been set
|   becomes NULL, which is what "not filled in yet" means in SQL. Sending
|   undefined would be rejected by the driver, so the guard stays.
|
|   Monetary and count columns come back as strings from `pg`, because
|   PostgreSQL NUMERIC and BIGINT arrive as strings to avoid losing
|   precision. They are converted back to Number here so every screen and
|   calculation above sees the type it saw before.
*/

/**
 * `pg` returns NUMERIC as a string. Everything that used to be a JavaScript
 * number stays a JavaScript number.
 */
function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }

  return Boolean(value);
}

function toText(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value);
}

/**
 * Replace undefined with null, recursively, so a value PostgreSQL would
 * reject never reaches a driver. Applied to every JSONB payload.
 *
 * Object keys with no value are dropped, which is what JSON.stringify would
 * do anyway; array members with no value become null, which is what they
 * become when the payload is serialised. Getting this right matters because
 * a provider response that contains undefined stops the write.
 */
function sanitizeJson(value) {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sanitizeJson(item)));
  }

  const clean = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }

    const sanitized = sanitizeJson(item);

    if (sanitized !== undefined) {
      clean[key] = sanitized;
    }
  }

  return clean;
}

/**
 * Timestamps the bot writes are ISO strings; PostgreSQL accepts those
 * directly. Anything the bot holds as a Date is converted on the way in.
 */
function toTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

/**
 * The column list every order read and write uses. `o.*` is avoided on
 * purpose: a new column must be added here, which keeps the object shape and
 * the table in step instead of drifting apart silently.
 */
const ORDER_COLUMNS = [
  "order_number",
  "user_id",
  "game_id",
  "game_name",
  "id_label",
  "product_id",
  "product_key",
  "product_name",
  "player_id",
  "player_name",
  "player_region",
  "quantity",
  "price",
  "total_amount",
  "sub_category_id",
  "status",
  "payment_method",
  "payment_proof",
  "payment_submitted_at",
  "approved_at",
  "rejected_at",
  "rejected_by",
  "reject_reason",
  "previous_status",
  "resolved_at",
  "resolved_by",
  "topup_status",
  "topup_attempts",
  "topup_started_at",
  "topup_completed_at",
  "topup_error",
  "topup_retry_armed",
  "provider",
  "provider_order_id",
  "provider_transaction_id",
  "provider_status",
  "provider_raw",
  "provider_failed",
  "wallet_transaction_id",
];

const ORDER_READ = `
    o.order_number,
    o.user_id,
    o.game_id,
    o.game_name,
    o.id_label,
    o.product_id,
    o.product_key,
    o.product_name,
    o.player_id,
    o.player_name,
    o.player_region,
    o.quantity,
    o.price,
    o.total_amount,
    o.sub_category_id,
    o.status,
    o.payment_method,
    o.payment_proof,
    o.payment_submitted_at,
    o.approved_at,
    o.rejected_at,
    o.rejected_by,
    o.reject_reason,
    o.previous_status,
    o.resolved_at,
    o.resolved_by,
    o.topup_status,
    o.topup_attempts,
    o.topup_started_at,
    o.topup_completed_at,
    o.topup_error,
    o.topup_retry_armed,
    o.provider,
    o.provider_order_id,
    o.provider_transaction_id,
    o.provider_status,
    o.provider_raw,
    o.provider_failed,
    o.wallet_transaction_id,
    o.created_at,
    u.username  AS user_username,
    u.first_name AS user_first_name
`;

/**
 * An order row becomes the object the bot has always worked with. The
 * customer's name is read from the customer row rather than duplicated onto
 * the order, so the admin screens and the analytics still see username and
 * firstName exactly as before.
 */
function orderFromRow(row) {
  const order = {
    id: row.order_number,
    userId: toNumber(row.user_id, row.user_id),
    username: row.user_username || null,
    firstName: row.user_first_name || "",

    gameId: toText(row.game_id),
    gameName: toText(row.game_name),
    idLabel: toText(row.id_label),

    productId: toText(row.product_id),
    productKey: toText(row.product_key),
    productName: toText(row.product_name),

    playerId: toText(row.player_id),
    playerName: toText(row.player_name),
    playerRegion: toText(row.player_region),

    quantity: toNumber(row.quantity, 1),
    price: toNumber(row.price, 0),
    totalAmount: toNumber(row.total_amount, 0),
    subCategoryId: toNumber(row.sub_category_id, null),

    status: row.status,
    paymentMethod: toText(row.payment_method),
    paymentProof: toText(row.payment_proof),
    paymentSubmittedAt: toTimestamp(row.payment_submitted_at),

    approvedAt: toTimestamp(row.approved_at),
    rejectedAt: toTimestamp(row.rejected_at),
    rejectedBy: toNumber(row.rejected_by, null),
    rejectReason: toText(row.reject_reason),
    previousStatus: toText(row.previous_status),
    resolvedAt: toTimestamp(row.resolved_at),
    resolvedBy: toNumber(row.resolved_by, null),

    topupStatus: row.topup_status,
    topupAttempts: toNumber(row.topup_attempts, 0),
    topupStartedAt: toTimestamp(row.topup_started_at),
    topupCompletedAt: toTimestamp(row.topup_completed_at),
    topupError: toText(row.topup_error),
    topupRetryArmed: toBoolean(row.topup_retry_armed, false),

    provider: toText(row.provider),
    providerOrderId: toText(row.provider_order_id),
    providerTransactionId: toText(row.provider_transaction_id),
    providerStatus: toText(row.provider_status),
    providerRaw: row.provider_raw || null,
    providerFailed: toBoolean(row.provider_failed, false),

    walletTransactionId: toNumber(row.wallet_transaction_id, null),

    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };

  return order;
}

/**
 * The order object becomes the column values an INSERT or UPDATE needs.
 * The list is fixed, so a field the mutator never touched is written back
 * with the same value rather than becoming NULL.
 */
function orderToParams(order) {
  return [
    order.id,
    toNumber(order.userId, order.userId),
    toText(order.game_id ?? order.gameId),
    toText(order.gameName),
    toText(order.idLabel),
    toText(order.productId),
    toText(order.productKey),
    toText(order.productName),
    toText(order.playerId),
    toText(order.playerName),
    toText(order.playerRegion),
    toNumber(order.quantity, 1),
    toNumber(order.price, 0),
    toNumber(
      order.totalAmount ??
        Number(order.quantity || 1) * Number(order.price || 0),
      0
    ),
    toNumber(order.subCategoryId, null),
    toText(order.status),
    toText(order.paymentMethod),
    toText(order.paymentProof),
    toTimestamp(order.paymentSubmittedAt),
    toTimestamp(order.approvedAt),
    toTimestamp(order.rejectedAt),
    toNumber(order.rejectedBy, null),
    toText(order.rejectReason),
    toText(order.previousStatus),
    toTimestamp(order.resolvedAt),
    toNumber(order.resolvedBy, null),
    toText(order.topupStatus),
    toNumber(order.topupAttempts, 0),
    toTimestamp(order.topupStartedAt),
    toTimestamp(order.topupCompletedAt),
    toText(order.topupError),
    toBoolean(order.topupRetryArmed, false),
    toText(order.provider),
    toText(order.providerOrderId),
    toText(order.providerTransactionId),
    toText(order.providerStatus),
    sanitizeJson(order.providerRaw),
    toBoolean(order.providerFailed, false),
    toNumber(order.walletTransactionId, null),
  ];
}

/**
 * Snapshot of the customer as it appears on an order. Written once, at
 * creation, so a later rename does not rewrite history.
 */
function walletFromRow(row) {
  return {
    id: String(row.telegram_id),
    userId: String(row.telegram_id),
    telegramUserId: toNumber(row.telegram_id, row.telegram_id),
    balance: toNumber(row.balance, 0),
    username: row.username || null,
    firstName: row.first_name || "",
    role: row.role || "user",
    isBanned: toBoolean(row.is_banned, false),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function transactionFromRow(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: row.transaction_type,
    amount: toNumber(row.amount, 0),
    balanceBefore: toNumber(row.balance_before, 0),
    balanceAfter: toNumber(row.balance_after, 0),
    refId: toText(row.ref_id),
    refType: toText(row.ref_type),
    note: toText(row.description),
    orderId: toNumber(row.order_id, null),
    paymentId: toNumber(row.payment_id, null),
    idempotencyKey: toText(row.idempotency_key),
    createdAt: toTimestamp(row.created_at),
  };
}

function rechargeFromRow(row) {
  return {
    id: row.request_id,
    userId: String(row.user_id),
    amount: toNumber(row.amount, 0),
    method: row.method,
    status: row.status,
    paymentProof: toText(row.payment_proof),
    note: toText(row.note),
    paymentId: toNumber(row.payment_id, null),
    approvedBy: toNumber(row.approved_by, null),
    approvedAt: toTimestamp(row.approved_at),
    rejectedBy: toNumber(row.rejected_by, null),
    rejectedAt: toTimestamp(row.rejected_at),
    rejectReason: toText(row.reject_reason),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

function gameFromRow(row) {
  return {
    id: row.slug,
    name: row.name,
    emoji: row.emoji || "",
    paused: toBoolean(row.is_paused, false),
    idLabel: row.id_label || "Player ID",
    idExample: row.id_example || "",
    sortOrder: toNumber(row.sort_order, 0),
  };
}

function packageFromRow(row) {
  return {
    id: row.package_id,
    name: row.name,
    price: toNumber(row.price, 0),
    paused: toBoolean(row.is_paused, false),
    note: row.note || "",
    sub_category_id: toNumber(row.sub_category_id, null),
    requirements: Array.isArray(row.requirements) ? row.requirements : [],
  };
}

function paymentFromRow(row) {
  return {
    id: row.method_code,
    emoji: row.emoji || "",
    title: row.title,
    paused: toBoolean(row.is_paused, false),
    lines: Array.isArray(row.lines) ? row.lines : [],
  };
}

module.exports = {
  toNumber,
  toBoolean,
  toText,
  toTimestamp,
  sanitizeJson,
  orderFromRow,
  orderToParams,
  ORDER_COLUMNS,
  ORDER_READ,
  walletFromRow,
  transactionFromRow,
  rechargeFromRow,
  gameFromRow,
  packageFromRow,
  paymentFromRow,
};
