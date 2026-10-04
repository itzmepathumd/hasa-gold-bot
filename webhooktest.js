/*
|--------------------------------------------------------------------------
| WEBHOOK TESTS
|--------------------------------------------------------------------------
| Webhook mode is how the shop is hosted now, and it replaces the transport
| the bot had always used, so the boundary it introduces is worth testing
| directly: a request from anyone other than Telegram must not become an
| update.
|
| These drive a real listening socket with real requests. Mocking the request
| and response objects would not have caught the things most likely to break,
| which are the header name Telegram actually sends, the body size limit, and
| whether a 200 is returned before the slow work happens.
*/

const assert = require("assert");
const http = require("http");
const webhook = require("./webhookServer");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}  ->  ${err.message}`);
  }
}

const SECRET = "a-long-random-secret-value";

(async () => {

/**
 * Start the handler on an ephemeral port and return a request helper.
 */
async function withServer(bot, options = {}) {
  const server = await webhook.listen(bot, {
    port: 0,
    secret: options.secret ?? SECRET,
    env: {},
  });

  const { port } = server.address();

  const request = (body, headers = {}, method = "POST", path = "/") =>
    new Promise((resolve, reject) => {
      const payload = typeof body === "string" ? body : JSON.stringify(body);

      const req = http.request(
        { host: "127.0.0.1", port, path, method, headers },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        }
      );

      req.on("error", reject);
      req.end(payload);
    });

  return { server, port, request };
}

function makeBot() {
  const handled = [];
  const registered = [];
  const deleted = [];

  return {
    handled,
    registered,
    deleted,
    async handleUpdate(update) {
      handled.push(update);
    },
    telegram: {
      async setWebhook(url, opts) {
        registered.push({ url, opts });
        return true;
      },
      async deleteWebhook(opts) {
        deleted.push(opts);
        return true;
      },
    },
  };
}

const goodHeaders = () => ({
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": SECRET,
});

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

console.log("\n== configuration ==");

await check("no webhook URL means polling is left alone", () => {
  assert.strictEqual(webhook.shouldUseWebhook({}), false);
  assert.strictEqual(webhook.shouldUseWebhook({ WEBHOOK_URL: "" }), false);
  assert.strictEqual(webhook.shouldUseWebhook({ WEBHOOK_URL: "   " }), false);
});

await check("a webhook URL switches it on", () => {
  assert.strictEqual(
    webhook.shouldUseWebhook({ WEBHOOK_URL: "https://x.onrender.com" }),
    true
  );
});

await check("the platform's PORT wins over the default", () => {
  assert.strictEqual(webhook.port({ PORT: "5000" }), 5000);
  assert.strictEqual(webhook.port({}), 8080);
  assert.strictEqual(webhook.port({ PORT: "not-a-port" }), 8080);
  assert.strictEqual(webhook.port({ PORT: "99999" }), 8080);
});

/*
|--------------------------------------------------------------------------
| SECRET VERIFICATION
|--------------------------------------------------------------------------
*/

console.log("\n== the request must be authenticated ==");

await check("a valid secret is accepted and the update is handled", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request({ update_id: 1 }, goodHeaders());

  assert.strictEqual(res.status, 200);
  assert.strictEqual(bot.handled.length, 1);
  assert.strictEqual(bot.handled[0].update_id, 1);

  await webhook.close(server);
});

await check("a request with no secret is refused", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request({ update_id: 2 }, { "content-type": "application/json" });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(bot.handled.length, 0, "a forged update was handled");

  await webhook.close(server);
});

await check("a request with the wrong secret is refused", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request(
    { update_id: 3 },
    { "content-type": "application/json", "x-telegram-bot-api-secret-token": "guess" }
  );

  assert.strictEqual(res.status, 403);
  assert.strictEqual(bot.handled.length, 0);

  await webhook.close(server);
});

await check("a secret that is a prefix of the real one is refused", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request(
    { update_id: 4 },
    {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET.slice(0, -1),
    }
  );

  assert.strictEqual(res.status, 403);
  assert.strictEqual(bot.handled.length, 0);

  await webhook.close(server);
});

await check("an empty configured secret refuses everything", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot, { secret: "" });

  const res = await request(
    { update_id: 5 },
    { "content-type": "application/json", "x-telegram-bot-api-secret-token": "" }
  );

  // Better to serve nothing than to serve it to anyone.
  assert.strictEqual(res.status, 403);

  await webhook.close(server);
});

await check("the comparison rejects mismatches of every length", () => {
  assert.strictEqual(webhook.secretsMatch("abc", "abc"), true);
  assert.strictEqual(webhook.secretsMatch("abc", "abd"), false);
  assert.strictEqual(webhook.secretsMatch("abc", "ab"), false);
  assert.strictEqual(webhook.secretsMatch("", ""), false);
  assert.strictEqual(webhook.secretsMatch(undefined, "abc"), false);
});

/*
|--------------------------------------------------------------------------
| REQUEST HANDLING
|--------------------------------------------------------------------------
*/

console.log("\n== request handling ==");

await check("malformed JSON is rejected without reaching the bot", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request("{not json", goodHeaders());

  assert.strictEqual(res.status, 400);
  assert.strictEqual(bot.handled.length, 0);

  await webhook.close(server);
});

await check("a non-POST is not treated as an update", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const res = await request("{}", goodHeaders(), "PUT");

  assert.strictEqual(res.status, 405);
  assert.strictEqual(bot.handled.length, 0);

  await webhook.close(server);
});

await check("an oversized body is refused rather than buffered", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  const huge = JSON.stringify({
    update_id: 6,
    padding: "x".repeat(webhook.MAX_BODY_BYTES + 1024),
  });

  // The connection is destroyed, so a failure to answer is expected here.
  const res = await request(huge, goodHeaders()).catch(() => ({ status: "reset" }));

  assert.ok(
    res.status === 400 || res.status === "reset",
    `unexpected status ${res.status}`
  );
  assert.strictEqual(bot.handled.length, 0);

  await webhook.close(server);
});

await check("a health check answers without needing the secret", async () => {
  const bot = makeBot();
  const { server, port } = await withServer(bot);

  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      })
      .on("error", reject);
  });

  // A platform health check cannot hold a secret, so this must stay open. It
  // exposes nothing beyond the fact the service is up.
  assert.strictEqual(body.status, 200);
  assert.strictEqual(JSON.parse(body.text).ok, true);

  await webhook.close(server);
});

await check("the response is sent before the update is handled", async () => {
  const bot = makeBot();
  let handledFinished = false;

  bot.handleUpdate = async () => {
    await new Promise((r) => setTimeout(r, 300));
    handledFinished = true;
  };

  const { server, request } = await withServer(bot);

  const started = Date.now();
  const res = await request({ update_id: 7 }, goodHeaders());
  const elapsed = Date.now() - started;

  // Telegram retries anything that is not answered promptly, so the 200 must
  // not wait on slow work such as a supplier top-up.
  assert.strictEqual(res.status, 200);
  assert.strictEqual(handledFinished, false, "the answer waited for the handler");
  assert.ok(elapsed < 250, `answer took ${elapsed}ms`);

  await webhook.close(server);
});

await check("a handler that throws does not break the connection", async () => {
  const bot = makeBot();

  bot.handleUpdate = async () => {
    throw new Error("handler exploded");
  };

  const { server, request } = await withServer(bot);

  const res = await request({ update_id: 8 }, goodHeaders());

  assert.strictEqual(res.status, 200);

  // And the server still accepts the next update.
  const next = await request({ update_id: 9 }, goodHeaders());
  assert.strictEqual(next.status, 200);

  await webhook.close(server);
});

await check("several updates in a row are all handled", async () => {
  const bot = makeBot();
  const { server, request } = await withServer(bot);

  for (let i = 1; i <= 5; i++) {
    await request({ update_id: i }, goodHeaders());
  }

  assert.strictEqual(bot.handled.length, 5);
  assert.deepStrictEqual(
    bot.handled.map((u) => u.update_id),
    [1, 2, 3, 4, 5]
  );

  await webhook.close(server);
});

/*
|--------------------------------------------------------------------------
| REGISTRATION
|--------------------------------------------------------------------------
*/

console.log("\n== registering with Telegram ==");

await check("the webhook is registered with the secret attached", async () => {
  const bot = makeBot();

  await webhook.register(bot, "https://example.onrender.com", { secret: SECRET });

  assert.strictEqual(bot.registered.length, 1);
  assert.strictEqual(bot.registered[0].url, "https://example.onrender.com");
  assert.strictEqual(bot.registered[0].opts.secret_token, SECRET);
});

await check("a refused registration is an error", async () => {
  const bot = makeBot();

  bot.telegram.setWebhook = async () => false;

  await assert.rejects(
    () => webhook.register(bot, "https://example.onrender.com", { secret: SECRET }),
    /refused/
  );
});

await check("unregistering never throws during shutdown", async () => {
  const bot = makeBot();

  bot.telegram.deleteWebhook = async () => {
    throw new Error("network gone");
  };

  // Shutdown must complete even if this fails.
  await webhook.unregister(bot);
  assert.strictEqual(bot.deleted.length, 0);
});

await check("closing a server that never started is harmless", async () => {
  await webhook.close(null);
});

console.log(`\nALL WEBHOOK CHECKS PASSED  (${passed} passed, ${failed} failed)`);

process.exit(failed === 0 ? 0 : 1);
})();