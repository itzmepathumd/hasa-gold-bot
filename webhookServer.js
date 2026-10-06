/*
|--------------------------------------------------------------------------
| WEBHOOK SERVER
|--------------------------------------------------------------------------
| The bot has always run on long polling, which means it needs a machine that
| stays awake and a Telegram client that keeps calling home. PaaS hosts are
| built the other way round: the process sleeps when idle and the platform
| terminates anything that idles, so polling stops working the moment the
| service spins down. Webhooks invert it, Telegram pushes updates to us and
| the process only wakes when there is something to do.
|
| The webhook path is opt-in. With no WEBHOOK_URL configured the bot keeps
| polling exactly as before, which is what running it locally and what the
| tests depend on. Nothing about existing setups changes.
|
| Two details decide whether this is safe:
|
|   The secret token. Anyone who learns the webhook URL could otherwise post
|   fake updates, which means forging an admin approving their own order. Every
|   request is checked against WEBHOOK_SECRET before it is parsed, and an
|   unverified request is refused with 403 rather than being quietly dropped.
|
|   A fast answer. Telegram retries anything it does not get a 200 for, so the
|   update is acknowledged immediately and handled afterwards. Holding the
|   response open for a slow provider call would make Telegram deliver the
|   same update several times.
*/

const http = require("http");
const { URL } = require("url");

const MAX_BODY_BYTES = 1024 * 1024;

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

/**
 * True when the environment asks for webhooks. WEBHOOK_URL is the whole
 * switch: a host that hands out a public HTTPS URL sets it and nothing else.
 */
function shouldUseWebhook(env = process.env) {
  return Boolean(env.WEBHOOK_URL && String(env.WEBHOOK_URL).trim());
}

/**
 * Where Telegram should deliver updates. The platform's own URL is used as the
 * base, and the path is kept because some hosts route on it.
 */
function webhookUrl(env = process.env) {
  return String(env.WEBHOOK_URL).trim();
}

/**
 * The port to listen on. PaaS platforms set PORT themselves, so this honours
 * it and only falls back to a sensible default.
 */
function port(env = process.env) {
  const fromEnv = Number(env.PORT || env.WEBHOOK_PORT);

  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) {
    return fromEnv;
  }

  return 8080;
}

/**
 * The shared secret Telegram echoes back in a header on every request.
 *
 * A missing secret is not fatal: the bot still runs. It is worth a loud
 * warning because it is the difference between a private webhook and a public
 * one that anyone can post to.
 */
function secret(env = process.env) {
  return String(env.WEBHOOK_SECRET || "").trim();
}

/*
|--------------------------------------------------------------------------
| REQUEST HANDLING
|--------------------------------------------------------------------------
*/

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;

      // Telegram updates are small. A larger body is not an update, and
      // buffering it would be a free way to exhaust memory.
      if (size > MAX_BODY_BYTES) {
        reject(new Error("update too large"));
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Constant-time-ish comparison, so a wrong secret cannot be discovered by
 * timing the difference between a near miss and a shorter guess.
 */
function secretsMatch(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

/**
 * Build the request handler. Exported so it can be driven by a test with a
 * real socket rather than a mocked one.
 */
function createHandler(bot, options = {}) {
  const expected = options.secret ?? secret();

  return async function handle(req, res) {
    const url = new URL(req.url || "/", "http://placeholder");

    // The platform needs something to poll for health, and it is also how a
    // human checks the service is alive without Telegram.
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          webhook: true,
          authenticated: Boolean(expected),
        })
      );

      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, GET" });
      res.end();

      return;
    }

    const presented = req.headers["x-telegram-bot-api-secret-token"];

    if (!secretsMatch(String(presented || ""), expected)) {
      // Refused loudly and counted, because a burst of these is either a
      // misconfiguration or someone probing the endpoint.
      console.warn(
        `[WEBHOOK] Refused an update with ${
          presented ? "a wrong" : "no"
        } secret token`
      );

      res.writeHead(403);
      res.end();

      return;
    }

    let update;

    try {
      update = JSON.parse(await readBody(req));
    } catch (error) {
      res.writeHead(400);
      res.end();

      return;
    }

    // Answer first. Telegram redelivers on a slow response, and handling a
    // provider top-up can take a minute.
    res.writeHead(200);
    res.end();

    try {
      await bot.handleUpdate(update);
    } catch (error) {
      // Already acknowledged, so there is nothing to tell Telegram. Log it and
      // let the update go: dropping it is what produces silently lost orders.
      console.error("[WEBHOOK] Update handling failed:", error.message);
    }
  };
}

/*
|--------------------------------------------------------------------------
| LIFECYCLE
|--------------------------------------------------------------------------
*/

/**
 * Start listening. Resolves once the port is actually bound, so a caller can
 * treat a successful await as "the bot is reachable".
 */
async function listen(bot, options = {}) {
  const env = options.env || process.env;
  const listenPort = options.port ?? port(env);

  const server = http.createServer(
    createHandler(bot, { secret: options.secret ?? secret(env) })
  );

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`[WEBHOOK] Listening for Telegram updates on port ${listenPort}`);

  return server;
}

/**
 * Stop listening without killing the process, so shutdown can finish the
 * provider and database work first.
 */
async function close(server) {
  if (!server) {
    return;
  }

  await new Promise((resolve) => server.close(resolve));
}

/**
 * Tell Telegram where to send updates. Called on every start, because a
 * deployment gets a new URL each time and a stale webhook silently stops
 * delivery with no error anywhere.
 */
async function register(bot, url = webhookUrl(), options = {}) {
  const secretToken = options.secret ?? secret();

  const result = await bot.telegram.setWebhook(url, {
    // Telegram accepts up to 256 characters of allowed characters.
    ...(secretToken ? { secret_token: secretToken } : {}),
    drop_pending_updates: false,
  });

  if (result === false) {
    throw new Error("Telegram refused to accept the webhook URL");
  }

  console.log(`[WEBHOOK] Telegram will deliver updates to ${url}`);

  return result;
}

/**
 * Clear the webhook. Without this, restarting on a new host leaves updates
 * going to the old URL, and Telegram keeps retrying it for a day.
 */
async function unregister(bot) {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  } catch (error) {
    // Shutdown must not fail over this.
    console.warn("[WEBHOOK] Could not clear the webhook:", error.message);
  }
}

module.exports = {
  shouldUseWebhook,
  webhookUrl,
  port,
  secret,
  secretsMatch,
  readBody,
  createHandler,
  listen,
  close,
  register,
  unregister,
  MAX_BODY_BYTES,
};