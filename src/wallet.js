/*
|--------------------------------------------------------------------------
| WALLET
|--------------------------------------------------------------------------
| Customer credit, recharges and the ledger.
|
| Only an admin can credit a wallet. A customer can:
|
|   1. View their balance and recent transactions.
|   2. Request a recharge via EZ Cash or Bank Transfer.
|   3. Pay for orders using their wallet balance.
|
| Recharges are approved by an admin after verifying payment proof.
|
| The store is hydrated alongside the order store so the balance screens
| read the same data the rest of the bot does.
*/

const store = require("./database/wallets");
const { getDb } = require("./database/firestore");
const nexaura = require("./database/nexaura");

const MIN_RECHARGE = 100;
const MAX_SINGLE_RECHARGE = 50000;
const MAX_DAILY_RECHARGE = 100000;

const Markup = {
  inlineKeyboard: (buttons) => ({ reply_markup: { inline_keyboard: buttons } }),
  button: {
    callback: (text, data) => ({ text, callback_data: data }),
  },
};

const METHODS = {
  ez_cash: { label: "EZ Cash", emoji: "💳" },
  ez_cash_auto: { label: "EZ Cash Auto Verify", emoji: "⚡" },
  bank_transfer: { label: "Bank Transfer", emoji: "🏦" },
};

/*
|--------------------------------------------------------------------------
| BALANCE HELPERS
|--------------------------------------------------------------------------
*/

function getBalance(userId) {
  const wallet = store.getWallet(userId);

  return Number(wallet?.balance) || 0;
}

function getHistory(userId, limit = 20) {
  return store.getUserTransactions(userId, limit);
}

function formatLKR(amount) {
  return Number(amount || 0).toLocaleString("en-US");
}

/*
|--------------------------------------------------------------------------
| RECHARGE
|--------------------------------------------------------------------------
*/

function validateRechargeAmount(amount) {
  const num = Number(amount);

  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: "Please enter a valid amount." };
  }

  if (num < MIN_RECHARGE) {
    return { ok: false, error: `Minimum recharge is LKR ${formatLKR(MIN_RECHARGE)}.` };
  }

  if (num > MAX_SINGLE_RECHARGE) {
    return { ok: false, error: `Maximum single recharge is LKR ${formatLKR(MAX_SINGLE_RECHARGE)}.` };
  }

  return { ok: true, amount: num };
}

function validatePaymentProof(proof) {
  if (!proof || typeof proof !== "string") {
    return { ok: false, error: "Please send a payment proof screenshot." };
  }

  if (!proof.startsWith("https://") && !proof.startsWith("http://")) {
    return { ok: false, error: "Payment proof must be a valid image URL." };
  }

  return { ok: true, proof };
}

async function requestRecharge(userId, amount, method, paymentProof) {
  const amountValidation = validateRechargeAmount(amount);

  if (!amountValidation.ok) {
    return amountValidation;
  }

  const isAutoVerify = method === "ez_cash_auto";

  let validatedProof = paymentProof;

  if (!isAutoVerify) {
    const proofValidation = validatePaymentProof(paymentProof);

    if (!proofValidation.ok) {
      return proofValidation;
    }

    validatedProof = proofValidation.proof;
  }

  const methodKey = String(method || "").toLowerCase().replace(/\s+/g, "_");

  if (!METHODS[methodKey]) {
    return { ok: false, error: "Invalid payment method. Choose EZ Cash or Bank Transfer." };
  }

  const request = {
    userId,
    amount: amountValidation.amount,
    method: methodKey,
    paymentProof: validatedProof,
    status: "pending",
  };

  const result = await store.createRechargeRequest(request);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, requestId: result.id };
}

/*
|--------------------------------------------------------------------------
| CHECKOUT
|--------------------------------------------------------------------------
*/

async function payWithWallet(userId, amount, refId, refType, note) {
  const amountNum = Number(amount);

  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { ok: false, error: "Invalid amount." };
  }

  const balance = getBalance(userId);

  if (balance < amountNum) {
    return {
      ok: false,
      error: `Insufficient balance. You have LKR ${formatLKR(balance)}. Please recharge your wallet.`,
    };
  }

  return store.debitWallet(userId, amountNum, refId, refType, note);
}

/*
|--------------------------------------------------------------------------
| WALLET SCREEN
|--------------------------------------------------------------------------
*/

function walletScreenText(userId) {
  const balance = getBalance(userId);
  const history = getHistory(userId, 5);

  let text =
    `💳 *WALLET*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 Balance: *LKR ${formatLKR(balance)}*\n\n`;

  if (history.length > 0) {
    text += `📜 *Recent Transactions*\n\n`;

    for (const entry of history) {
      const sign = entry.type === "credit" ? "+" : "-";
      const emoji = entry.type === "credit" ? "➕" : "➖";
      const when = new Date(entry.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      text += `${emoji} ${sign}LKR ${formatLKR(entry.amount)}` +
        (entry.note ? ` · ${esc(entry.note)}` : "") +
        `\n   ${when}\n\n`;
    }
  } else {
    text += `_No transactions yet._\n\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `💳 Pay for orders from your balance,\nor recharge with a payment method.`;

  return text;
}

function walletMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡  EZ CASH AUTO VERIFY", "recharge_ez_cash_auto")],
    [Markup.button.callback("➕  RECHARGE", "recharge")],
    [Markup.button.callback("📜  HISTORY", "wallet_history")],
  ]);
}

/*
|--------------------------------------------------------------------------
| RECHARGE FLOW
|--------------------------------------------------------------------------
*/

function rechargeAmountText() {
  return (
    `💵 *RECHARGE*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Send the amount in *LKR* you want to\nadd to your wallet.\n\n` +
    `Minimum: *${formatLKR(MIN_RECHARGE)}*\n` +
    `Maximum: *${formatLKR(MAX_SINGLE_RECHARGE)}*\n\n` +
    `Or use /wallet to go back.`
  );
}

function rechargeConfirmText(amount) {
  return (
    `💵 *CONFIRM RECHARGE*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Amount: *LKR ${formatLKR(amount)}*\n\n` +
    `Choose a payment method below.`
  );
}

function rechargeConfirmMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡  EZ CASH AUTO VERIFY", "recharge_ez_cash_auto")],
    [Markup.button.callback("💳  EZ CASH", "recharge_ez_cash")],
    [Markup.button.callback("🏦  BANK TRANSFER", "recharge_bank_transfer")],
    [Markup.button.callback("❌  CANCEL", "recharge_cancel")],
  ]);
}

function rechargeProofText(method, amount) {
  const methodLabel = METHODS[method]?.label || method;

  return (
    `💵 *RECHARGE VIA ${methodLabel.toUpperCase()}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Amount: *LKR ${formatLKR(amount)}*\n\n` +
    `⚠️ Your wallet will be credited only\n` +
    `after an admin verifies your payment.\n\n` +
    `Send a screenshot of your payment now.`
  );
}

function rechargeAutoVerifyText(amount) {
  return (
    `⚡ *EZ CASH AUTO VERIFY*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Amount: *LKR ${formatLKR(amount)}*\n\n` +
    `Send the *14-digit RN number* from your\neZ Cash payment SMS.\n\n` +
    `We will verify it instantly and credit\nyour wallet automatically.`
  );
}

function rechargeAutoVerifyMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❌  CANCEL", "recharge_cancel")],
  ]);
}

function rechargeSubmittedText(request) {
  const methodLabel = METHODS[request.method]?.label || request.method;

  return (
    `✅ *RECHARGE REQUESTED*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💵 Amount: LKR ${formatLKR(request.amount)}\n` +
    `💳 Method: ${methodLabel}\n\n` +
    `⏳ Your request is pending admin approval.\n` +
    `You will be notified once it is confirmed.`
  );
}

function esc(str) {
  return String(str || "").trim();
}

/*
|--------------------------------------------------------------------------
| ADMIN WALLET
|--------------------------------------------------------------------------
*/

function pendingRechargesText(pending) {
  let text =
    `💰 *PENDING RECHARGES*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${pending.length} request(s) awaiting approval:\n\n`;

  for (const req of pending.slice(0, 10)) {
    const methodLabel = METHODS[req.method]?.label || req.method;
    const when = new Date(req.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    text +=
      `🧾 ${code(req.id)}\n` +
      `👤 ${code(req.userId)}\n` +
      `💵 LKR ${formatLKR(req.amount)} · ${methodLabel}\n` +
      `🕒 ${when}\n\n`;
  }

  if (pending.length > 10) {
    text += `...and ${pending.length - 10} more.\n\n`;
  }

  text += `👇 Open a request to approve or reject it:`;

  return text;
}

function pendingRechargesMenu(pending) {
  const buttons = pending.slice(0, 10).map((req) => [
    Markup.button.callback(
      `🧾 ${req.id} · LKR ${formatLKR(req.amount)}`,
      `wallet_recharge_${req.id}`
    ),
  ]);

  buttons.push([Markup.button.callback("👑  ADMIN PANEL", "admin_home")]);

  return Markup.inlineKeyboard(buttons);
}

function rechargeReviewText(request) {
  const methodLabel = METHODS[request.method]?.label || request.method;
  const when = new Date(request.createdAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    `💰 *RECHARGE REVIEW*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 Request:\n${code(request.id)}\n\n` +
    `👤 User:\n${code(request.userId)}\n\n` +
    `💵 Amount:\nLKR ${formatLKR(request.amount)}\n\n` +
    `💳 Method:\n${methodLabel}\n\n` +
    `🕒 Requested:\n${when}\n\n` +
    `📸 Proof:\n${request.paymentProof ? "[attached]" : "none"}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `👇 Approve or reject this recharge:`
  );
}

function rechargeReviewMenu(request) {
  const buttons = [];

  if (request.paymentProof) {
    buttons.push([
      Markup.button.callback(
        "🖼  VIEW PROOF",
        `wallet_proof_${request.id}`
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback(
      "✅  APPROVE",
      `wallet_approve_${request.id}`
    ),
    Markup.button.callback(
      "❌  REJECT",
      `wallet_reject_${request.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback("💰  PENDING RECHARGES", "admin_wallets"),
  ]);

  return Markup.inlineKeyboard(buttons);
}

function code(str) {
  return `\`${esc(str)}\``;
}

/*
|--------------------------------------------------------------------------
| HISTORY
|--------------------------------------------------------------------------
*/

function walletHistoryText(userId) {
  const transactions = getHistory(userId, 20);
  const balance = getBalance(userId);

  let text =
    `📜 *WALLET HISTORY*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 Current Balance: LKR ${formatLKR(balance)}\n\n`;

  if (transactions.length === 0) {
    text += `_No transactions yet._`;
    return text;
  }

  for (const tx of transactions) {
    const sign = tx.type === "credit" ? "+" : "-";
    const emoji = tx.type === "credit" ? "➕" : "➖";
    const when = new Date(tx.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    text += `${emoji} ${sign}LKR ${formatLKR(tx.amount)}` +
      (tx.note ? ` · ${esc(tx.note)}` : "") +
      `\n   ${when}\n\n`;
  }

  return text;
}

async function hydrate() {
  return store.hydrate();
}

async function getPendingRecharges(limit = 50) {
  return store.getPendingRecharges(limit);
}

async function getRecharge(requestId) {
  return store.getRecharge(requestId);
}

async function approveRecharge(requestId, adminId) {
  return store.approveRecharge(requestId, adminId);
}

async function rejectRecharge(requestId, adminId, reason = null) {
  return store.rejectRecharge(requestId, adminId, reason);
}

module.exports = {
  METHODS,
  MIN_RECHARGE,
  MAX_SINGLE_RECHARGE,
  MAX_DAILY_RECHARGE,
  getBalance,
  getHistory,
  formatLKR,
  validateRechargeAmount,
  validatePaymentProof,
  requestRecharge,
  payWithWallet,
  walletScreenText,
  walletMenu,
  rechargeAmountText,
  rechargeConfirmText,
  rechargeConfirmMenu,
  rechargeProofText,
  rechargeSubmittedText,
  pendingRechargesText,
  pendingRechargesMenu,
  rechargeReviewText,
  rechargeReviewMenu,
  walletHistoryText,
  hydrate,
  getPendingRecharges,
  getRecharge,
  approveRecharge,
  rejectRecharge,
  rechargeAutoVerifyText,
  rechargeAutoVerifyMenu,
  Markup,
  code,
};
