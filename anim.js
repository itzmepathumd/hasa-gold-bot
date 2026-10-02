/*
|--------------------------------------------------------------------------
| ANIMATION HELPERS
|--------------------------------------------------------------------------
| Telegram has no client-side animation API for bots, so "animation" here
| means:
|   1. sendChatAction  -> the real "bot is typing..." indicator
|   2. staged edits    -> one message that rewrites itself (spinner + bar)
|   3. final reveal    -> the finished screen replaces the progress text
|
| Everything degrades gracefully: if an edit fails (rate limit, identical
| text, message too old) the final screen is still delivered.
*/

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_FULL = "▰";
const BAR_EMPTY = "▱";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
|--------------------------------------------------------------------------
| TYPING INDICATOR
|--------------------------------------------------------------------------
| Telegram clears the typing action after ~5s, so repeat it while work
| happens. Runs detached so callers do not await it.
*/
function typing(ctx, { action = "typing", duration = 1500 } = {}) {
  const chatId = ctx.chat?.id;

  if (!chatId) return Promise.resolve();

  const tick = async () => {
    try {
      await ctx.telegram.sendChatAction(chatId, action);
    } catch {
      /* bot blocked the chat or rate limited; not fatal */
    }
  };

  tick();

  return (async () => {
    const started = Date.now();

    while (Date.now() - started < duration) {
      await sleep(4000);
      if (Date.now() - started >= duration) break;
      await tick();
    }
  })().catch(() => {});
}

/*
|--------------------------------------------------------------------------
| PROGRESS BAR
|--------------------------------------------------------------------------
*/
function progressBar(done, total, width = 10) {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((done / total) * width))
  );

  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
}

/*
|--------------------------------------------------------------------------
| SAFE EDIT
|--------------------------------------------------------------------------
| Returns true when the edit landed. Swallows the errors that are expected
| during animation: "message is not modified", rate limits, stale messages.
*/
async function safeEdit(ctx, messageId, text, extra) {
  const chatId = ctx.chat?.id ?? ctx.chatId;

  try {
    // ctx.editMessageText is bound to the current chat: most reliable path.
    if (typeof ctx.editMessageText === "function") {
      await ctx.editMessageText(text, extra);
      return true;
    }

    // Raw client needs explicit positional args:
    // editMessageText(chatId, messageId, inlineMessageId, text, extra)
    if (typeof ctx.telegram?.editMessageText === "function" && chatId != null) {
      await ctx.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        extra
      );
      return true;
    }

    return false;
  } catch {
    // Not fatal: callers always have a final-screen fallback.
    return false;
  }
}

/*
|--------------------------------------------------------------------------
| STAGED PROGRESS (4-5s total)
|--------------------------------------------------------------------------
| Sends one message, rewrites it as each step "completes", then replaces
| it with the final screen.
|
|   stages(ctx, {
|     title:   first line, e.g. "📸 Submitting payment proof"
|     steps:   ["Reading screenshot", "Checking details", "Sending to admin"]
|     final:   final markdown text
|     extra:   final keyboard / parse mode
|     frame:   ms between step reveals (default 800 for ~4-5s total)
|   })
*/
async function stages(ctx, { title, steps = [], final, extra, frame = 800 }) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;

  let messageId = null;
  let lastText = "";

  try {
    const sent = await ctx.reply(
      `${SPINNER[0]} *${title}*\n\n${progressBar(0, Math.max(total, 1))}`,
      { parse_mode: "Markdown" }
    );
    messageId = sent.message_id;
  } catch {
    /* fall through: final screen still gets sent */
  }

  for (let i = 0; i < total; i++) {
    await sleep(frame);

    const text =
      `${SPINNER[i % SPINNER.length]} *${title}*\n\n` +
      `${progressBar(i + 1, Math.max(total, 1))}\n` +
      `${list
        .slice(0, i + 1)
        .map((s) => `✅ ${s}`)
        .join("\n")}`;

    if (text === lastText) continue;
    lastText = text;

    if (messageId === null) {
      try {
        const sent = await ctx.reply(text, { parse_mode: "Markdown" });
        messageId = sent.message_id;
      } catch {
        /* keep trying final */
      }
      continue;
    }

    await safeEdit(ctx, messageId, text);
  }

  // Small pause so the completed bar is visible before the reveal.
  await sleep(600);

  if (messageId !== null) {
    const ok = await safeEdit(ctx, messageId, final, extra);

    if (ok) return { animated: true, messageId };
  }

  // Fallback: the animation could not be shown, send the final screen.
  try {
    await ctx.reply(final, extra);
  } catch {
    /* nothing more we can do */
  }

  return { animated: false, messageId };
}

/*
|--------------------------------------------------------------------------
| SUCCESS BEAT
|--------------------------------------------------------------------------
| Short celebratory beat after a completed action.
*/
async function successBeat(ctx, { text, extra } = {}) {
  const frames = ["✅", "✅ 🎉", "🎉 ✅ ✨", "✨ 🎉 ✅"];
  const base = text ? `\n\n${text}` : "";

  try {
    const sent = await ctx.reply(`${frames[0]}${base}`, {
      parse_mode: "Markdown",
      ...(extra || {}),
    });

    for (let i = 1; i < frames.length; i++) {
      await sleep(200);
      await safeEdit(ctx, sent.message_id, `${frames[i]}${base}`, extra);
    }

    return sent.message_id;
  } catch {
    return null;
  }
}

/*
|--------------------------------------------------------------------------
| INLINE SPINNER
|--------------------------------------------------------------------------
| For callback buttons: edit the tapped message into a spinner, run work,
| then edit into the result.
|
|   withSpinner(ctx, { label, work, result, extra })
*/
async function withSpinner(ctx, { label, work, result, extra }) {
  let spun = false;

  try {
    await ctx.editMessageText(`${SPINNER[0]} *${label}*`, {
      parse_mode: "Markdown",
    });
    spun = true;

    for (let i = 1; i <= 3; i++) {
      await sleep(320);
      await safeEdit(ctx, undefined, `${SPINNER[i % SPINNER.length]} *${label}*`, {
        parse_mode: "Markdown",
      });
    }

    const value = await work();

    await ctx.editMessageText(result, extra);

    return value;
  } catch (err) {
    const message = String(err?.description || err?.message || "");

    if (message.includes("message is not modified")) return undefined;

    if (spun) {
      try {
        await ctx.editMessageText(result, extra);
        return undefined;
      } catch {
        /* ignore */
      }
    }

    throw err;
  }
}

module.exports = {
  SPINNER,
  sleep,
  typing,
  progressBar,
  safeEdit,
  stages,
  successBeat,
  withSpinner,
};