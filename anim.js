/*
|--------------------------------------------------------------------------
| ANIMATION HELPERS — Modern, smooth, emoji-rich (5-7s)
|--------------------------------------------------------------------------
| Telegram bots have no client-side animation. We simulate it with:
|   1. sendChatAction (real "typing..." / "uploading..." indicator)
|   2. Staged single-message edits with rich Unicode frames
|   3. Final reveal replaces the progress screen
|
| Every helper degrades gracefully: failed edits fall back to sending
| the final screen directly.
*/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── Frame palettes ── */

// Braille spinner (smooth 10-frame)
const SPINNER_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Dot wave (modern, 8-frame)
const SPINNER_DOTS = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

// Emoji spinners (themed)
const SPINNER_GEAR = ["⚙️", "🔧", "⚙️", "🔧"];
const SPINNER_ROCKET = ["🚀", "🌙", "⭐", "☄️", "🌟", "💫"];
const SPINNER_SPARKLE = ["✨", "💫", "⭐", "🌟", "✨", "💫"];
const SPINNER_LOADING = ["🔄", "🔃", "🔄", "🔃"];
const SPINNER_SEARCH = ["🔍", "🔎", "🔍", "🔎"];
const SPINNER_PACKAGE = ["📦", "🎁", "📦", "🎁"];
const SPINNER_MONEY = ["💰", "💸", "💰", "💸"];
const SPINNER_CHECK = ["✅", "🟢", "✅", "🟢"];

// Progress bars (10-width)
const BAR = {
  FULL: "▰",
  EMPTY: "▱",
  FULL_SMALL: "█",
  EMPTY_SMALL: "░",
  FULL_ROUND: "●",
  EMPTY_ROUND: "○",
  FULL_ARROW: "▶",
  EMPTY_ARROW: "▷",
};

/* ── Typing indicator (repeats sendChatAction) ── */
function typing(ctx, { action = "typing", duration = 2000 } = {}) {
  const chatId = ctx.chat?.id;
  if (!chatId) return Promise.resolve();

  const tick = async () => {
    try {
      await ctx.telegram.sendChatAction(chatId, action);
    } catch { /* ignore */ }
  };

  tick();
  return (async () => {
    const started = Date.now();
    while (Date.now() - started < duration) {
      await sleep(3500);
      if (Date.now() - started >= duration) break;
      await tick();
    }
  })().catch(() => {});
}

/* ── Progress bar builders ── */
function progressBar(done, total, width = 12, style = "default") {
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  const empty = width - filled;

  switch (style) {
    case "default":
      return BAR.FULL.repeat(filled) + BAR.EMPTY.repeat(empty);
    case "small":
      return BAR.FULL_SMALL.repeat(filled) + BAR.EMPTY_SMALL.repeat(empty);
    case "round":
      return BAR.FULL_ROUND.repeat(filled) + BAR.EMPTY_ROUND.repeat(empty);
    case "arrow":
      return BAR.FULL_ARROW.repeat(filled) + BAR.EMPTY_ARROW.repeat(empty);
    default:
      return BAR.FULL.repeat(filled) + BAR.EMPTY.repeat(empty);
  }
}

function progressPercent(done, total) {
  return Math.round((done / total) * 100);
}

/* ── Safe edit with chatId resolution ── */
async function safeEdit(ctx, messageId, text, extra) {
  const chatId = ctx.chat?.id ?? ctx.chatId;

  try {
    if (typeof ctx.editMessageText === "function") {
      await ctx.editMessageText(text, extra);
      return true;
    }
    if (typeof ctx.telegram?.editMessageText === "function" && chatId != null) {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, extra);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Emoji label builder ── */
function emojiLabel(emoji, text) {
  return `${emoji}  <b>${text}</b>`;
}

/* ── STAGED PROGRESS — 5-7s total ──
   Steps render as: spinner + bar + ✅ completed steps
   Final replaces the whole message. */
async function stages(ctx, {
  title,
  steps = [],
  final,
  extra,
  frame = 900,       // ms per step (3 steps × 900 = 2.7s + pauses = ~4-5s)
  spinner = "braille",
  barStyle = "default",
  showPercent = true,
  emoji = "⚡",
} = {}) {
  const list = Array.isArray(steps) ? steps : [];
  const total = Math.max(list.length, 1);

  const spinnerFrames =
    spinner === "dots" ? SPINNER_DOTS :
    spinner === "gear" ? SPINNER_GEAR :
    spinner === "rocket" ? SPINNER_ROCKET :
    spinner === "sparkle" ? SPINNER_SPARKLE :
    spinner === "loading" ? SPINNER_LOADING :
    spinner === "search" ? SPINNER_SEARCH :
    spinner === "package" ? SPINNER_PACKAGE :
    spinner === "money" ? SPINNER_MONEY :
    spinner === "check" ? SPINNER_CHECK :
    SPINNER_BRAILLE;

  let messageId = null;
  let lastText = "";

  // Initial frame
  try {
    const initialText = buildFrame(0, 0, "");
    const sent = await ctx.reply(initialText, { parse_mode: "HTML" });
    messageId = sent.message_id;
  } catch { /* final will still send */ }

  // Animate each step
  for (let i = 0; i < list.length; i++) {
    await sleep(frame);

    const done = i + 1;
    const stepText = list.slice(0, done).map((s, idx) => `  ✅ ${s}`).join("\n");
    const text = buildFrame(done, total, stepText);

    if (text === lastText) continue;
    lastText = text;

    if (messageId === null) {
      try {
        const sent = await ctx.reply(text, { parse_mode: "HTML" });
        messageId = sent.message_id;
      } catch { /* keep trying final */ }
      continue;
    }

    await safeEdit(ctx, messageId, text, { parse_mode: "HTML" });
  }

  // Completion pause
  await sleep(700);

  // Final reveal
  if (messageId !== null) {
    const ok = await safeEdit(ctx, messageId, final, { parse_mode: "HTML", ...extra });
    if (ok) return { animated: true, messageId };
  }

  // Fallback
  try {
    await ctx.reply(final, { parse_mode: "HTML", ...extra });
  } catch { /* nothing more */ }

  return { animated: false, messageId };

  function buildFrame(done, total, completedSteps) {
    const spin = spinnerFrames[done % spinnerFrames.length];
    const bar = progressBar(done, total, 12, barStyle);
    const pct = showPercent ? ` ${progressPercent(done, total)}%` : "";
    const header = `${spin}  <b>${emoji} ${title}</b>${pct}\n\n`;
    const barLine = `<code>${bar}</code>\n`;
    return `${header}${barLine}${completedSteps}`;
  }
}

/* ── INLINE BUTTON SPINNER — for callback queries ── */
async function withSpinner(ctx, { label, work, result, extra, spinner = "braille" } = {}) {
  const frames =
    spinner === "dots" ? SPINNER_DOTS :
    spinner === "gear" ? SPINNER_GEAR :
    spinner === "rocket" ? SPINNER_ROCKET :
    spinner === "sparkle" ? SPINNER_SPARKLE :
    spinner === "loading" ? SPINNER_LOADING :
    spinner === "search" ? SPINNER_SEARCH :
    spinner === "package" ? SPINNER_PACKAGE :
    spinner === "money" ? SPINNER_MONEY :
    spinner === "check" ? SPINNER_CHECK :
    SPINNER_BRAILLE;

  let spun = false;
  try {
    await ctx.editMessageText(`${frames[0]}  <b>${label}</b>`, { parse_mode: "HTML" });
    spun = true;

    for (let i = 1; i <= 4; i++) {
      await sleep(300);
      await safeEdit(ctx, undefined, `${frames[i % frames.length]}  <b>${label}</b>`, { parse_mode: "HTML" });
    }

    const value = await work();
    await ctx.editMessageText(result, { parse_mode: "HTML", ...extra });
    return value;
  } catch (err) {
    const msg = String(err?.description || err?.message || "");
    if (msg.includes("message is not modified")) return undefined;
    if (spun) {
      try { await ctx.editMessageText(result, { parse_mode: "HTML", ...extra }); } catch { }
      return undefined;
    }
    throw err;
  }
}

/* ── QUICK REVEAL for button taps (spinner → content) ── */
async function revealEdit(ctx, label, text, extra, { spinner = "braille", frames = 3, delay = 250 } = {}) {
  const spinFrames =
    spinner === "dots" ? SPINNER_DOTS :
    spinner === "gear" ? SPINNER_GEAR :
    spinner === "rocket" ? SPINNER_ROCKET :
    spinner === "sparkle" ? SPINNER_SPARKLE :
    spinner === "loading" ? SPINNER_LOADING :
    spinner === "search" ? SPINNER_SEARCH :
    spinner === "package" ? SPINNER_PACKAGE :
    spinner === "money" ? SPINNER_MONEY :
    spinner === "check" ? SPINNER_CHECK :
    SPINNER_BRAILLE;

  for (let i = 0; i < frames; i++) {
    try {
      await ctx.editMessageText(`${spinFrames[i % spinFrames.length]}  <b>${label}</b>`, { parse_mode: "HTML" });
    } catch { break; }
    await sleep(delay);
  }
  return safeEdit(ctx, undefined, text, { parse_mode: "HTML", ...extra });
}

/* ── SUCCESS BEAT — celebratory pulse ── */
async function successBeat(ctx, { text, extra, frames = ["✅", "✅ 🎉", "🎉 ✅ ✨", "✨ 🎉 ✅"] } = {}) {
  const base = text ? `\n\n${text}` : "";
  try {
    const sent = await ctx.reply(`${frames[0]}${base}`, { parse_mode: "HTML", ...extra });
    for (let i = 1; i < frames.length; i++) {
      await sleep(180);
      await safeEdit(ctx, sent.message_id, `${frames[i]}${base}`, { parse_mode: "HTML", ...extra });
    }
    return sent.message_id;
  } catch { return null; }
}

/* ── NOTIFY CUSTOMER — staged reveal for admin actions ── */
async function notifyCustomer(bot, order, { title, body }) {
  const chatId = order.userId;

  const text =
    `${title}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🧾 <b>ORDER ID</b>\n<code>${order.id}</code>\n\n` +
    `🎮 <b>GAME</b>\n${order.gameName || "Blood Strike"}\n\n` +
    `📦 <b>PACKAGE</b>\n${order.productName}\n\n` +
    `🆔 <b>${order.idLabel || "PLAYER ID"}</b>\n<code>${order.playerId}</code>\n\n` +
    `💰 <b>AMOUNT</b>\nLKR ${Number(order.price).toLocaleString()}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${body}`;

  let messageId = null;
  try {
    const sent = await bot.telegram.sendMessage(chatId, "⚡", { parse_mode: "HTML" });
    messageId = sent.message_id;
  } catch {
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" }); } catch { }
    return;
  }

  const target = { telegram: bot.telegram, chat: { id: chatId } };

  await sleep(500);
  await safeEdit(target, messageId, `✅ <b>Order update</b>\n\n${text}`, { parse_mode: "HTML" });
  await sleep(600);
  await safeEdit(target, messageId, `🎉 <b>Order update</b>\n\n${text}`, { parse_mode: "HTML" });
}

module.exports = {
  sleep,
  typing,
  progressBar,
  progressPercent,
  safeEdit,
  stages,
  withSpinner,
  revealEdit,
  successBeat,
  notifyCustomer,
  // Export frame palettes for custom use
  SPINNER_BRAILLE,
  SPINNER_DOTS,
  SPINNER_GEAR,
  SPINNER_ROCKET,
  SPINNER_SPARKLE,
  SPINNER_LOADING,
  SPINNER_SEARCH,
  SPINNER_PACKAGE,
  SPINNER_MONEY,
  SPINNER_CHECK,
  BAR,
};