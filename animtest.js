const anim = require("./anim");

/*
|--------------------------------------------------------------------------
| ANIMATION TEST
|--------------------------------------------------------------------------
| Telegram has no client-side animation, so a loader is one message that
| gets edited. These checks cover the parts that used to be wrong: NaN%
| progress, the reveal replacing the loader, and a reveal that has to
| carry its own keyboard and parse mode.
*/

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log(
      "  FAIL  " + label + (detail ? "  -> " + detail : "")
    );
  }
}

function makeCtx() {
  const sent = [];
  const edited = [];

  return {
    chat: { id: 42 },
    sent,
    edited,
    async reply(text, extra) {
      sent.push({ text, extra });
      return { message_id: 100 };
    },
    telegram: {
      async editMessageText(chatId, messageId, inlineId, text, extra) {
        edited.push({ chatId, messageId, text, extra });
        return true;
      },
    },
  };
}

(async () => {
  console.log("\n== progress rendering ==");

  check(
    "zero total never yields NaN",
    anim.progressPercent(0, 0) === 0,
    String(anim.progressPercent(0, 0))
  );
  check(
    "undefined values are safe",
    anim.progressPercent(undefined, undefined) === 0
  );
  check(
    "half is fifty percent",
    anim.progressPercent(1, 2) === 50,
    String(anim.progressPercent(1, 2))
  );
  check(
    "bar never exceeds its width",
    anim.progressBar(99, 1).length === 12,
    String(anim.progressBar(99, 1).length)
  );

  console.log("\n== reveal replaces the loader ==");

  const ctx = makeCtx();

  const { animated, result } = await anim.stages(ctx, {
    title: "Checking Player ID",
    steps: ["One", "Two"],
    frame: 1,
    minDuration: 0,
    work: async () => ({ success: true, playerName: "Pro" }),
    final: (r) => `VERIFIED ${r.playerName}`,
  });

  check("work result is returned", result.success === true);
  check(
    "loader was sent once",
    ctx.sent.length === 1,
    String(ctx.sent.length)
  );
  check(
    "loader was edited, not resent",
    ctx.edited.length >= 2,
    String(ctx.edited.length)
  );

  const last = ctx.edited[ctx.edited.length - 1];
  check(
    "final reveal edited the same message",
    last.text === "VERIFIED Pro" && last.messageId === 100,
    last.text
  );
  check("animation reported as applied", animated === true);
  check(
    "no second message after the reveal",
    ctx.sent.length === 1,
    String(ctx.sent.length)
  );

  console.log("\n== reveal carries its own keyboard ==");

  const kbCtx = makeCtx();

  await anim.stages(kbCtx, {
    title: "Checking Player ID",
    steps: ["One"],
    frame: 1,
    minDuration: 0,
    work: async () => ({ success: true }),
    final: () => ({
      text: "VERIFIED",
      parse_mode: "HTML",
      extra: {
        reply_markup: { inline_keyboard: [[{ text: "CONFIRM" }]] },
      },
    }),
  });

  const kbLast = kbCtx.edited[kbCtx.edited.length - 1];

  check(
    "buttons ride along with the reveal",
    Boolean(kbLast.extra.reply_markup),
    JSON.stringify(kbLast.extra)
  );
  check(
    "reveal keeps its own parse mode",
    kbLast.extra.parse_mode === "HTML",
    kbLast.extra.parse_mode
  );
  check(
    "buttons did not leak onto the loader",
    !kbCtx.sent[0].extra.reply_markup,
    JSON.stringify(kbCtx.sent[0].extra)
  );

  console.log("\n== a plain string reveal is unchanged ==");

  const strCtx = makeCtx();

  await anim.stages(strCtx, {
    title: "Plain",
    steps: ["One"],
    frame: 1,
    minDuration: 0,
    extra: { parse_mode: "Markdown" },
    final: "DONE",
  });

  const strLast = strCtx.edited[strCtx.edited.length - 1];
  check("string reveal is used as-is", strLast.text === "DONE");
  check(
    "the outer parse mode is respected",
    strLast.extra.parse_mode === "Markdown",
    strLast.extra.parse_mode
  );

  console.log("\n== a failing work() still reveals ==");

  const errCtx = makeCtx();

  await anim.stages(errCtx, {
    title: "Checking Player ID",
    steps: ["One"],
    frame: 1,
    minDuration: 0,
    work: async () => {
      throw new Error("boom");
    },
    final: (r) => (r && r.__error ? "FAILED" : "unexpected"),
  });

  check(
    "the error becomes the final text",
    errCtx.edited[errCtx.edited.length - 1].text === "FAILED",
    errCtx.edited[errCtx.edited.length - 1].text
  );

  console.log(
    "\n" +
      (fail === 0
        ? "ALL ANIMATION CHECKS PASSED"
        : fail + " CHECK(S) FAILED") +
      "  (" +
      pass +
      " passed, " +
      fail +
      " failed)"
  );

  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("TEST CRASH:", err);
  process.exit(1);
});