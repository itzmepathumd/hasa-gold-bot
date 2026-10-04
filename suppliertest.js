const {
  SupplierParser,
} = require("./src/supplier/supplierParser");
const {
  SupplierAdapter,
} = require("./src/supplier/supplierAdapter");

/*
|--------------------------------------------------------------------------
| SUPPLIER TEST
|--------------------------------------------------------------------------
| The supplier's wording has never been seen by this code, so these checks
| are about not lying:
|
|   1. An unmapped package must never be sent with a guessed product name.
|      A wrong name can deliver the wrong thing to a paying customer.
|   2. A reply we do not recognise must never read as success.
|   3. Test mode must not report delivery, because nothing is sent.
|   4. The supplier account has one conversation, so two orders at once
|      would read each other's replies.
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

const parser = new SupplierParser();

const adapter = new SupplierAdapter({
  productMapping: { weekly: "WEEKLY" },
});

console.log("\n== the MTProto client can be constructed ==");

/*
| These checks exist because the supplier client had never been run outside
| test mode: addEventHandler called NewMessage without `new`, which throws
| "Class constructor cannot be invoked without 'new'" the first time a real
| top-up was attempted. Nothing in the suite touched that path, so the whole
| production flow was unproven until it was exercised against Telegram.
|
| The constructor and its event registration are checked here without a
| network connection, which is enough to catch a class-versus-function call.
*/
check(
  "the supplier client constructs without credentials",
  (() => {
    const { SupplierClient } = require("./src/supplier/index.js");

    try {
      const client = new SupplierClient({ sessionFile: "/dev/null" });

      return client instanceof SupplierClient;
    } catch (error) {
      return false;
    }
  })()
);

check(
  "NewMessage is constructed with new, so registering a handler cannot throw",
  (() => {
    const { NewMessage } = require("telegram/events");

    try {
      // Calling it as a plain function is what broke production mode.
      return Boolean(new NewMessage({ from: "some_bot" }));
    } catch (error) {
      return false;
    }
  })()
);

check(
  "the source registers its handler with new",
  (() => {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(
      __dirname,
      "src",
      "supplier",
      "supplierClient.js"
    );
    const source = fs.readFileSync(file, "utf8");

    // A bare NewMessage( call is the bug; new NewMessage( is the fix.
    return !/(^|[^.\w])NewMessage\(/.test(source.replace(/new NewMessage\(/g, ""));
  })()
);

console.log("\n== command shape ==");

check(
  "confirmed format /id <playerId> <PRODUCT>",
  adapter.buildCommand({
    playerId: "11927288867",
    productKey: "weekly",
  }).command === "/id 11927288867 WEEKLY",
  adapter.buildCommand({
    playerId: "11927288867",
    productKey: "weekly",
  }).command
);

check(
  "a player id with stray spaces is trimmed",
  adapter.buildCommand({
    playerId: "  11927288867  ",
    productKey: "weekly",
  }).command === "/id 11927288867 WEEKLY"
);

console.log("\n== unmapped packages are refused ==");

for (const key of [
  "elite",
  "premium",
  "levelup",
  "gold100",
  "gold300",
  "gold500",
  "gold1000",
  "gold2000",
]) {
  check(
    "Blood Strike " + key + " is not sent",
    !adapter.canFulfill({ productKey: key }) &&
      (() => {
        try {
          adapter.buildCommand({
            playerId: "1",
            productKey: key,
          });
          return false;
        } catch {
          return true;
        }
      })(),
    "buildCommand accepted it"
  );
}

check(
  "the confirmed package is allowed when the player id is present",
  adapter.canFulfill({ productKey: "weekly", playerId: "11927288867" })
);

/*
| A missing or blank player id used to reach the supplier as the literal
| text "undefined" or as an empty argument, because the template
| substitutes whatever it is handed. The order is paid, the command spends
| nothing, and no top-up arrives.
*/
for (const [label, playerId] of [
  ["missing", undefined],
  ["null", null],
  ["empty", ""],
  ["whitespace", "   "],
]) {
  check(
    `an order with a ${label} player id is not fulfillable`,
    !adapter.canFulfill({ productKey: "weekly", playerId })
  );

  check(
    `building a command with a ${label} player id throws rather than sending it`,
    (() => {
      try {
        adapter.buildCommand({
          id: "HG-BAD",
          productKey: "weekly",
          playerId,
        });
        return false;
      } catch {
        return true;
      }
    })()
  );
}

check(
  "a command never contains the word undefined",
  !adapter.buildCommand({
    productKey: "weekly",
    playerId: "11927288867",
  }).command.includes("undefined")
);

check(
  "a name is only guessed when a caller opts in",
  new SupplierAdapter({ strictProductMapping: false })
    .buildCommand({
      playerId: "11927288867",
      productKey: "gold500",
    }).command === "/id 11927288867 GOLD500"
);

console.log("\n== reply parsing ==");

/*
| These are the supplier's real replies, read from its own chat history once
| the MTProto session was working. They matter because the payment
| confirmation is written in Unicode small caps ("Tʀᴀɴsᴀᴄᴛɪᴏɴ"), which is not
| ASCII, so every \bword\b pattern missed it and a top-up that really was
| paid parsed as "unknown" - the customer would be told nothing happened when
| their money had already moved.
|
| Nothing here was invented: each string is a reply the supplier actually
| sent. An earlier hand-written styled variant was dropped from this list
| because it was misspelled and so tested the test, not the parser.
*/
const REAL_SUCCESS_STYLED =
  "✅ Tʀᴀɴsᴀᴄᴛɪᴏɴ Vᴇʀɪғɪᴇᴅ!\n▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔\n➪ Pᴀɪᴅ     ：   520 LKR\n\n➪ Cʀᴇᴅɪᴛᴇᴅ  ： 520 LKR";

const REAL_SUCCESS_BOX =
  "Weekly 💎 TopUp Done💎✅\n\n┌──────────────────────────┐\n│ Order ID : ##2711\n│ User     : Black\"\",ZORO\n";

const REAL_FAILURE_BALANCE = "❌ Insufficient LKR balance.";

const REAL_FAILURE_PLAYER = "❌ Pʟᴀʏᴇʀ ɴᴏᴛ ꜰᴏᴜᴅ";

check(
  "the supplier's styled payment confirmation reads as success",
  parser.parse(REAL_SUCCESS_STYLED).status === "success",
  parser.parse(REAL_SUCCESS_STYLED).status
);

check(
  "the supplier's boxed confirmation reads as success",
  parser.parse(REAL_SUCCESS_BOX).status === "success",
  parser.parse(REAL_SUCCESS_BOX).status
);

check(
  "the supplier's balance error reads as a failure",
  parser.parse(REAL_FAILURE_BALANCE).status === "failed",
  parser.parse(REAL_FAILURE_BALANCE).status
);

check(
  "the supplier's styled player error reads as a failure",
  parser.parse(REAL_FAILURE_PLAYER).status === "failed",
  parser.parse(REAL_FAILURE_PLAYER).status
);

check(
  "a styled reply keeps the original text for the log",
  parser.parse(REAL_SUCCESS_STYLED).raw === REAL_SUCCESS_STYLED
);

check(
  "folding a styled payment confirmation yields plain words",
  (() => {
    // "insufficient" spelled correctly in small caps still folds to itself,
    // which is what the success pattern relies on.
    const styled = "Cʀᴇᴅɪᴛᴇᴅ";
    const folded = parser.parse(styled).status;

    return folded === "success";
  })()
);

console.log("\n== reply parsing ==");

check(
  "a clear success is success",
  parser.parse("✅ Top-up successful").status === "success",
  parser.parse("✅ Top-up successful").status
);

check(
  "an unknown player is failed/invalid_player",
  (() => {
    const r = parser.parse("❌ Player not found");
    return (
      r.status === "failed" &&
      r.statusDetail === "invalid_player"
    );
  })()
);

check(
  "low balance is not merely 'failed'",
  parser.parse("Insufficient balance").statusDetail ===
    "insufficient_balance"
);

check(
  "'try again' is treated as uncertain, not terminal",
  parser.parse("Server busy, please try again later").status ===
    "processing",
  parser.parse("Server busy, please try again later").status
);

for (const text of [
  "bruh",
  "",
  null,
  "Welcome! Send /id <playerid> <product> to order",
  "ok",
  "...",
]) {
  check(
    "unrecognised reply stays unknown: " +
      JSON.stringify(text),
    parser.parse(text).status === "unknown",
    parser.parse(text).status
  );
}

check(
  "a transaction id is captured",
  parser.parse("✅ Done\nTransaction ID: TXN-99213")
    .transactionId === "TXN-99213"
);

console.log("\n== test mode never claims delivery ==");

(async () => {
  const testAdapter = new SupplierAdapter({
    productionMode: false,
    productMapping: { weekly: "WEEKLY" },
  });

  await testAdapter.initialize();

  const result = await testAdapter.sendTopup({
    id: "ORD-1",
    playerId: "11927288867",
    productKey: "weekly",
  });

  check(
    "test mode reports no success",
    result.success === false,
    JSON.stringify(result)
  );
  check(
    "test mode invents no transaction id",
    result.transactionId === null
  );

  console.log("\n== replies stay with their own order ==");

  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];

  const liveAdapter = new SupplierAdapter({
    productionMode: true,
    productMapping: { weekly: "WEEKLY" },
  });

  liveAdapter.isInitialized = true;
  liveAdapter.testMode = false;

  liveAdapter.client = {
    isReady: () => true,
    getSupplierBotUsername: () => "@tikka_auto_top_up_bot",
    async connect() {},
    async sendAndWait(command) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      seen.push(command);
      return {
        text: "✅ " + command + " done. Transaction ID: T1",
        requestMessageId: seen.length,
        messageId: 100 + seen.length,
      };
    },
  };

  const [r1, r2] = await Promise.all([
    liveAdapter.sendTopup({
      id: "ORD-2",
      playerId: "11927288867",
      productKey: "weekly",
    }),
    liveAdapter.sendTopup({
      id: "ORD-3",
      playerId: "8595647532",
      productKey: "weekly",
    }),
  ]);

  check(
    "never more than one supplier request at a time",
    maxInFlight === 1,
    String(maxInFlight)
  );

  check("both requests were sent", seen.length === 2);
  check(
    "each reply stays with its own order",
    r1.orderId === "ORD-2" && r2.orderId === "ORD-3",
    r1.orderId + "/" + r2.orderId
  );
  check("a confirmed reply is success", r1.success === true);
  check(
    "a timeout is unknown, never success",
    await (async () => {
      const timingOut = new SupplierAdapter({
        productionMode: true,
        productMapping: { weekly: "WEEKLY" },
      });

      timingOut.isInitialized = true;
      timingOut.testMode = false;
      timingOut.client = {
        isReady: () => true,
        getSupplierBotUsername: () => "@x",
        async connect() {},
        async sendAndWait() {
          throw new Error("Supplier did not reply");
        },
      };

      const timed = await timingOut.sendTopup({
        id: "ORD-4",
        playerId: "1",
        productKey: "weekly",
      });

      return (
        timed.success === false && timed.status === "unknown"
      );
    })()
  );
  check(
    "an unrecognised reply is not success",
    await (async () => {
      const confusing = new SupplierAdapter({
        productionMode: true,
        productMapping: { weekly: "WEEKLY" },
      });

      confusing.isInitialized = true;
      confusing.testMode = false;
      confusing.client = {
        isReady: () => true,
        getSupplierBotUsername: () => "@x",
        async connect() {},
        async sendAndWait() {
          return {
            text: "hmm let me check that",
            requestMessageId: 1,
            messageId: 2,
          };
        },
      };

      const odd = await confusing.sendTopup({
        id: "ORD-5",
        playerId: "1",
        productKey: "weekly",
      });

      return (
        odd.success === false && odd.status === "unknown"
      );
    })()
  );

  check(
    "the status lookup refuses to guess",
    (await liveAdapter.checkTopupStatus()).status === "unknown"
  );
  check(
    "cancel is not pretended to work",
    (await liveAdapter.cancelTopup()).success === false
  );

  console.log(
    "\n" +
      (fail === 0
        ? "ALL SUPPLIER CHECKS PASSED"
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