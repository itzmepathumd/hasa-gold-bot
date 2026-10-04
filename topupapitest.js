const assert = require("assert");

/*
|--------------------------------------------------------------------------
| TOP-UP API TEST
|--------------------------------------------------------------------------
| The order API charges the wallet the moment an order is created, so every
| check here is about money:
|
|   1. The idempotency key belongs to the order and is never invented at the
|      moment of charging. A retry must reuse it, so the provider returns the
|      order it already has instead of buying a second one.
|   2. "pending" is a charge, not a delivery. Only a completed status may be
|      reported as delivered.
|   3. An order is never placed without the fields the provider asks for.
|   4. A lost answer is retried with the identical request, never with a new
|      order id.
|
| No request leaves the machine: the transport is replaced.
*/

const {
  Shop2TopupClient,
} = require("./src/shop2topup/shop2topupClient");
const {
  Shop2TopupAdapter,
} = require("./src/shop2topup/shop2topupAdapter");
const {
  interpretCreateResponse,
  interpretLookupResponse,
  parseOrder,
} = require("./src/shop2topup/orderStatus");

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

async function checkAsync(label, fn) {
  try {
    const condition = await fn();
    check(label, Boolean(condition), "returned false");
  } catch (error) {
    check(label, false, error.message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
|--------------------------------------------------------------------------
| READING THE ANSWER
|--------------------------------------------------------------------------
*/
console.log("\n== provider status words ==");

const STATUS_CASES = [
  ["completed", "success"],
  ["success", "success"],
  ["fulfilled", "success"],
  ["delivered", "success"],
  ["pending", "processing"],
  ["processing", "processing"],
  ["queued", "processing"],
  ["paid", "processing"],
  ["failed", "failed"],
  ["rejected", "failed"],
  ["cancelled", "failed"],
  ["expired", "failed"],
  ["in-progress", "processing"],
  ["something_new", "unknown"],
  ["", "unknown"],
];

for (const [word, expected] of STATUS_CASES) {
  check(
    `"${word}" reads as ${expected}`,
    parseOrder({ status: word }).status === expected,
    parseOrder({ status: word }).status
  );
}

check(
  "a charge is not a delivery",
  parseOrder({ status: "pending" }).success !== true &&
    parseOrder({ status: "paid" }).status !== "success"
);

check(
  "no status at all is unknown",
  parseOrder({}).status === "unknown" &&
    parseOrder({}).statusDetail === "no_status_in_response"
);

check(
  "the provider's reference is captured",
  parseOrder({ status: "completed", transaction_id: "TX-9" })
    .transactionId === "TX-9",
  JSON.stringify(parseOrder({ status: "completed" }))
);

console.log("\n== create-order answers ==");

const completedResponse = {
  statusCode: 200,
  data: {
    success: true,
    order: {
      order_id: "01912345-6789-7abc-8def-0123456789ab",
      status: "pending",
      player_id: "123456789",
      player_name: "ProGamer99",
      subcategory_name: "FF 100 Diamonds",
      quantity: 1,
      charged_amount: "0.950000",
      currency: "USD",
      created_at: "2024-06-15T12:00:00Z",
    },
  },
};

const documented = interpretCreateResponse(completedResponse, {
  orderId: "01912345-6789-7abc-8def-0123456789ab",
});

check(
  "the documented response is accepted",
  documented.status === "processing" && documented.success === false,
  JSON.stringify(documented)
);
check(
  "the charged amount is kept",
  documented.chargedAmount === "0.950000" &&
    documented.currency === "USD",
  JSON.stringify(documented)
);
check(
  "our own order id is the authority",
  documented.orderId === "01912345-6789-7abc-8def-0123456789ab"
);

check(
  "an empty balance is a terminal failure",
  (() => {
    const r = interpretCreateResponse(
      {
        statusCode: 200,
        data: {
          success: false,
          error: { code: "INSUFFICIENT_BALANCE", message: "no funds" },
        },
      },
      { orderId: "x" }
    );

    return r.status === "failed" && r.statusDetail === "insufficient_balance";
  })()
);

check(
  "a rejected parameter is terminal",
  interpretCreateResponse(
    {
      statusCode: 400,
      data: { success: false, error: { code: "INVALID_PARAMETER" } },
    },
    { orderId: "x" }
  ).statusDetail === "invalid_parameter"
);

check(
  "a missing field is named",
  interpretCreateResponse(
    {
      statusCode: 400,
      data: {
        success: false,
        error: { code: "MISSING_REQUIRED_FIELD", message: "server" },
      },
    },
    { orderId: "x" }
  ).statusDetail === "missing_requirement"
);

check(
  "a rate limit is not a failure",
  interpretCreateResponse(
    { statusCode: 429, data: { success: false } },
    { orderId: "x" }
  ).status === "unknown" &&
    interpretCreateResponse(
      { statusCode: 429, data: { success: false } },
      { orderId: "x" }
    ).statusDetail === "rate_limited"
);

check(
  "an outage is not a failure",
  interpretCreateResponse(
    { statusCode: 503, data: {} },
    { orderId: "x" }
  ).statusDetail === "provider_unavailable"
);

check(
  "no response at all stays unknown",
  interpretCreateResponse(null, { orderId: "x" }).status === "unknown"
);

console.log("\n== status lookups ==");

check(
  "a completed lookup is a delivery",
  interpretLookupResponse(
    {
      statusCode: 200,
      data: { success: true, order: { status: "completed" } },
    },
    "uuid-1"
  ).status === "success"
);

check(
  "a running lookup is still running",
  interpretLookupResponse(
    {
      statusCode: 200,
      data: { success: true, order: { status: "pending" } },
    },
    "uuid-1"
  ).status === "processing"
);

check(
  "an unknown order id is unknown, not failed",
  interpretLookupResponse(
    { statusCode: 404, data: { success: false } },
    "uuid-1"
  ).status === "unknown"
);

/*
|--------------------------------------------------------------------------
| THE CLIENT
|--------------------------------------------------------------------------
*/
console.log("\n== the request that is sent ==");

function fakeClient(responses, config = {}) {
  const sent = [];

  const client = new Shop2TopupClient({
    apiKey: "key-id.key-secret",
    sleep: async () => {},
    retryDelayMs: 0,
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body });

      const next = responses.shift();

      if (typeof next === "function") {
        return next({ method, path, body: options.body, count: sent.length });
      }

      if (next instanceof Error) {
        throw next;
      }

      return next;
    },
    ...config,
  });

  return { client, sent };
}

(async () => {
  const ok = {
    statusCode: 200,
    data: { success: true, order: { status: "completed" } },
  };

  const { client, sent } = fakeClient([ok]);

  await client.createOrder({
    orderId: "01912345-6789-7abc-8def-0123456789ab",
    subCategoryId: 110,
    quantity: 1,
    requirements: { player_id: "8595647532" },
  });

  check(
    "the documented path is used",
    sent[0].path === "/api/endpoints/v1/orders/create",
    sent[0].path
  );
  check(
    "the body matches the documented shape",
    JSON.stringify(Object.keys(sent[0].body).sort()) ===
      JSON.stringify(
        ["order_id", "quantity", "requirements", "sub_category_id"].sort()
      ),
    JSON.stringify(Object.keys(sent[0].body))
  );
  check(
    "the order id is passed through untouched",
    sent[0].body.order_id === "01912345-6789-7abc-8def-0123456789ab"
  );
  check(
    "the sub-category id is a number",
    sent[0].body.sub_category_id === 110 &&
      typeof sent[0].body.sub_category_id === "number"
  );
  check(
    "price protection is not invented",
    !("expected_unit_price" in sent[0].body),
    JSON.stringify(sent[0].body)
  );

  const priced = fakeClient([ok]);

  await priced.client.createOrder({
    orderId: "uuid-priced",
    subCategoryId: 110,
    requirements: { player_id: "1" },
    expectedUnitPrice: 0.95,
  });

  check(
    "a configured price cap is sent",
    priced.sent[0].body.expected_unit_price === "0.95",
    JSON.stringify(priced.sent[0].body)
  );

  await checkAsync("an order without an id is refused", async () => {
    const blind = fakeClient([ok]);

    await assert.rejects(() =>
      blind.client.createOrder({ subCategoryId: 110 })
    );

    return blind.sent.length === 0;
  });

  await checkAsync("an order without a product is refused", async () => {
    const bad = fakeClient([ok]);
    await assert.rejects(() =>
      bad.client.createOrder({ orderId: "uuid-x", subCategoryId: 0 })
    );
    return bad.sent.length === 0;
  });

  console.log("\n== a lost answer is repeated, never re-issued ==");

  const retried = fakeClient([
    { statusCode: 429, data: { success: false } },
    ok,
  ]);

  const retriedResult = await retried.client.createOrder({
    orderId: "uuid-retry",
    subCategoryId: 110,
    requirements: { player_id: "1" },
  });

  check(
    "the request was repeated",
    retried.sent.length === 2,
    String(retried.sent.length)
  );
  check(
    "both attempts carried the same order id",
    retried.sent[0].body.order_id === retried.sent[1].body.order_id &&
      retried.sent[0].body.order_id === "uuid-retry"
  );
  check("the second answer was used", retriedResult.statusCode === 200);

  const dropped = fakeClient([
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    ok,
  ]);

  await dropped.client.createOrder({
    orderId: "uuid-dropped",
    subCategoryId: 110,
    requirements: { player_id: "1" },
  });

  check(
    "a dropped connection is repeated",
    dropped.sent.length === 3,
    String(dropped.sent.length)
  );
  check(
    "every repeat used the same order id",
    new Set(dropped.sent.map((s) => s.body.order_id)).size === 1
  );

  const dead = fakeClient([
    new Error("no route to host"),
    new Error("no route to host"),
    new Error("no route to host"),
  ]);

  await checkAsync("a dead provider is reported, not swallowed", async () => {
    await assert.rejects(
      () =>
        dead.client.createOrder({
          orderId: "uuid-dead",
          subCategoryId: 110,
          requirements: { player_id: "1" },
        }),
      /did not answer/
    );
    return true;
  });

  const lookup = fakeClient([ok]);

  await lookup.client.getOrder("uuid with space");

  check(
    "a lookup escapes the order id",
    lookup.sent[0].path ===
      "/api/endpoints/v1/orders/uuid%20with%20space" &&
      lookup.sent[0].method === "GET",
    lookup.sent[0].path
  );

  await checkAsync("a lookup refuses to invent an id", async () => {
    await assert.rejects(() => lookup.client.getOrder(""));
    return true;
  });

  console.log("\n== order ids ==");

  const idClient = new Shop2TopupClient({ apiKey: "k" });
  const first = idClient.newOrderId();
  const second = idClient.newOrderId();

  check("a new order id is a uuid", UUID.test(first), first);
  check("each order id is its own", first !== second);

  /*
  |--------------------------------------------------------------------------
  | THE ADAPTER
  |--------------------------------------------------------------------------
  */
  console.log("\n== what may be ordered ==");

  const catalog = {
    free_fire_weekly: { id: "weekly", name: "📅 Weekly", sub_category_id: 110, requirements: [] },
    blood_strike_gold: { id: "gold500", name: "💎 500 Gold", sub_category_id: 1641, requirements: [] },
    unmapped: { id: "mystery", name: "❓ Mystery", sub_category_id: null, requirements: [] },
    needs_server: {
      id: "asia",
      name: "🌏 Asia Weekly",
      sub_category_id: 120,
      requirements: [{ field_name: "server", value: "Asia" }],
    },
  };

  function adapter(config = {}) {
    return new Shop2TopupAdapter({
      productionMode: true,
      client: fakeClient([ok]).client,
      resolveProduct: (order) => catalog[order.productKey] || null,
      fetchRequirements: async () => [],
      ...config,
    });
  }

  const order = {
    id: "HG-TEST-1",
    playerId: "8595647532",
    playerRegion: "Asia",
    gameId: "free_fire",
    productKey: "free_fire_weekly",
  };

  // An order that fulfilment has claimed: the idempotency key is stored
  // before anything is charged, so this is the shape that reaches the API.
  const charged = {
    ...order,
    providerOrderId: "01912345-6789-7abc-8def-0123456789ab",
  };

  check(
    "a mapped package can be ordered",
    adapter().canFulfill(order)
  );
  check(
    "an unmapped package cannot",
    !adapter().canFulfill({
      ...order,
      productKey: "unmapped",
    })
  );
  check(
    "a missing player id cannot",
    !adapter().canFulfill({ ...order, playerId: "  " })
  );

  check(
    "the request carries the order's own product id",
    adapter().buildRequest(order).subCategoryId === 110
  );
  check(
    "a snapshot beats a later catalog edit",
    adapter().buildRequest({
      ...order,
      subCategoryId: 999,
    }).subCategoryId === 999
  );
  check(
    "the request carries the player id",
    adapter().buildRequest(order).requirements.player_id === "8595647532"
  );
  check(
    "the request reuses an order id that already exists",
    adapter().buildRequest({ ...order, providerOrderId: "uuid-existing" })
      .orderId === "uuid-existing"
  );
  check(
    "no key is invented for an order that has none",
    adapter().buildRequest(order).orderId === null,
    String(adapter().buildRequest(order).orderId)
  );
  check(
    "a configured field is sent",
    adapter().buildRequest({
      ...order,
      productKey: "needs_server",
    }).requirements.server === "Asia"
  );
  check(
    "a price cap is only sent when configured",
    adapter().buildRequest(order).expectedUnitPrice === null
  );

  checkAsync("an unmapped package is never ordered", async () => {
    const posted = fakeClient([ok]);
    const strict = adapter({ client: posted.client });

    const result = await strict.sendTopup({
      ...charged,
      productKey: "unmapped",
    });

    return (
      result.success === false &&
      result.statusDetail === "no_provider_product" &&
      posted.sent.length === 0
    );
  });

  checkAsync("an order with no stored id is never charged", async () => {
    const posted = fakeClient([ok]);
    const result = await adapter({ client: posted.client }).sendTopup(order);

    return (
      posted.sent.length === 0 &&
      result.success === false &&
      result.statusDetail === "no_provider_order_id"
    );
  });

  console.log("\n== test mode never claims delivery ==");

  const dryRun = new Shop2TopupAdapter({
    productionMode: false,
    client: fakeClient([ok]).client,
    resolveProduct: (o) => catalog[o.productKey] || null,
    fetchRequirements: async () => [],
  });

  await dryRun.initialize();

  const dryResult = await dryRun.sendTopup(charged);

  check(
    "nothing is ordered in test mode",
    dryResult.success === false &&
      dryResult.statusDetail === "test_mode_no_request_sent",
    JSON.stringify(dryResult)
  );
  check(
    "test mode mints no idempotency key",
    dryRun.newOrderId() === null
  );
  check("test mode is reported as such", dryRun.getStatus().testMode === true);

  console.log("\n== an order is only placed with every field ==");

  await checkAsync("a missing delivery field stops the order", async () => {
    const posted = fakeClient([ok]);
    const strict = adapter({
      client: posted.client,
      fetchRequirements: async () => [
        { field_name: "player_id" },
        { field_name: "server" },
      ],
    });

    const result = await strict.sendTopup({
      ...charged,
      playerRegion: null,
    });

    return (
      posted.sent.length === 0 &&
      result.status === "failed" &&
      result.statusDetail.startsWith("missing_requirement:server")
    );
  });

  await checkAsync("an optional field is not required", async () => {
    const posted = fakeClient([ok]);
    const lenient = adapter({
      client: posted.client,
      fetchRequirements: async () => [
        { field_name: "nickname", required: false },
      ],
    });

    await lenient.sendTopup(charged);

    return posted.sent.length === 1;
  });

  await checkAsync("a described default is used", async () => {
    const posted = fakeClient([ok]);
    const filled = adapter({
      client: posted.client,
      fetchRequirements: async () => [
        { field_name: "server", default_value: "Asia" },
      ],
    });

    await filled.sendTopup(charged);

    return posted.sent[0].body.requirements.server === "Asia";
  });

  console.log("\n== what the provider answers ==");

  const completedRun = fakeClient([
    {
      statusCode: 200,
      data: {
        success: true,
        order: {
          status: "completed",
          transaction_id: "TXN-77",
          charged_amount: "0.950000",
        },
      },
    },
  ]);

  const completed = await adapter({ client: completedRun.client }).sendTopup(
    charged
  );

  check(
    "a completed order is a delivery",
    completed.success === true && completed.status === "success",
    JSON.stringify(completed)
  );
  check(
    "the provider's reference is kept",
    completed.transactionId === "TXN-77"
  );
  check(
    "the order id is echoed back for the record",
    completed.orderId === completedRun.sent[0].body.order_id
  );

  const runningRun = fakeClient([
    {
      statusCode: 200,
      data: { success: true, order: { status: "pending" } },
    },
  ]);

  const running = await adapter({ client: runningRun.client }).sendTopup(charged);

  check(
    "a pending order is not a delivery",
    running.success === false && running.status === "processing",
    JSON.stringify(running)
  );

  const brokeRun = fakeClient([
    {
      statusCode: 200,
      data: { success: false, error: { code: "INSUFFICIENT_BALANCE" } },
    },
  ]);

  const broke = await adapter({ client: brokeRun.client }).sendTopup(charged);

  check(
    "an empty wallet is a terminal failure",
    broke.status === "failed" &&
      broke.statusDetail === "insufficient_balance",
    JSON.stringify(broke)
  );

  const lostRun = fakeClient([new Error("no route to host")]);

  const lost = await adapter({
    client: lostRun.client,
  }).sendTopup(charged);

  check(
    "a provider that never answers is unknown, not failed",
    lost.status === "unknown" &&
      lost.statusDetail === "provider_unreachable",
    JSON.stringify(lost)
  );
  check(
    "the order id survives an unknown answer",
    lost.orderId === lostRun.sent[0].body.order_id
  );

  console.log("\n== reading an order back ==");

  const settled = adapter();

  check(
    "nothing is looked up without an order id",
    (await settled.checkTopupStatus({ id: "HG-1" })).statusDetail ===
      "no_provider_order_id"
  );

  const readBack = fakeClient([
    {
      statusCode: 200,
      data: { success: true, order: { status: "completed" } },
    },
  ]);

  const readResult = await adapter({
    client: readBack.client,
  }).checkTopupStatus({
    id: "HG-2",
    providerOrderId: "uuid-read",
  });

  check(
    "a completed order reads as delivered",
    readResult.status === "success",
    JSON.stringify(readResult)
  );
  check(
    "the lookup used the order's own id",
    readBack.sent[0].path === "/api/endpoints/v1/orders/uuid-read",
    readBack.sent[0].path
  );

  const outage = adapter({
    client: fakeClient([new Error("no route to host")]).client,
  });

  check(
    "an unreachable provider is unknown",
    (await outage.checkTopupStatus({ providerOrderId: "uuid-x" })).status ===
      "unknown"
  );

  check(
    "cancel is not pretended to work",
    (await settled.cancelTopup()).success === false
  );

  console.log("\n== readiness ==");

  const ready = adapter();

  check(
    "production mode without a key is not ready",
    new Shop2TopupAdapter({
      productionMode: true,
      client: new Shop2TopupClient({ apiKey: null }),
    }).isReady() === false
  );

  await ready.initialize();

  check("an initialised adapter reports ready", ready.isReady() === true);
  check(
    "it names the provider",
    ready.getStatus().provider === "SHOP2TOPUP"
  );

  await checkAsync("an unconfigured provider refuses to start", async () => {
    const blind = new Shop2TopupAdapter({
      productionMode: true,
      client: new Shop2TopupClient({ apiKey: null }),
    });

    await assert.rejects(() => blind.initialize(), /API_KEY/);
    return true;
  });

  await checkAsync("shutdown leaves nothing ready", async () => {
    const live = adapter();
    await live.shutdown();
    return live.isReady() === false;
  });

  console.log(
    "\n" +
      (fail === 0
        ? "ALL TOP-UP API CHECKS PASSED"
        : fail + " CHECK(S) FAILED") +
      "  (" +
      pass +
      " passed, " +
      fail +
      " failed)"
  );

  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error("TEST CRASH:", error);
  process.exit(1);
});